/**
 * owl 侧边栏工作台的 Git 层：只调 CLI（argv 数组、无 shell 插值），绝不设置
 * 用户身份或改配置。移植自 dsh-better-sidebar 的 git.ts 的子集——owl 桌面
 * 端落 status / diff / stage / unstage / commit / discard / log 七个能力，
 * 外加子仓库聚合：workspace 根不是仓库时向下扫描有限深度的 .git，status
 * 聚合各仓库条目，其余操作按路径路由到所属仓库（worktree 后续再加）。
 * 历史视图（history / show / showDiff / push）按单个仓库作用，路径为仓库根相对。
 *
 * 状态解析走 `status --porcelain=v1 -z`（NUL 分隔，路径不做引号转义，中文
 * 文件名安全）；diff 统一 `-U3 --no-color --no-ext-diff`；未跟踪文件的
 * 单文件 diff 由本模块读文件内容合成（git diff 不显示 untracked）。
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	GitCommitDetail,
	GitCommitFile,
	GitHistoryEntry,
	GitHistoryResult,
	GitLogEntry,
	GitRef,
	GitStatusEntry,
	GitStatusResult,
	GitWorkspaceRepo,
} from "./protocol.ts";
import { messageOf, SidebarError, toWirePath } from "./sidebar-fs.ts";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** 跑一条 git 命令；非零退出抛 SidebarError（git-missing / git-error）。 */
async function git(
	cwd: string,
	args: string[],
	options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{
				cwd,
				windowsHide: true,
				maxBuffer: GIT_MAX_BUFFER,
				timeout: options.timeout ?? GIT_TIMEOUT_MS,
				// status 默认会顺手回写 .git/index；git 状态 watcher 会把这次回写当成新变更，形成刷新循环。
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env },
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						reject(new SidebarError("git-missing", "找不到 git 命令，请确认已安装 Git"));
						return;
					}
					const detail = String(stderr ?? "").trim() || messageOf(error);
					const verb = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? args[0];
					reject(new SidebarError("git-error", `git ${verb} 失败：${detail}`));
					return;
				}
				resolvePromise(String(stdout));
			},
		);
	});
}

// ---------------------------------------------------------------------------
// 子仓库发现：workspace 根不是仓库时向下扫有限深度的 .git（目录或 worktree 文件）
// ---------------------------------------------------------------------------

/** 子仓库扫描边界：目录深度（根=0）与访问目录数预算；重目录与隐藏目录不下探。 */
const REPO_SCAN_DEPTH = 3;
const REPO_SCAN_BUDGET = 800;
const REPO_SCAN_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "target", "__pycache__"]);

const repoScanCache = new Map<string, { at: number; roots: string[] }>();
const REPO_SCAN_TTL_MS = 5_000;

/**
 * BFS 找 workspace 下的仓库根（绝对路径，排序稳定）。命中 `.git` 即为仓库
 * 根，不再下探（子模块按单条目呈现，与外层仓库口径一致）——workspace 根自身
 * 除外：根是仓库时继续往下找嵌套的独立仓库。单个候选仓库的 status 失败不拖
 * 垮聚合，全部失败才把错误抛给前端。
 */
