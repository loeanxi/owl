/**
 * 成员登录 —— 移植自 manager `MemberAuthService`。
 * Cookie 名 loean_member，和 owl_pool_admin 完全分开；口令是同一套 PBKDF2。
 * 失败锁定写在自己的快照里，不和管理员锁定混在一起。
 */
import { BusinessError } from "owl-pool";
import type { MemberRecord, SqliteMemberStore } from "../store/member-store.ts";
import { constantTimeEquals, pbkdf2Base64, randomHex, sha256Hex } from "./crypto.ts";
import { LoginFailureTracker } from "./lockout.ts";
import { loadSnapshot, saveSnapshot } from "./snapshot-file.ts";

export const MEMBER_COOKIE = "loean_member";
const SESSION_TTL_HOURS = 12;
const MAX_LOGIN_FAILURES = 10;
const LOCKOUT_MINUTES = 10;
const DUMMY_SALT = "00000000000000000000000000000000";

export interface MemberSession {
	tokenHash: string;
	memberId: string;
	createdAt: number;
	expiresAt: number;
	clientIp: string;
}

export interface IssuedMemberSession {
	token: string;
	session: MemberSession;
	member: MemberRecord;
}

interface SessionSnapshotFile {
	sessions: Record<string, MemberSession>;
}

export interface MemberAuthOptions {
	members: SqliteMemberStore;
	sessionFile: string | null;
	failureFile: string | null;
	nowMs?(): number;
}

export class MemberAuthService {
	readonly #members: SqliteMemberStore;
	readonly #nowMs: () => number;
	readonly #sessions = new Map<string, MemberSession>();
	readonly #failures: LoginFailureTracker;
	readonly #sessionFile: string | null;

	constructor(options: MemberAuthOptions) {
		this.#members = options.members;
		this.#sessionFile = options.sessionFile;
		this.#nowMs = options.nowMs ?? (() => Date.now());
		this.#failures = new LoginFailureTracker({
			file: options.failureFile,
			maxFailures: MAX_LOGIN_FAILURES,
			lockoutMinutes: LOCKOUT_MINUTES,
			nowMs: this.#nowMs,
		});
		const snapshot = loadSnapshot<SessionSnapshotFile>(options.sessionFile);
		if (snapshot?.sessions !== undefined) {
			for (const session of Object.values(snapshot.sessions)) {
				if (session.expiresAt > this.#nowMs()) {
					this.#sessions.set(session.tokenHash, session);
				}
			}
		}
	}

	ttlSeconds(): number {
		return SESSION_TTL_HOURS * 3600;
	}

	login(usernameRaw: string, password: string, clientIp: string): IssuedMemberSession | null {
		const username = normalizeUsername(usernameRaw);
		const lockName = username ?? usernameRaw.trim().toLowerCase();
		if (this.#failures.isLocked(clientIp, lockName)) {
			return null;
		}
		const member = username === null ? undefined : this.#members.findByUsername(username);
		const salt = member?.passwordSalt ?? DUMMY_SALT;
		const derived = pbkdf2Base64(password, salt);
		const passOk = member !== undefined && constantTimeEquals(member.passwordHash, derived);
		if (member === undefined || !member.enabled || !passOk) {
			this.#failures.recordFailure(clientIp, lockName);
			return null;
		}
		this.#failures.clearFailures(clientIp, lockName);
		return this.#issue(member, clientIp);
	}

	authenticate(token: string | null | undefined): MemberSession | null {
		if (token === null || token === undefined || token.trim().length === 0) {
			return null;
		}
		const session = this.#sessions.get(sha256Hex(token.trim()));
		if (session === undefined || session.expiresAt <= this.#nowMs()) {
			if (session !== undefined) {
				this.#sessions.delete(session.tokenHash);
				this.#saveSessions();
			}
			return null;
		}
		return session;
	}

	/** 管理员改口令或停用成员后，该成员已发的 Cookie 立即失效。 */
	invalidateMember(memberId: string): void {
		let changed = false;
		for (const [hash, session] of this.#sessions) {
			if (session.memberId === memberId) {
				this.#sessions.delete(hash);
				changed = true;
			}
		}
		if (changed) {
			this.#saveSessions();
		}
	}

	setPassword(member: MemberRecord, password: string): MemberRecord {
		const problem = validateMemberPassword(password, member.username);
		if (problem !== null) {
			throw BusinessError.of("member.passwordInvalid", problem);
		}
		const salt = randomHex(16);
		const next: MemberRecord = {
			...member,
			passwordSalt: salt,
			passwordHash: pbkdf2Base64(password, salt),
			updatedAt: this.#nowMs(),
		};
		this.#members.save(next);
		return next;
	}

	logout(token: string | null | undefined): void {
		if (token === null || token === undefined || token.trim().length === 0) {
			return;
		}
		if (this.#sessions.delete(sha256Hex(token.trim()))) {
			this.#saveSessions();
		}
	}

	#issue(member: MemberRecord, clientIp: string): IssuedMemberSession {
		const token = randomHex(32);
		const now = this.#nowMs();
		const session: MemberSession = {
			tokenHash: sha256Hex(token),
			memberId: member.id,
			createdAt: now,
			expiresAt: now + this.ttlSeconds() * 1000,
			clientIp,
		};
		this.#sessions.set(session.tokenHash, session);
		this.#saveSessions();
		return { token, session, member };
	}

	#saveSessions(): void {
		const sessions: Record<string, MemberSession> = {};
		for (const [hash, session] of this.#sessions) {
			sessions[hash] = session;
		}
		saveSnapshot(this.#sessionFile, { sessions });
	}
}

const MIN_MEMBER_PASSWORD = 8;
const MAX_MEMBER_PASSWORD = 128;

/** 对齐 MemberAuthService.validatePassword。通过返回 null。 */
export function validateMemberPassword(password: string, username: string | null): string | null {
	if (password.length < MIN_MEMBER_PASSWORD) {
		return `口令至少 ${MIN_MEMBER_PASSWORD} 位`;
	}
	if (password.length > MAX_MEMBER_PASSWORD) {
		return `口令不能超过 ${MAX_MEMBER_PASSWORD} 位`;
	}
	if (username !== null && password.toLowerCase() === username.toLowerCase()) {
		return "口令不能与成员账号相同";
	}
	if (!/[a-zA-Z]/.test(password) || !/[^a-zA-Z]/.test(password)) {
		return "口令需同时包含字母与数字/符号";
	}
	return null;
}

/** 对齐 MemberService.normalizeUsername：小写，3–64 位字母数字 . - _。 */
export function normalizeUsername(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined) {
		return null;
	}
	const value = raw.trim().toLowerCase();
	if (value.length < 3 || value.length > 64) {
		return null;
	}
	if (!/^[a-z0-9._-]+$/.test(value)) {
		return null;
	}
	return value;
}
