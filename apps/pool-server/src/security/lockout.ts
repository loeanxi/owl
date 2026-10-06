/**
 * 登录失败锁定 —— 移植自 manager `security/LoginFailureStore` + AdminAuthService
 * 里的双维度计数逻辑。
 *
 * 快照让爆破进度跨重启累计：攻击者诱发一次重启不能再清零计数。
 * 文件里只有来源 IP / 用户名键与计数，不含任何口令材料；
 * 快照失败只记日志，绝不影响登录主流程。
 */
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./snapshot-file.ts";

export interface FailureWindow {
	count: number;
	since: number;
}

interface SnapshotEntry {
	key: string;
	count: number;
	since: number;
}

interface SnapshotFile {
	version: number;
	savedAt: string;
	entries: SnapshotEntry[];
}

/** 失败计数键的防洪泛上限（对齐 Java MAX_FAILURE_KEYS）。 */
const MAX_FAILURE_KEYS = 10_000;

export interface LoginFailureTrackerOptions {
	/** 快照路径；null = 纯内存（测试/显式关闭）。 */
	file: string | null;
	maxFailures: number;
	lockoutMinutes: number;
	nowMs?(): number;
}

export class LoginFailureTracker {
	readonly #file: string | null;
	readonly #maxFailures: number;
	readonly #lockoutMinutes: number;
	readonly #nowMs: () => number;
	readonly #failures = new Map<string, FailureWindow>();

	constructor(options: LoginFailureTrackerOptions) {
		this.#file = options.file;
		this.#maxFailures = Math.max(1, options.maxFailures);
		this.#lockoutMinutes = Math.max(1, options.lockoutMinutes);
		this.#nowMs = options.nowMs ?? (() => Date.now());
		// 重启后继续累计爆破锁定进度；快照缺失/损坏时静默从零开始
		this.#load();
	}

	get #threshold(): number {
		return this.#maxFailures;
	}

	/** 用户名维度跨 IP 聚合，阈值放大 5 倍：抬高轮换 IP 的分布式爆破成本。 */
	get #userThreshold(): number {
		return this.#maxFailures * 5;
	}

	isLocked(clientIp: string | null, username: string | null): boolean {
		return (
			this.#isLockedKey(failureKey(clientIp), this.#threshold) ||
			this.#isLockedKey(userKey(username), this.#userThreshold)
		);
	}

	/** 同一次失败同时计入 IP 维度与用户名维度，任一达到上限即锁定。 */
	recordFailure(clientIp: string | null, username: string | null): void {
		this.#guardFailureKeys();
		this.#bump(failureKey(clientIp));
		this.#bump(userKey(username));
		this.#save();
	}

	clearFailures(clientIp: string | null, username: string | null): void {
		this.#failures.delete(failureKey(clientIp));
		this.#failures.delete(userKey(username));
		this.#save();
	}

	/** 清空全部失败计数（含快照；测试复位用）。 */
	clear(): void {
		this.#failures.clear();
		clearSnapshot(this.#file);
	}

	failureCount(key: string): number {
		return this.#failures.get(key)?.count ?? 0;
	}

	#isLockedKey(mapKey: string, threshold: number): boolean {
		const window = this.#failures.get(mapKey);
		if (window === undefined) {
			return false;
		}
		if (this.#isExpired(window)) {
			this.#failures.delete(mapKey);
			return false;
		}
		return window.count >= threshold;
	}

	#bump(mapKey: string): void {
		const now = this.#nowMs();
		const prev = this.#failures.get(mapKey);
		if (prev === undefined || this.#isExpired(prev)) {
			this.#failures.set(mapKey, { count: 1, since: now });
			return;
		}
		this.#failures.set(mapKey, { count: prev.count + 1, since: prev.since });
	}

	#isExpired(window: FailureWindow): boolean {
		return window.since + this.#lockoutMinutes * 60_000 < this.#nowMs();
	}

	/**
	 * 失败计数 Map 防洪泛封顶：先清过期窗口；仍超限则按窗口起点从旧到新淘汰。
	 * 不能整体清零——那等于给攻击者一个「写满计数表即可重置爆破进度」的开关。
	 */
	#guardFailureKeys(): void {
		if (this.#failures.size < MAX_FAILURE_KEYS) {
			return;
		}
		for (const [key, window] of this.#failures) {
			if (this.#isExpired(window)) {
				this.#failures.delete(key);
			}
		}
		const overflow = this.#failures.size - MAX_FAILURE_KEYS + 1;
		if (overflow <= 0) {
			return;
		}
		const oldest = [...this.#failures.entries()].sort((a, b) => a[1].since - b[1].since).slice(0, overflow);
		for (const [key] of oldest) {
			this.#failures.delete(key);
		}
	}

	#load(): void {
		const snapshot = loadSnapshot<SnapshotFile>(this.#file);
		if (snapshot === null || !Array.isArray(snapshot.entries)) {
			return;
		}
		for (const entry of snapshot.entries.slice(0, MAX_FAILURE_KEYS)) {
			if (entry === null || typeof entry.key !== "string" || typeof entry.since !== "number") {
				continue;
			}
			const window: FailureWindow = { count: Math.max(1, Math.trunc(entry.count)), since: entry.since };
			if (!this.#isExpired(window)) {
				this.#failures.set(entry.key, window);
			}
		}
	}

	#save(): void {
		const entries: SnapshotEntry[] = [];
		for (const [key, window] of this.#failures) {
			entries.push({ key, count: window.count, since: window.since });
		}
		saveSnapshot(this.#file, { version: 1, savedAt: new Date(this.#nowMs()).toISOString(), entries });
	}
}

/** IP 维度键（空归 "unknown"）。 */
function failureKey(clientIp: string | null): string {
	return clientIp === null || clientIp.trim().length === 0 ? "unknown" : clientIp;
}

/** 用户名维度键：小写归并大小写变体并截断 64，避免超长输入撑大表。 */
function userKey(username: string | null): string {
	let name =
		username === null || username === undefined || username.trim().length === 0 ? "-" : username.trim().toLowerCase();
	if (name.length > 64) {
		name = name.slice(0, 64);
	}
	return `user|${name}`;
}