async function scanWorkspaceRepos(cwd: string): Promise<string[]> {
	const key = resolve(cwd);
	const cached = repoScanCache.get(key);
	const now = Date.now();
	if (cached !== undefined && now - cached.at < REPO_SCAN_TTL_MS) return cached.roots;
	const roots: string[] = [];
	let visited = 0;
	let queue: { dir: string; depth: number }[] = [{ dir: key, depth: 0 }];
	while (queue.length > 0 && visited < REPO_SCAN_BUDGET) {
		const next: { dir: string; depth: number }[] = [];
		await Promise.all(
			queue.map(async ({ dir, depth }) => {
				visited += 1;
				let dirents: Dirent[];
				try {
					dirents = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				if (dirents.some((dirent) => dirent.name === ".git")) {
					roots.push(dir);
					if (depth > 0) return;
				}
				if (depth >= REPO_SCAN_DEPTH) return;
				for (const dirent of dirents) {
					if (!dirent.isDirectory()) continue;
					if (dirent.name.startsWith(".") || REPO_SCAN_SKIP.has(dirent.name)) continue;
					next.push({ dir: join(dir, dirent.name), depth: depth + 1 });
				}
			}),
		);
		queue = next;
	}
	roots.sort();
	repoScanCache.set(key, { at: now, roots });
	if (repoScanCache.size > 64) {
		const oldest = repoScanCache.keys().next().value;
		if (oldest !== undefined) repoScanCache.delete(oldest);
	}
	return roots;
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 聚合模式下涉及的仓库根；undefined = 单仓库模式（cwd 在仓库内、其下没有嵌套
 * 仓库）。workspace 根本身是仓库、里面又嵌套了独立仓库（各自 clone 的项目）时，
 * 外层与嵌套仓库一起聚合，和 VS Code 的多仓库视图一致。workspace 开在仓库子目录
 * 时仍按单仓库处理（外层仓库的根不在 workspace 之内）。
 */
async function aggregateRoots(cwd: string): Promise<string[] | undefined> {
	const [top, scanned] = await Promise.all([repoToplevel(cwd), scanWorkspaceRepos(cwd)]);
	if (top === undefined) return scanned;
	if (relative(top, resolve(cwd)) !== "") return undefined;
	const nested = scanned.filter((root) => relative(root, top) !== "");
	return nested.length === 0 ? undefined : [top, ...nested];
}

/** 仓库根的线上形式：workspace 相对；workspace 根自身记作 "."（"" 留给前端表示全部仓库）。 */
function wireRoot(cwd: string, root: string): string {
	return toWirePath(cwd, root) || ".";
}

/** cwd 涉及的各仓库 .git 目录（绝对路径）；不能递归 watch 的平台只盯这些。 */
export async function gitMetadataDirs(cwd: string): Promise<string[]> {
	const roots = await aggregateRoots(cwd);
	if (roots === undefined) {
		try {
			return [(await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()];
		} catch {
			return [];
		}
	}
	return roots.map((root) => join(root, ".git"));
}

/** 子仓库模式的路径路由：workspace 相对路径 → 所属仓库根 + 仓库相对 POSIX 路径。 */
async function repoForPath(cwd: string, target: string): Promise<{ root: string; repoRel: string }> {
	// 嵌套时外层仓库也包含该路径，取最深的仓库
	const roots = [...((await aggregateRoots(cwd)) ?? [])].sort((a, b) => b.length - a.length);
	const absolute = resolve(cwd, target);
	for (const root of roots) {
		const rel = relative(root, absolute);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
		return { root, repoRel: rel.split(sep).join("/") };
	}
	throw new SidebarError("bad-request", `"${target}" 不在任何子仓库内，请刷新后重试`);
}

/** 子仓库模式：把 workspace 相对路径按所属仓库分组（值为仓库相对路径）。 */
async function groupByRepo(cwd: string, paths: string[]): Promise<Map<string, string[]>> {
	const groups = new Map<string, string[]>();
	for (const path of paths) {
		const { root, repoRel } = await repoForPath(cwd, path);
		const bucket = groups.get(root);
		if (bucket === undefined) groups.set(root, [repoRel]);
		else bucket.push(repoRel);
	}
	return groups;
}

/** 仓库相对条目 → workspace 相对条目（path 与 origPath 都要跨过仓库根前缀）。 */
function entryAt(cwd: string, root: string, entry: GitStatusEntry): GitStatusEntry {
	const map = (raw: string): string => toWirePath(cwd, resolve(root, raw));
	return {
		...entry,
		path: map(entry.path),
		...(entry.origPath !== undefined ? { origPath: map(entry.origPath) } : {}),
	};
}

/** 某仓库内单个路径的 porcelain 状态（pathspec 限定，供 untracked 判定）。 */
async function statusOfOne(root: string, repoRel: string): Promise<GitStatusEntry | undefined> {
	// -uall：未跟踪文件若整个目录都是新的，默认会折叠成 `?? dir/`，单文件查不到
	const out = await git(root, ["status", "--porcelain=v1", "-z", "-uall", "--", repoRel]);
	return parseStatusZ(out).entries.find((row) => row.path === repoRel);
}

/** `status --porcelain=v1 -z -b` 的纯解析（分支头 + NUL 分隔条目），便于测试。 */
export function parseStatusZ(out: string): { branch?: string; upstream?: string; entries: GitStatusResult["entries"] } {
	const parts = out.split("\0");
	const entries: GitStatusResult["entries"] = [];
	let branch: string | undefined;
	let upstream: string | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		if (part === "") continue;
		if (part.startsWith("## ")) {
			const header = part.slice(3);
			const [local, ahead] = header.split("...");
			branch = local?.trim() || undefined;
			if (ahead !== undefined) upstream = ahead.split(" ")[0]?.trim() || undefined;
			continue;
		}
		if (part.length < 4) continue;
		const x = part[0]!;
		const y = part[1]!;
		// porcelain v1 条目 = XY + 一个空格 + path，路径从索引 3 起。
		const path = part.slice(3);
		// 重命名条目带第二个 NUL 段（旧路径）。
		const next = parts[index + 1];
		if ((x === "R" || x === "C" || y === "R" || y === "C") && next !== undefined && next !== "") {
			index += 1;
			entries.push({ path, x, y, origPath: next });
		} else {
			entries.push({ path, x, y });
		}
	}
	return { branch, upstream, entries };
}

/**
 * workspace 开在仓库子目录里时，porcelain 条目是仓库根相对的，而侧边栏全链路
 * 约定 workspace（= cwd）相对路径——把落在 cwd 之下的条目重定基为 cwd 相对，
 * 仓库其他部分的改动不显示。prefix = cwd 相对仓库根的 POSIX 路径；prefix 为空
 * （cwd 就是仓库根）时原样返回。cwd 目录自身整体未跟踪的 `?? <prefix>/` 条目
 * 重定基为 `.`，暂存/提交仍能用 `--` pathspec 命中整个目录。重命名的旧路径落
 * 在 cwd 之外时保留仓库根相对原值（仅作展示）。
 */
export function rebaseStatusEntriesToCwd(
	prefix: string,
	parsed: { branch?: string; upstream?: string; entries: GitStatusResult["entries"] },
): { branch?: string; upstream?: string; entries: GitStatusResult["entries"] } {
	if (prefix === "" || prefix.startsWith("..") || isAbsolute(prefix)) return parsed;
	const strip = (raw: string): string | undefined => {
		if (raw === prefix) return ".";
		if (raw.startsWith(`${prefix}/`)) {
			const rest = raw.slice(prefix.length + 1);
			return rest === "" ? "." : rest;
		}
		return undefined;
	};
	const entries: GitStatusResult["entries"] = [];
	for (const entry of parsed.entries) {
		const path = strip(entry.path);
		if (path === undefined) continue;
		const origPath = entry.origPath !== undefined ? strip(entry.origPath) : undefined;
		entries.push({
			...entry,
			path,
			...(entry.origPath !== undefined ? { origPath: origPath ?? entry.origPath } : {}),
		});
	}
	return { ...parsed, entries };
}

const IGNORED_LIMIT = 5_000;

/**
 * 在 dir 下被忽略的路径（相对 dir，ls-files 只列 dir 之内）。`--directory` 把整
 * 个被忽略的目录折叠成一条，node_modules 之类不会展开；失败只是少了置灰。
 */
async function ignoredUnder(dir: string): Promise<string[]> {
	try {
		const out = await git(dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
		return out
			.split("\0")
			.filter((path) => path !== "")
			.slice(0, IGNORED_LIMIT)
			.map((path) => path.replace(/\/$/, ""));
	} catch {
		return [];
	}
}

/** 取 cwd 所属仓库根；porcelain 的仓库根相对条目靠它重定基到 cwd 相对。 */
async function repoToplevel(cwd: string): Promise<string | undefined> {
	try {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		return root === "" ? undefined : root;
	} catch {
		return undefined;
	}
}

/**
 * `git.status`：非仓库返回 repo:false（前端空态），仓库返回解析后的状态。
 * workspace 根不是仓库时扫描子仓库并聚合各仓库条目（path 归一到 workspace
 * 相对）；单仓库回填 branch/upstream，多仓库由前端展示"N 个仓库"。
 * workspace 在仓库内部（子目录打开）时，条目从仓库根相对重定基为 cwd 相对，
 * 只保留 cwd 之下的改动——下游 stage/diff/discard 的 pathspec 都是 cwd 相对。
 */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
	// -uall：把整目录未跟踪展开成单文件条目。默认的目录折叠（`?? dir/`）在
	// 子仓库聚合里没法重定基，点开也是合成不出内容的空 diff。
	const roots = await aggregateRoots(cwd);
	if (roots === undefined) {
		const [out, ignored] = await Promise.all([
			git(cwd, ["status", "--porcelain=v1", "-z", "-b", "-uall"]),
			ignoredUnder(cwd),
		]);
		const parsed = parseStatusZ(out);
		const root = await repoToplevel(cwd);
		if (root === undefined) return { repo: true, ...parsed, ignored };
		return {
			repo: true,
			...rebaseStatusEntriesToCwd(relative(root, resolve(cwd)).split(sep).join("/"), parsed),
			ignored,
		};
	}
	if (roots.length === 0) {
		return { repo: false, entries: [] };
	}
	const repos: GitWorkspaceRepo[] = [];
	const entries: GitStatusEntry[] = [];
	const ignored: string[] = [];
	let firstError: unknown;
	for (const root of roots) {
		// 外层仓库把嵌套仓库目录报成 `?? xmart-ai/`（或忽略项），这些归嵌套仓库自己展示
		const nested = roots.filter((other) => isInside(other, root));
		const ownedByNested = (raw: string): boolean => {
			const absolute = resolve(root, raw.replace(/\/$/, ""));
			return nested.some(
				(other) => relative(other, absolute) === "" || isInside(absolute, other) || isInside(other, absolute),
			);
		};
		try {
			const [out, repoIgnored] = await Promise.all([
				git(root, ["status", "--porcelain=v1", "-z", "-b", "-uall"]),
				ignoredUnder(root),
			]);
			const parsed = parseStatusZ(out);
			repos.push({ root: wireRoot(cwd, root), branch: parsed.branch, upstream: parsed.upstream });
			for (const entry of parsed.entries) {
				if (!ownedByNested(entry.path)) entries.push(entryAt(cwd, root, entry));
			}
			for (const path of repoIgnored) {
				if (ignored.length < IGNORED_LIMIT && !ownedByNested(path))
					ignored.push(toWirePath(cwd, resolve(root, path)));
			}
		} catch (error) {
			// 单个候选损坏（空 .git、dubious ownership 等）只跳过该仓库
			firstError ??= error;
		}
	}
	if (repos.length === 0 && firstError !== undefined) throw firstError;
	return {
		repo: true,
		entries,
		repos,
		ignored,
		...(repos.length === 1 ? { branch: repos[0]!.branch, upstream: repos[0]!.upstream } : {}),
	};
}

/**
 * 单文件/整个仓库的 unified diff。staged 走 `--cached`；工作树视角下未跟踪
 * 的文件（git diff 不显示）用文件内容合成一个 /dev/null 起始的 diff。
 * 子仓库模式下 path 为 workspace 相对，整工作区 diff 是各仓库 diff 的拼接。
 */
export async function gitDiff(cwd: string, path?: string, staged = false): Promise<string> {
	const roots = await aggregateRoots(cwd);
	if (roots === undefined) {
		if (path !== undefined) {
			if (!staged) {
				const status = await gitStatus(cwd);
				const entry = status.entries.find((row) => row.path === path);
				if (entry !== undefined && entry.x === "?" && entry.y === "?") {
					return untrackedDiff(cwd, path);
				}
			}
			return await git(cwd, [
				"diff",
				...(staged ? ["--cached"] : []),
				"--no-color",
				"--no-ext-diff",
				"-U3",
				"--",
				path,
			]);
		}
		return await git(cwd, ["diff", ...(staged ? ["--cached"] : []), "--no-color", "--no-ext-diff", "-U3"]);
	}
	if (path === undefined) {
		const parts: string[] = [];
		for (const root of roots) {
			parts.push(await git(root, ["diff", ...(staged ? ["--cached"] : []), "--no-color", "--no-ext-diff", "-U3"]));
		}
		return parts.join("");
	}
	const { root, repoRel } = await repoForPath(cwd, path);
	if (!staged) {
		const entry = await statusOfOne(root, repoRel);
		if (entry !== undefined && entry.x === "?" && entry.y === "?") {
			return untrackedDiff(cwd, path);
		}
	}
	return await git(root, [
		"diff",
		...(staged ? ["--cached"] : []),
		"--no-color",
		"--no-ext-diff",
		"-U3",
		"--",
		repoRel,
	]);
}

/** 把一个未跟踪文件合成 unified diff（新增文件全绿）。 */
async function untrackedDiff(cwd: string, path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	const absolute = resolve(cwd, path);
	const body = await readFile(absolute, "utf8").catch(() => "");
	if (body === "") return "";
	const lines = body.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const posix = path.split("\\").join("/");
	const header = [
		`diff --git a/${posix} b/${posix}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${posix}`,
		`@@ -0,0 +1,${lines.length} @@`,
	];
	return [...header, ...lines.map((line) => `+${line}`), ""].join("\n");
}

export async function gitStage(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	if ((await aggregateRoots(cwd)) !== undefined) {
		for (const [root, repoPaths] of await groupByRepo(cwd, paths)) {
			await git(root, ["add", "--", ...repoPaths]);
		}
		return;
	}
	await git(cwd, ["add", "--", ...paths]);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	if ((await aggregateRoots(cwd)) !== undefined) {
		for (const [root, repoPaths] of await groupByRepo(cwd, paths)) {
			await git(root, ["reset", "-q", "HEAD", "--", ...repoPaths]);
		}
		return;
	}
	await git(cwd, ["reset", "-q", "HEAD", "--", ...paths]);
}

/**
 * 提交已暂存的内容。子仓库模式下默认对每个有暂存条目的仓库各提交一次
 * （同一提交信息）；`repoRoot`（workspace 相对根）把提交限定到单个仓库，
 * 与变动页的仓库筛选器联动。
 */
export async function gitCommit(cwd: string, message: string, repoRoot?: string): Promise<void> {
	if (message.trim() === "") {
		throw new SidebarError("bad-request", "提交信息不能为空");
	}
	let roots = await aggregateRoots(cwd);
	if (roots !== undefined) {
		if (roots.length === 0) {
			throw new SidebarError("git-error", "当前目录不是 Git 仓库");
		}
		if (repoRoot !== undefined) {
			const absolute = resolve(cwd, repoRoot);
			// relative() 在 Windows 上大小写不敏感，盘符/目录大小写差异不影响匹配
			roots = roots.filter((root) => relative(root, absolute) === "");
			if (roots.length === 0) {
				throw new SidebarError("bad-request", `"${repoRoot}" 不是已识别的子仓库，请刷新后重试`);
			}
		}
		// 先筛出有暂存条目的仓库：全都为空时才报「没有已暂存的改动」，
		// 避免中途失败被误报成空暂存
		const pending: string[] = [];
		for (const root of roots) {
			const status = parseStatusZ(await git(root, ["status", "--porcelain=v1", "-z"]));
			if (status.entries.some((row) => row.x !== " " && row.x !== "?")) pending.push(root);
		}
		if (pending.length === 0) {
			throw new SidebarError("bad-request", "没有已暂存的改动");
		}
		// 逐仓提交：中途失败要说明哪些仓已经提了，不然重试时误以为整批都没成功
		const committed: string[] = [];
		for (const root of pending) {
			try {
				await git(root, ["commit", "-m", message]);
				committed.push(wireRoot(cwd, root));
			} catch (error) {
				const done = committed.length > 0 ? `已提交 ${committed.join("、")}；` : "";
				throw new SidebarError("git-error", `${done}「${wireRoot(cwd, root)}」提交失败：${messageOf(error)}`);
			}
		}
		return;
	}
	// 不带 -a：只提交已暂存的内容，与界面上的暂存语义一致。
	await git(cwd, ["commit", "-m", message]);
}

/**
 * 丢弃一个文件的工作树改动：未跟踪文件直接删除（VS Code 同款语义），
 * 已跟踪文件 checkout 回索引版本。子仓库模式下按路径路由到所属仓库。
 */
export async function gitDiscard(cwd: string, path: string): Promise<void> {
	if ((await aggregateRoots(cwd)) !== undefined) {
		const { root, repoRel } = await repoForPath(cwd, path);
		const entry = await statusOfOne(root, repoRel);
		if (entry !== undefined && entry.x === "?" && entry.y === "?") {
			await rm(resolve(cwd, path), { force: true, recursive: true });
			return;
		}
		await git(root, ["checkout", "-q", "--", repoRel]);
		return;
	}
	const status = await gitStatus(cwd);
	const entry = status.entries.find((row) => row.path === path);
	if (entry !== undefined && entry.x === "?" && entry.y === "?") {
		await rm(resolve(cwd, path), { force: true, recursive: true });
		return;
	}
	await git(cwd, ["checkout", "-q", "--", path]);
}

/** `git log --pretty=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e` 的纯解析。 */
export function parseLog(out: string): GitLogEntry[] {
	return out
		.split("\u001e")
		.filter((record) => record.trim() !== "")
		.map((record) => {
			const [hash = "", short = "", subject = "", author = "", time = "0"] = record.split("\u001f");
			return { hash, short, subject, author, time: Number(time) || 0 };
		});
}

/** 提交历史（新→旧）。子仓库模式拼接各仓库并按时间归并，repo 字段标来源。 */
export async function gitLog(cwd: string, count = 50): Promise<GitLogEntry[]> {
	const roots = await aggregateRoots(cwd);
	if (roots === undefined) {
		const out = await git(cwd, ["log", `-n${count}`, "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e"]);
		return parseLog(out);
	}
	const all: GitLogEntry[] = [];
	for (const root of roots) {
		try {
			const out = await git(root, ["log", `-n${count}`, "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e"]);
			const repo = wireRoot(cwd, root);
			all.push(...parseLog(out).map((entry) => ({ ...entry, repo })));
		} catch {
			// 还没有任何提交的仓库：跳过
		}
	}
	return all.sort((a, b) => b.time - a.time).slice(0, count);
}

/** 把 git 报告的路径（仓库根相对）归一到 workspace 相对 POSIX 形式。 */
export function wirePathOf(cwd: string, raw: string): string {
	return toWirePath(resolve(cwd), resolve(cwd, raw));
}

// ---------------------------------------------------------------------------
// 历史视图：单仓库作用域（提交列表 / 提交详情 / 提交 diff / 推送）
// ---------------------------------------------------------------------------

const HISTORY_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1e";
const HISTORY_MAX_COUNT = 200;
const UNPUSHED_SCAN_LIMIT = 1000;
const SHOW_DIFF_MAX_PATHS = 200;
const PUSH_TIMEOUT_MS = 120_000;
// 用户开了 log.showSignature 时签名校验输出会混进 stdout，破坏格式解析
const NO_SIGNATURE = ["-c", "log.showSignature=false"];

/** 失败返回 undefined 的 git 查询（无上游、分离 HEAD、空仓库等都是正常状态）。 */
async function gitOptional(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const out = (await git(cwd, args)).trim();
		return out === "" ? undefined : out;
	} catch {
		return undefined;
	}
}

function assertHash(hash: string): void {
	if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new SidebarError("bad-request", `无效的提交哈希：${hash}`);
}

/**
 * 历史视图的仓库根。显式 repo（workspace 相对）须是已识别的子仓库；缺省取
 * cwd 所在仓库的根（workspace 开在子目录时也看整个仓库的历史），cwd 不是仓库
 * 时取第一个子仓库。
 */
export async function historyRepoRoot(cwd: string, repo?: string): Promise<string> {
	if (repo !== undefined && repo !== "") {
		const absolute = resolve(cwd, repo);
		const match = (await scanWorkspaceRepos(cwd)).find((root) => relative(root, absolute) === "");
		if (match === undefined) throw new SidebarError("bad-request", `"${repo}" 不是已识别的子仓库，请刷新后重试`);
		return match;
	}
	const top = await repoToplevel(cwd);
	if (top !== undefined) return top;
	const [first] = await scanWorkspaceRepos(cwd);
	if (first === undefined) throw new SidebarError("git-error", "当前目录不是 Git 仓库");
	return first;
}

/** GitHub 远程地址 → owner/repo（https、带 user@ 的 https、scp 风格、ssh://）。 */
export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
	const match =
		/^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
			(url ?? "").trim(),
		);
	return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** `%D` 装饰串 → 引用标记。origin/HEAD 这类远程默认分支指针不展示。 */
