/**
 * owl 侧边栏工作台的文件系统层。
 *
 * 移植自 dsh-better-sidebar 的 fs-tree / fs-operations / fs-search（MIT，
 * https://github.com/omdsh-dev/DSH-better-sidebar），按 owl 桌面桥的约定改造：
 *
 * - 路径一律 workspace 相对（POSIX 分隔符过线），服务端在 `cwd` 下解析。
 * - **保留工作区围栏**：realpath 规范化后必须仍在 cwd 内（上游 v0.23.0 应
 *   用户要求删除了围栏；owl 是本地工具，围栏防的是误操作把项目外的文件
 *   改掉，不是防攻击者，所以留）。目标不存在时（写路径）对最深的已存在
 *   祖先做 realpath，符号链接穿越同样被拦。
 * - 单层列目带短 TTL 缓存与软链接探测；写操作全部失效缓存；rename/mkdir/
 *   remove 是链接感知的（对行本身的词法路径 lstat，不动链接目标）。
 *
 * 与上游一致的性能取舍：readdir 一次批量（不用 opendir 流）、只给上限内
 * 的行构 row、手写大小写不敏感排序（localeCompare 在 10k 行上贵 ~40x）。
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FsEntry, FsListing, FsReadBinResult, FsReadResult, FsSearchHit } from "./protocol.ts";

/** 侧边栏路由的结构化错误：code 过线给前端，用于区分提示文案。 */
export class SidebarError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SidebarError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// 路径解析与围栏
// ---------------------------------------------------------------------------

/** 把绝对路径转成过线的 workspace 相对 POSIX 路径。 */
export function toWirePath(cwd: string, absolute: string): string {
	return relative(cwd, absolute).split(sep).join("/");
}

/**
 * 解析 workspace 相对路径并围栏校验。
 *
 * 相对目标 join 到 cwd 下；`..` 先按词法 resolve 折叠，再用 realpath 对
 * （目标或其最深的已存在祖先 vs cwd）做规范比较——词法折叠拦不住符号链接
 * 指向 workspace 外的情况，realpath 拦得住。Windows 的 realpath 会统一大小
 * 写，天然覆盖大小写不敏感的比较。绝对路径与 `..` 逃逸一律拒绝（客户端从
 * 文件树拿到的都是相对路径，没有合法的绝对输入场景）。
 */
export async function resolveUnderWorkspace(cwd: string, target: string): Promise<string> {
	if (target === "" || target === ".") return cwd;
	if (isAbsolute(target) || /^[a-zA-Z]:/.test(target)) {
		throw new SidebarError("bad-request", `路径必须是 workspace 相对路径："${target}"`);
	}
	const segments = target.split(/[\\/]+/);
	if (segments.some((part) => part === "" || part === "." || part === "..")) {
		throw new SidebarError("bad-request", `路径不允许绝对、'.' 或 '..' 段："${target}"`);
	}
	const absolute = resolve(cwd, join(...segments));
	const realCwd = await realpath(cwd).catch(() => resolve(cwd));
	const realTarget = await realpath(absolute).catch(async () => {
		// 目标不存在（写路径）：对最深的已存在祖先做 realpath，其余段保持词法。
		let probe = absolute;
		const tail: string[] = [];
		for (;;) {
			const parent = dirname(probe);
			if (parent === probe) break;
			const real = await realpath(parent).catch(() => undefined);
			if (real !== undefined) {
				return join(real, ...tail);
			}
			tail.unshift(basename(probe));
			probe = parent;
		}
		return absolute;
	});
	if (realTarget !== realCwd && !realTarget.startsWith(realCwd + sep)) {
		throw new SidebarError("forbidden", `路径越出工作区："${target}"`);
	}
	return absolute;
}

// ---------------------------------------------------------------------------
// 目录列目（TTL 缓存 + 软链接探测）
// ---------------------------------------------------------------------------

/** 目录优先、大小写不敏感名称序（VSCode 资源管理器序），平局用原名定序。 */
export function compareEntries(a: FsEntry, b: FsEntry): number {
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	const la = a.name.toLowerCase();
	const lb = b.name.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	if (a.name === b.name) return 0;
	return a.name < b.name ? -1 : 1;
}

/** 缓存 TTL：吸收树视图重渲染造成的重复列目；所有写操作都会显式失效。 */
export const DIRECTORY_CACHE_TTL_MS = 1_500;

/** 单层最大行数：超过置 truncated，前端提示"目录过大"。 */
export const LIST_LIMIT = 2000;

const directoryCache = new Map<string, { at: number; listing: FsListing }>();
const DIRECTORY_CACHE_MAX = 512;

/** 失效一个目录（绝对或相对形式）的缓存层；不带参数清空全部。 */
export function invalidateDirectoryCache(path?: string): void {
	if (path === undefined) {
		directoryCache.clear();
		return;
	}
	const target = resolve(path);
	const prefix = `${target}\0`;
	for (const key of directoryCache.keys()) {
		if (key.startsWith(prefix)) directoryCache.delete(key);
	}
}

