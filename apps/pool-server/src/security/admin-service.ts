/**
 * 管理员鉴权域 —— 移植自 manager `security/admin/AdminAuthService`。
 *
 * 口令：PBKDF2-HMAC-SHA256 加盐派生，凭据里只有 salt + 派生值（SQLite 单行表，
 * 与 manager 的 admin_credentials 列对齐，可直搬）。会话 token 只以 SHA-256
 * 保存（内存 + data/ 快照文件），重启不掉线，删快照即强制全员重新登录。
 * 登录失败按「客户端 IP」与「用户名（跨 IP 聚合，阈值 5 倍）」双维度锁定。
 *
 * 口令来源优先级（与 manager 一致）：
 * ① 配置 OWL_POOL_ADMIN_PASSWORD（部署/CI 场景，指纹 config: 前缀，变更即重建凭据）
 * ② 库中已有凭据（首次访问自行设置，指纹 user: 前缀）
 * ③ 都无：进入待初始化状态，由管理端引导首次设置
 */
import type { AdminCredentialRecord, AdminCredentialStore } from "../store/admin-credential-store.ts";
import { constantTimeEquals, pbkdf2Base64, randomHex, sha256Hex } from "./crypto.ts";
import { LoginFailureTracker } from "./lockout.ts";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./snapshot-file.ts";

export interface AdminSecurityConfig {
	/** 是否启用管理端登录鉴权；false 仅用于本机自救（只放行回环对端）。 */
	enabled: boolean;
	username: string;
	/** 配置态明文口令；留空则走首次设置。 */
	password: string;
	/** 首次向导远程授权令牌；至少 32 字符，凭据建立后立即失效。 */
	setupToken: string;
	/** 非空时允许以 X-Admin-Key 头调用管理接口（脚本/CI 用）。 */
	apiKey: string;
	/** 会话 Cookie 名。 */
	cookieName: string;
	sessionTtlHours: number;
	/** 对外部署置 true：只有 HTTPS（或声明 forwarded-proto https）才下发凭据 Cookie。 */
	requireHttps: boolean;
	maxLoginFailures: number;
	lockoutMinutes: number;
	/** 失败计数快照路径；null 不持久化。 */
	failureStoreFile: string | null;
	/** 会话快照路径；null 不持久化。 */
	sessionStoreFile: string | null;
}

export interface AdminSession {
	tokenHash: string;
	username: string;
	createdAt: number;
	expiresAt: number;
	clientIp: string;
}

export interface IssuedSession {
	token: string;
	session: AdminSession;
}

export interface AdminServiceOptions {
	config: AdminSecurityConfig;
	credentials: AdminCredentialStore;
	nowMs?(): number;
	logger?(line: string): void;
}

interface SessionSnapshotFile {
	sessions: Record<string, AdminSession>;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_USERNAME_LENGTH = 32;

export class AdminAuthService {
	readonly #config: AdminSecurityConfig;
	readonly #credentials: AdminCredentialStore;
	readonly #nowMs: () => number;
	readonly #log: (line: string) => void;
	readonly #sessions = new Map<string, AdminSession>();
	readonly #failures: LoginFailureTracker;