export function parseRefs(decoration: string, remotes: ReadonlySet<string>): GitRef[] {
	const refs: GitRef[] = [];
	for (const raw of decoration.split(",")) {
		const part = raw.trim();
		if (part === "") continue;
		if (part === "HEAD") {
			refs.push({ kind: "head", name: "HEAD" });
		} else if (part.startsWith("HEAD -> ")) {
			refs.push({ kind: "head", name: part.slice("HEAD -> ".length) });
		} else if (part.startsWith("tag: ")) {
			refs.push({ kind: "tag", name: part.slice("tag: ".length) });
		} else {
			const slash = part.indexOf("/");
			if (slash > 0 && remotes.has(part.slice(0, slash))) {
				if (!part.endsWith("/HEAD")) refs.push({ kind: "remote", name: part });
			} else {
				refs.push({ kind: "local", name: part });
			}
		}
	}
	return refs;
}

/** `git log --pretty=HISTORY_FORMAT` 的纯解析。 */
export function parseHistory(out: string, remotes: ReadonlySet<string>): GitHistoryEntry[] {
	return out
		.split("\u001e")
		.filter((record) => record.trim() !== "")
		.map((record) => {
			const [hash = "", short = "", subject = "", author = "", email = "", time = "0", parents = "", refs = ""] =
				record.replace(/^\s+/, "").split("\u001f");
			return {
				hash,
				short,
				subject,
				author,
				email,
				time: Number(time) || 0,
				parents: parents.trim() === "" ? [] : parents.trim().split(" "),
				refs: parseRefs(refs, remotes),
			};
		});
}