/** 列一层目录（带缓存）。path 是 workspace 相对；"" 或缺省 = cwd 根层。 */
export async function listWorkspaceDirectory(cwd: string, target = ""): Promise<FsListing> {
	const absolute = await resolveUnderWorkspace(cwd, target);
	const key = `${absolute}\0${LIST_LIMIT}`;
	const hit = directoryCache.get(key);
	const now = Date.now();
	if (hit !== undefined && now - hit.at < DIRECTORY_CACHE_TTL_MS) return hit.listing;
	const listing = await readDirectoryLevel(cwd, absolute);
	if (directoryCache.size >= DIRECTORY_CACHE_MAX) {
		const oldest = directoryCache.keys().next().value;
		if (oldest !== undefined) directoryCache.delete(oldest);
	}
	directoryCache.set(key, { at: now, listing });
	return listing;
}

async function readDirectoryLevel(cwd: string, absolute: string): Promise<FsListing> {
	let dirents;
	try {
		dirents = await readdir(absolute, { withFileTypes: true });
	} catch (error) {
		throw new SidebarError("fs-error", `无法列出目录：${messageOf(error)}`);
	}
	const truncated = dirents.length > LIST_LIMIT;
	const kept = truncated ? dirents.slice(0, LIST_LIMIT) : dirents;
	const prefix = absolute.endsWith(sep) ? absolute : `${absolute}${sep}`;
	const rows: FsEntry[] = new Array(kept.length);
	const linkProbes: { row: FsEntry; absolute: string }[] = [];
	for (let index = 0; index < kept.length; index += 1) {
		const dirent = kept[index]!;
		const absoluteRow = `${prefix}${dirent.name}`;
		rows[index] = {
			name: dirent.name,
			path: toWirePath(cwd, absoluteRow),
			isDir: dirent.isDirectory(),
			hidden: dirent.name.startsWith("."),
			isSymlink: dirent.isSymbolicLink(),
			broken: false,
		};
		if (rows[index]!.isSymlink) linkProbes.push({ row: rows[index]!, absolute: absoluteRow });
	}
	await probeSymlinkTargets(linkProbes);
	rows.sort(compareEntries);
	return { path: toWirePath(cwd, absolute), entries: rows, truncated };
}

/** 软链接目标探测（有界并发、保序）：目录链接可展开、死链接标红。 */
async function probeSymlinkTargets(probes: { row: FsEntry; absolute: string }[], concurrency = 32): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, probes.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= probes.length) return;
			const { row, absolute } = probes[index]!;
			const info = await stat(absolute).catch(() => undefined);
			row.isDir = info !== undefined ? info.isDirectory() : row.isDir;
			row.broken = info === undefined;
		}
	});
	await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// 读 / 写
// ---------------------------------------------------------------------------

/** 文本读取的大小上限（超限置 truncated，内容被截断）。 */
export const READ_LIMIT = 1_000_000;
/** 二进制嗅探返回的头部字节数。 */
const READ_HEAD_LIMIT = 4096;
/** 媒体预览（base64 整读）的大小上限。 */
export const MEDIA_LIMIT = 8_000_000;

const MEDIA_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".pdf": "application/pdf",
};