	constructor(options: AdminServiceOptions) {
		this.#config = options.config;
		this.#credentials = options.credentials;
		this.#nowMs = options.nowMs ?? (() => Date.now());
		this.#log = options.logger ?? ((line) => console.log(`[admin-auth] ${line}`));
		this.#failures = new LoginFailureTracker({
			file: options.config.failureStoreFile,
			maxFailures: options.config.maxLoginFailures,
			lockoutMinutes: options.config.lockoutMinutes,
			nowMs: this.#nowMs,
		});
		this.#restoreSessions();
		if (options.config.enabled) {
			this.syncCredential();
		}
	}

	/**
	 * 配置态口令：指纹（config: 前缀）变化即重建凭据并失效全部会话；
	 * 未配置口令时本方法不写入任何凭据。
	 */
	syncCredential(): void {
		const configured = this.#config.password;
		if (configured === undefined || configured.trim().length === 0) {
			return;
		}
		const username = this.safeUsername();
		const fingerprint = `config:${sha256Hex(`${username}\u0000${configured}`)}`;
		const existing = this.#credentials.get();
		if (existing !== undefined && existing.sourceFingerprint === fingerprint) {
			return;
		}
		this.#saveCredential(existing, username, configured, fingerprint);
		this.#log(`已按配置初始化/刷新管理员口令 user=${username}（旧会话已失效）`);
	}

	/** 是否需要「首次设置密码」：已启用、未配置口令、库中无凭据。 */
	isSetupRequired(): boolean {
		if (!this.#config.enabled) {
			return false;
		}
		if (this.#config.password !== undefined && this.#config.password.trim().length > 0) {
			return false;
		}
		return this.#credentials.get() === undefined;
	}

	/**
	 * 首次设置管理员用户名与口令。仅在 isSetupRequired 为真时可用——设置一旦完成，
	 * 此入口立即永久失效，不存在被后来者抢占的风险。
	 */
	setup(username: string, password: string, clientIp: string): IssuedSession | null {
		if (!this.isSetupRequired()) {
			this.#log(`拒绝首次设置：管理员凭据已存在 ip=${clientIp}`);
			return null;
		}
		const name = normalizeUsername(username);
		if (name === null || this.validatePassword(password, name) !== null) {
			return null;
		}
		// 二次检查：并发调用下只允许一个成功
		if (!this.isSetupRequired()) {
			return null;
		}
		this.#saveCredential(undefined, name, password, `user:${name}`);
		this.#log(`管理员口令已完成首次设置 user=${name} ip=${clientIp}`);
		return this.#issue(name, clientIp);
	}

	/** 校验用户名口令；成功返回新会话，失败返回 null（并计入锁定）。 */
	login(username: string, password: string, clientIp: string): IssuedSession | null {
		if (!this.#config.enabled || this.isLocked(clientIp, username)) {
			return null;
		}
		const credential = this.#credentials.get();
		if (credential === undefined) {
			return null;
		}
		const userOk = constantTimeEquals(credential.username, username);
		const passOk =
			password.length > 0 && constantTimeEquals(credential.passwordHash, pbkdf2Base64(password, credential.salt));
		if (!userOk || !passOk) {
			this.#failures.recordFailure(clientIp, username);
			this.#log(`管理端登录失败 user=${username} ip=${clientIp}`);
			return null;
		}
		this.#failures.clearFailures(clientIp, username);
		this.#log(`管理端登录成功 user=${credential.username} ip=${clientIp}`);
		return this.#issue(credential.username, clientIp);
	}

	/** 修改口令：旧会话全部失效并为当前调用方换发新会话（不把自己踢下线）。 */
	changePassword(currentPassword: string, newPassword: string, clientIp: string): IssuedSession | null {
		if (!this.#config.enabled || this.isLocked(clientIp, this.safeUsername())) {
			return null;
		}
		const credential = this.#credentials.get();
		if (credential === undefined) {
			return null;
		}
		const currentOk =
			currentPassword.length > 0 &&
			constantTimeEquals(credential.passwordHash, pbkdf2Base64(currentPassword, credential.salt));
		if (!currentOk) {
			this.#failures.recordFailure(clientIp, this.safeUsername());
			this.#log(`修改口令失败：当前口令不正确 ip=${clientIp}`);
			return null;
		}
		if (this.validatePassword(newPassword, credential.username) !== null) {
			this.#log("修改口令失败：新口令不符合强度要求");
			return null;
		}
		// 改成与配置口令相同的值时指纹仍归 user:，避免下次启动被配置覆盖
		this.#saveCredential(credential, credential.username, newPassword, `user:${credential.username}`);
		this.#log(`管理员口令已修改 user=${credential.username}（所有旧会话失效）`);
		return this.#issue(credential.username, clientIp);
	}

	/** 校验会话 token（Cookie 值）；无效/过期返回 null。 */
	authenticate(token: string | null | undefined): AdminSession | null {
		if (!this.#config.enabled || token === null || token === undefined || token.trim().length === 0) {
			return null;
		}
		const session = this.#sessions.get(sha256Hex(token.trim()));
		if (session === undefined) {
			return null;
		}
		if (this.#isExpired(session)) {
			this.#sessions.delete(session.tokenHash);
			return null;
		}
		return session;
	}

	logout(token: string | null | undefined): boolean {
		if (token === null || token === undefined || token.trim().length === 0) {
			return false;
		}
		const removed = this.#sessions.delete(sha256Hex(token.trim()));
		if (removed) {
			this.#saveSessions();
		}
		return removed;
	}

	isEnabled(): boolean {
		return this.#config.enabled;
	}

	username(): string {
		return this.#credentials.get()?.username ?? this.safeUsername();
	}

	/** X-Admin-Key 允许的账号名（脚本/CI 视角）。 */
	safeUsername(): string {
		const name = this.#config.username;
		return name === undefined || name.trim().length === 0 ? "admin" : name.trim();
	}

	ttlSeconds(): number {
		return Math.max(1, this.#config.sessionTtlHours) * 3600;
	}

	isLocked(clientIp: string | null, username: string | null): boolean {
		return this.#failures.isLocked(clientIp, username);
	}

	/** 校验新口令强度；返回 null 表示通过，否则返回原因。 */
	validatePassword(password: string, username: string): string | null {
		if (password === null || password.length < MIN_PASSWORD_LENGTH) {
			return `口令至少 ${MIN_PASSWORD_LENGTH} 位`;
		}
		if (password.length > MAX_PASSWORD_LENGTH) {
			return `口令不能超过 ${MAX_PASSWORD_LENGTH} 位`;
		}
		if (password.toLowerCase() === username.toLowerCase()) {
			return "口令不能与用户名相同";
		}
		const hasLetter = /[a-zA-Z]/.test(password);
		const hasOther = /[^a-zA-Z]/.test(password);
		if (!hasLetter || !hasOther) {
			return "口令需同时包含字母与数字/符号";
		}
		return null;
	}

	/** 首次向导令牌校验：至少 32 字符 + 常量时间比较；凭据存在后调用方不应再走到这里。 */
	isValidSetupToken(supplied: string | null | undefined): boolean {
		const configured = this.#config.setupToken;
		return (
			configured !== undefined &&
			configured.length >= 32 &&
			supplied !== null &&
			supplied !== undefined &&
			supplied.length > 0 &&
			constantTimeEquals(configured, supplied)
		);
	}

	#saveCredential(
		_existing: AdminCredentialRecord | undefined,
		username: string,
		plaintext: string,
		fingerprint: string,
	): void {
		const salt = randomHex(16);
		this.#credentials.save({
			id: "default",
			username,
			salt,
			passwordHash: pbkdf2Base64(plaintext, salt),
			sourceFingerprint: fingerprint,
			updatedAt: this.#nowMs(),
		});
		// 口令变更后旧会话一律失效（含磁盘快照）
		this.#sessions.clear();
		this.#saveSessions();
	}

	#issue(username: string, clientIp: string): IssuedSession {
		this.#pruneSessions();
		const token = randomHex(32);
		const now = this.#nowMs();
		const session: AdminSession = {
			tokenHash: sha256Hex(token),
			username,
			createdAt: now,
			expiresAt: now + Math.max(1, this.#config.sessionTtlHours) * 3_600_000,
			clientIp,
		};
		this.#sessions.set(session.tokenHash, session);
		this.#saveSessions();
		return { token, session };
	}

	#pruneSessions(): void {
		for (const [key, session] of this.#sessions) {
			if (this.#isExpired(session)) {
				this.#sessions.delete(key);
			}
		}
	}

	#isExpired(session: AdminSession): boolean {
		return session.expiresAt <= this.#nowMs();
	}

	#restoreSessions(): void {
		const snapshot = loadSnapshot<SessionSnapshotFile>(this.#config.sessionStoreFile);
		const restored = snapshot?.sessions;
		if (restored === undefined || restored === null) {
			return;
		}
		for (const session of Object.values(restored)) {
			if (session !== null && typeof session === "object" && !this.#isExpired(session)) {
				this.#sessions.set(session.tokenHash, session);
			}
		}
		if (this.#sessions.size > 0) {
			this.#log(`已恢复 ${this.#sessions.size} 个管理员会话`);
		}
	}

	#saveSessions(): void {
		saveSnapshot(this.#config.sessionStoreFile, { sessions: Object.fromEntries(this.#sessions) });
	}

	/** 删除会话快照（全员强制下线）。 */
	clearSessions(): void {
		this.#sessions.clear();
		clearSnapshot(this.#config.sessionStoreFile);
	}
}

/** 用户名归一：去空白；仅允许字母/数字/下划线/短横线/点，长度 1..32。非法返回 null。 */
function normalizeUsername(raw: string): string | null {
	const name = raw.trim();
	if (name.length === 0 || name.length > MAX_USERNAME_LENGTH) {
		return null;
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
		return null;
	}
	return name;
}