async function listRemotes(root: string): Promise<Set<string>> {
	const out = await gitOptional(root, ["remote"]);
	return new Set(
		(out ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== ""),
	);
}

/** 历史视图关联的 GitHub 仓库：优先上游所在远程，其次 origin，再次第一个远程。 */
export async function historyGithubRepo(
	cwd: string,
	repo?: string,
): Promise<{ root: string; owner: string; repo: string } | undefined> {
	const root = await historyRepoRoot(cwd, repo);
	const remotes = await listRemotes(root);
	const upstream = await gitOptional(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	const upstreamRemote = upstream?.split("/")[0];
	const candidates = [upstreamRemote, "origin", ...remotes].filter(
		(name): name is string => name !== undefined && remotes.has(name),
	);
	for (const name of new Set(candidates)) {
		const parsed = parseGitHubRemote(await gitOptional(root, ["remote", "get-url", name]));
		if (parsed !== undefined) return { root, ...parsed };
	}
	return undefined;
}

/** 历史视图一页：提交（新→旧）+ 当前分支相对上游的领先/落后与未推送标记。 */
export async function gitHistory(
	cwd: string,
	options: { repo?: string; all?: boolean; skip?: number; count?: number } = {},
): Promise<GitHistoryResult> {
	const root = await historyRepoRoot(cwd, options.repo);
	const count = Math.min(Math.max(Math.trunc(options.count ?? 50), 1), HISTORY_MAX_COUNT);
	const skip = Math.max(Math.trunc(options.skip ?? 0), 0);
	const [branch, upstream, remotes, head] = await Promise.all([
		gitOptional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
		gitOptional(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
		listRemotes(root),
		gitOptional(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
	]);

	let ahead = 0;
	let behind = 0;
	let unpushed = new Set<string>();
	if (upstream !== undefined) {
		const [behindRaw, aheadRaw] = (
			(await gitOptional(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])) ?? ""
		)
			.split(/\s+/)
			.map(Number);
		behind = behindRaw || 0;
		ahead = aheadRaw || 0;
		if (ahead > 0) {
			const list = await gitOptional(root, ["rev-list", `--max-count=${UNPUSHED_SCAN_LIMIT}`, "@{u}..HEAD"]);
			unpushed = new Set((list ?? "").split(/\r?\n/).filter((line) => line !== ""));
		}
	}

	let entries: GitHistoryEntry[] = [];
	// 还没有任何提交时 `git log` 会报错；--all 在没有引用时正常返回空
	if (head !== undefined || options.all === true) {
		const out = await git(root, [
			...NO_SIGNATURE,
			"log",
			...(options.all === true ? ["--all"] : []),
			"--date-order",
			"--no-color",
			`--max-count=${count + 1}`,
			`--skip=${skip}`,
			`--pretty=${HISTORY_FORMAT}`,
		]);
		entries = parseHistory(out, remotes);
	}
	const hasMore = entries.length > count;
	entries = entries.slice(0, count).map((entry) => (unpushed.has(entry.hash) ? { ...entry, unpushed: true } : entry));

	const github = await historyGithubRepo(root).catch(() => undefined);
	return {
		...(branch !== undefined ? { branch } : {}),
		...(upstream !== undefined ? { upstream } : {}),
		ahead,
		behind,
		canPublish: upstream === undefined && branch !== undefined && remotes.size > 0,
		entries,
		hasMore,
		...(github !== undefined ? { githubUrl: `https://github.com/${github.owner}/${github.repo}` } : {}),
	};
}

/** `--name-status -z` 的纯解析：重命名/复制条目带旧、新两段路径。 */
export function parseNameStatusZ(out: string): Array<{ status: string; path: string; origPath?: string }> {
	const parts = out.split("\0");
	const rows: Array<{ status: string; path: string; origPath?: string }> = [];
	for (let index = 0; index < parts.length; index += 1) {
		const token = parts[index]!.trim();
		if (token === "") continue;
		const status = token[0]!;
		if (status === "R" || status === "C") {
			const origPath = parts[index + 1] ?? "";
			const path = parts[index + 2] ?? "";
			index += 2;
			rows.push({ status, path, origPath });
		} else {
			rows.push({ status, path: parts[index + 1] ?? "" });
			index += 1;
		}
	}
	return rows;
}

/** `--numstat -z` 的纯解析，按新路径索引；二进制文件（`-`）计数缺省。 */
export function parseNumstatZ(out: string): Map<string, { additions?: number; deletions?: number }> {
	const parts = out.split("\0");
	const stats = new Map<string, { additions?: number; deletions?: number }>();
	for (let index = 0; index < parts.length; index += 1) {
		const token = parts[index]!.replace(/^\s+/, "");
		if (token === "") continue;
		const [addRaw = "", delRaw = "", inlinePath = ""] = token.split("\t");
		let path = inlinePath;
		// 重命名：路径字段为空，旧、新路径各占后续一段
		if (path === "") {
			path = parts[index + 2] ?? "";
			index += 2;
		}
		stats.set(path, {
			...(addRaw !== "-" ? { additions: Number(addRaw) || 0 } : {}),
			...(delRaw !== "-" ? { deletions: Number(delRaw) || 0 } : {}),
		});
	}
	return stats;
}

/** 单个提交的详情：完整说明 + 改动文件（合并提交与第一父提交比较）。 */
export async function gitCommitDetail(cwd: string, hash: string, repo?: string): Promise<GitCommitDetail> {
	assertHash(hash);
	const root = await historyRepoRoot(cwd, repo);
	const head = await git(root, [
		...NO_SIGNATURE,
		"show",
		"-s",
		"--no-color",
		"--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B",
		hash,
	]);
	const [full = "", short = "", parents = "", author = "", email = "", time = "0", ...rest] = head.split("\u001f");
	const message = rest.join("\u001f").replace(/\s+$/, "");
	const newline = message.indexOf("\n");
	const filesArgs = [...NO_SIGNATURE, "show", "--format=", "--no-color", "--diff-merges=first-parent", "-M", "-z"];
	const [statusOut, numstatOut] = await Promise.all([
		git(root, [...filesArgs, "--name-status", full]),
		git(root, [...filesArgs, "--numstat", full]),
	]);
	const stats = parseNumstatZ(numstatOut);
	const files: GitCommitFile[] = parseNameStatusZ(statusOut).map((row) => ({ ...row, ...stats.get(row.path) }));
	return {
		hash: full,
		short,
		parents: parents.trim() === "" ? [] : parents.trim().split(" "),
		author,
		email,
		time: Number(time) || 0,
		subject: newline < 0 ? message : message.slice(0, newline),
		body: newline < 0 ? "" : message.slice(newline + 1).trim(),
		files,
		additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
		deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
	};
}

/**
 * 提交里若干文件的 unified diff（路径为仓库根相对）。parent = 该提交引入的改动
 * （合并提交对第一父提交）；worktree = 该提交与当前工作区之间的差异。
 */
export async function gitCommitDiff(
	cwd: string,
	hash: string,
	paths: string[],
	against: "parent" | "worktree" = "parent",
	repo?: string,
): Promise<string> {
	assertHash(hash);
	const specs = paths.filter((path) => path.trim() !== "").slice(0, SHOW_DIFF_MAX_PATHS);
	if (specs.length === 0) throw new SidebarError("bad-request", "至少需要一个文件路径");
	const root = await historyRepoRoot(cwd, repo);
	// 路径来自提交的文件列表，是真实文件名而非通配模式
	const options = { env: { GIT_LITERAL_PATHSPECS: "1" } };
	const out =
		against === "worktree"
			? await git(root, ["diff", "--no-color", "--no-ext-diff", "-U3", "-M", hash, "--", ...specs], options)
			: await git(
					root,
					[
						...NO_SIGNATURE,
						"show",
						"--format=",
						"--no-color",
						"--no-ext-diff",
						"-U3",
						"--diff-merges=first-parent",
						"-M",
						hash,
						"--",
						...specs,
					],
					options,
				);
	return out.replace(/^\s*\n/, "");
}

/** 推送当前分支；没有上游时发布到 origin（没有 origin 取第一个远程）并设为上游。 */
export async function gitPush(cwd: string, repo?: string): Promise<void> {
	const root = await historyRepoRoot(cwd, repo);
	// 凭据缺失时立刻失败，不在无终端的子进程里等输入直到超时
	const options = { timeout: PUSH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0" } };
	const upstream = await gitOptional(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	if (upstream !== undefined) {
		await git(root, ["push"], options);
		return;
	}
	const branch = await gitOptional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch === undefined) throw new SidebarError("bad-request", "分离 HEAD 状态下无法推送，请先切换到分支");
	const remotes = await listRemotes(root);
	const remote = remotes.has("origin") ? "origin" : [...remotes][0];
	if (remote === undefined) throw new SidebarError("bad-request", "仓库没有配置远程，无法推送");
	await git(root, ["push", "-u", remote, branch], options);
}