export function mediaTypeForPath(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot >= 0
		? (MEDIA_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream")
		: "application/octet-stream";
}

/** 读取一个文件：文本全文（限 READ_LIMIT）或二进制头嗅探。 */
export async function readWorkspaceFile(cwd: string, target: string): Promise<FsReadResult> {
	const absolute = await resolveUnderWorkspace(cwd, target);
	const info = await stat(absolute).catch((error: unknown) => {
		throw new SidebarError("fs-error", `无法读取 "${target}"：${messageOf(error)}`);
	});
	if (info.isDirectory()) throw new SidebarError("fs-error", `"${target}" 是目录`);
	const truncated = info.size > READ_LIMIT;
	const handle = await open(absolute, "r").catch((error: unknown) => {
		throw new SidebarError("fs-error", `无法读取 "${target}"：${messageOf(error)}`);
	});
	try {
		const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const slice = buffer.subarray(0, bytesRead);
		const binary = slice.includes(0);
		return {
			kind: binary ? "binary" : "text",
			content: binary ? "" : slice.toString("utf8"),
			truncated,
			size: info.size,
			...(binary ? { head: slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString("base64") } : {}),
		};
	} finally {
		await handle.close();
	}
}

/** 整文件 base64 读取（图片预览）；超 MEDIA_LIMIT 拒绝。 */
export async function readWorkspaceFileBinary(cwd: string, target: string): Promise<FsReadBinResult> {
	const absolute = await resolveUnderWorkspace(cwd, target);
	const info = await stat(absolute).catch((error: unknown) => {
		throw new SidebarError("fs-error", `无法读取 "${target}"：${messageOf(error)}`);
	});
	if (!info.isFile()) throw new SidebarError("fs-error", `"${target}" 不是常规文件`);
	if (info.size > MEDIA_LIMIT) {
		throw new SidebarError("too-large", `"${target}" 超过媒体预览上限（${Math.floor(MEDIA_LIMIT / 1_000_000)}MB）`);
	}
	const body = await readFile(absolute);
	return {
		base64: body.toString("base64"),
		size: info.size,
		truncated: false,
		mediaType: mediaTypeForPath(absolute),
	};
}

/** 原子写文本文件：临时兄弟文件 + rename，失败不落半个文件。 */
export async function writeWorkspaceFile(
	cwd: string,
	target: string,
	content: string,
): Promise<{ path: string; size: number }> {
	const absolute = await resolveUnderWorkspace(cwd, target);
	const tmp = `${absolute}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(tmp, content, "utf8");
		await rename(tmp, absolute);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw new SidebarError("fs-error", `无法写入 "${target}"：${messageOf(error)}`);
	}
	invalidateDirectoryCache(dirname(absolute));
	return { path: toWirePath(cwd, absolute), size: Buffer.byteLength(content, "utf8") };
}

// ---------------------------------------------------------------------------
// 行级变更（链接感知 + 根保护）
// ---------------------------------------------------------------------------

/** 单段名校验：rename/mkdir 永不跨目录。 */
function requireSegment(name: string): void {
	if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new SidebarError("bad-request", "name 必须是单段路径名");
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** 在已有目录行下建一个目录。 */
export async function mkdirWorkspaceEntry(cwd: string, parent: string, name: string): Promise<{ path: string }> {
	requireSegment(name);
	const absoluteParent = await resolveUnderWorkspace(cwd, parent);
	const destination = join(absoluteParent, name);
	if (await pathExists(destination)) {
		throw new SidebarError("already-exists", `"${name}" 已存在`);
	}
	try {
		await mkdir(destination);
	} catch (error) {
		throw new SidebarError("fs-error", `无法创建 "${name}"：${messageOf(error)}`);
	}
	invalidateDirectoryCache(absoluteParent);
	return { path: toWirePath(cwd, destination) };
}

/** 重命名一行（单段名；已存在的目标被拒绝；链接行重命名链接本身）。 */
export async function renameWorkspaceEntry(cwd: string, target: string, name: string): Promise<{ path: string }> {
	requireSegment(name);
	const absolute = await resolveUnderWorkspace(cwd, target);
	if (absolute === resolve(cwd)) {
		throw new SidebarError("fs-error", "不能重命名工作区根目录");
	}
	if (basename(absolute) === name) return { path: target };
	const destination = join(dirname(absolute), name);
	if (await pathExists(destination)) {
		throw new SidebarError("already-exists", `"${name}" 已存在`);
	}
	try {
		await rename(absolute, destination);
	} catch (error) {
		throw new SidebarError("fs-error", `无法重命名 "${target}" 为 "${name}"：${messageOf(error)}`);
	}
	invalidateDirectoryCache(dirname(absolute));
	return { path: toWirePath(cwd, destination) };
}

/** 删除一行（目录递归；链接行只 unlink 链接本身；根目录不可删）。 */
export async function removeWorkspaceEntry(cwd: string, target: string): Promise<{ path: string }> {
	const absolute = await resolveUnderWorkspace(cwd, target);
	if (absolute === resolve(cwd)) {
		throw new SidebarError("fs-error", "不能删除工作区根目录");
	}
	try {
		const info = await lstat(absolute);
		if (info.isDirectory()) await rm(absolute, { recursive: true });
		else if (info.isSymbolicLink()) await unlink(absolute);
		else await unlink(absolute);
	} catch (error) {
		throw new SidebarError("fs-error", `无法删除 "${target}"：${messageOf(error)}`);
	}
	invalidateDirectoryCache(dirname(absolute));
	return { path: target };
}

// ---------------------------------------------------------------------------
// 全局文件名搜索（有界 BFS）
// ---------------------------------------------------------------------------

/** 搜索预算：最多访问的目录数与返回的命中数（防巨型仓库拖死桥）。 */
const SEARCH_DIR_BUDGET = 2_000;
const SEARCH_HIT_LIMIT = 200;

/** 全局文件名搜索：大小写不敏感的子串匹配，跳过 node_modules/.git 等目录。 */
export async function searchWorkspaceFiles(cwd: string, query: string): Promise<FsSearchHit[]> {
	const needle = query.toLowerCase();
	if (needle === "") return [];
	const root = await realpath(cwd).catch(() => resolve(cwd));
	const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "target", "__pycache__"]);
	const hits: FsSearchHit[] = [];
	let visited = 0;
	const queue: string[] = [root];
	while (queue.length > 0 && hits.length < SEARCH_HIT_LIMIT && visited < SEARCH_DIR_BUDGET) {
		const dir = queue.shift()!;
		visited += 1;
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			if (hits.length >= SEARCH_HIT_LIMIT) break;
			const name = dirent.name;
			const isDir = dirent.isDirectory();
			if (!name.startsWith(".") && name.toLowerCase().includes(needle)) {
				hits.push({ path: toWirePath(cwd, join(dir, name)), isDir });
			}
			if (isDir && !SKIP.has(name) && !name.startsWith(".")) {
				queue.push(join(dir, name));
			}
		}
	}
	return hits;
}

/** 未知抛出值的可读消息。 */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
