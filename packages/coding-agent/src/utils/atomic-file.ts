/**
 * 状态文件的原子写、跨进程锁与损坏备份。
 *
 * - 直写（writeFileSync 覆盖）在进程中途退出时会留下半截文件。
 * - 固定名临时文件（`${path}.tmp`）在两个进程同时写时会互相截断：A rename 出去的
 *   可能正是 B 还没写完的内容。多个桥 / 会话共用同一个 agentDir 是常态。
 * - Windows 上目标文件被读取方或杀毒软件短暂打开时，rename 会报 EPERM/EBUSY。
 *
 * 所以统一成：唯一临时名 → 写入并 fsync → rename（被占用时短暂重试），失败不留临时文件。
 * 读-改-写的文件再套 withFileLockSync，避免两个进程各写各的、后写覆盖先写。
 *
 * rename 换掉的是整个文件：POSIX 权限位由这里从旧文件继承；Windows 上文件自身的显式 ACL
 * 不会保留（新文件继承所在目录的 ACL）。
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	type Dirent,
	existsSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";

export interface AtomicWriteOptions {
	encoding?: BufferEncoding;
	/** 新建文件的权限（凭据类传 0o600）；目标已存在时沿用它现有的权限位。 */
	mode?: number;
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 8;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

/** 同步阻塞等待（不占 CPU）；只用于锁与 rename 的短暂退避。 */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (!RENAME_RETRY_CODES.has(errorCode(error) ?? "") || attempt >= RENAME_ATTEMPTS) throw error;
			sleepSync(15 * attempt);
		}
	}
}

export function atomicWriteFileSync(
	path: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions | BufferEncoding = "utf-8",
): void {
	const { encoding = "utf-8", mode: createMode } = typeof options === "string" ? { encoding: options } : options;
	let mode = createMode;
	try {
		mode = statSync(path).mode & 0o7777;
	} catch {
		// 目标不存在：按新建权限
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const fd = openSync(temp, "wx", mode);
		try {
			if (mode !== undefined && process.platform !== "win32") fchmodSync(fd, mode);
			writeFileSync(fd, data, typeof data === "string" ? encoding : undefined);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameWithRetry(temp, path);
	} finally {
		if (existsSync(temp)) {
			try {
				unlinkSync(temp);
			} catch {
				// 清理失败只是多一个孤儿临时文件，不影响目标文件
			}
		}
	}
}

/**
 * 在跨进程锁内执行 fn（锁 = 旁路的 `${path}.lock` 目录，与 settings/auth 同一套 proper-lockfile）。
 * 持锁进程崩溃后，锁在 LOCK_STALE_MS 后视为过期可被抢占；等锁超时则抛错，不无锁硬写。
 */
export function withFileLockSync<T>(path: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	let release: (() => void) | undefined;
	for (let attempt = 0; !release; attempt++) {
		try {
			release = lockfile.lockSync(path, { realpath: false, stale: LOCK_STALE_MS });
		} catch (error) {
			if (errorCode(error) !== "ELOCKED" || Date.now() >= deadline) throw error;
			sleepSync(Math.min(10 * 2 ** attempt, 200));
		}
	}
	try {
		return fn();
	} finally {
		try {
			release();
		} catch {
			// 锁已被判过期抢走：本次写入已完成，释放失败无需处理
		}
	}
}

/**
 * 把读不出来的文件挪成 `*.corrupt` 留证（已有则顺延 `.corrupt.0`、`.corrupt.1`…），
 * 返回备份路径；挪不动时返回 undefined。启动时的 .corrupt 扫描会把它报给用户。
 */
export function backupCorruptFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	let target = `${path}.corrupt`;
	for (let generation = 0; existsSync(target) && generation < 20; generation++) {
		target = `${path}.corrupt.${generation}`;
	}
	try {
		renameWithRetry(path, target);
		return target;
	} catch {
		return undefined;
	}
}

export interface CorruptFileInfo {
	path: string;
	size: number;
	mtimeMs: number;
}

const CORRUPT_NAME = /\.corrupt(\.\d+)?$/;
/** 体量大且不会产生 .corrupt 的目录（会话历史、内容寻址 blob、包缓存）。 */
const CORRUPT_SCAN_SKIP = new Set(["node_modules", ".git", "Owl-history", "sessions", "blobs", "git", "npm"]);

/** 扫描目录下的 `*.corrupt*` 备份（默认深 3 层，跳过大目录）。 */
export async function findCorruptFiles(root: string, maxDepth = 3): Promise<CorruptFileInfo[]> {
	const found: CorruptFileInfo[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth && !CORRUPT_SCAN_SKIP.has(entry.name)) await walk(full, depth + 1);
			} else if (CORRUPT_NAME.test(basename(full))) {
				try {
					const info = await stat(full);
					found.push({ path: full, size: info.size, mtimeMs: info.mtimeMs });
				} catch {
					// 扫描途中被删：忽略
				}
			}
		}
	};
	await walk(root, 0);
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
