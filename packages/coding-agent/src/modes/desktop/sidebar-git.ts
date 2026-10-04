/**
 * owl 侧边栏工作台的 Git 层：只调 CLI（argv 数组、无 shell 插值），绝不设置
 * 用户身份或改配置。移植自 dsh-better-sidebar 的 git.ts 的子集——owl 桌面
 * 端落 status / diff / stage / unstage / commit / discard / log 七个能力，
 * 外加子仓库聚合：workspace 根不是仓库时向下扫描有限深度的 .git，status
 * 聚合各仓库条目，其余操作按路径路由到所属仓库（worktree / 历史视图后续再加）。
 *
 * 状态解析走 `status --porcelain=v1 -z`（NUL 分隔，路径不做引号转义，中文
 * 文件名安全）；diff 统一 `-U3 --no-color --no-ext-diff`；未跟踪文件的
 * 单文件 diff 由本模块读文件内容合成（git diff 不显示 untracked）。
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitLogEntry, GitStatusEntry, GitStatusResult, GitWorkspaceRepo } from "./protocol.ts";
import { messageOf, SidebarError, toWirePath } from "./sidebar-fs.ts";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** 跑一条 git 命令；非零退出抛 SidebarError（git-missing / git-error）。 */
async function git(cwd: string, args: string[]): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS },
			(error, stdout, stderr) => {
				if (error !== null) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						reject(new SidebarError("git-missing", "找不到 git 命令，请确认已安装 Git"));
						return;
					}
					const detail = String(stderr ?? "").trim() || messageOf(error);
					reject(new SidebarError("git-error", `git ${args[0]} 失败：${detail}`));
					return;
				}
				resolvePromise(String(stdout));
			},
		);
	});
}

/** 是否 git 仓库（ tolerates bare/worktree 上层检测交给 git 本身）。 */
async function isRepo(cwd: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
		return true;
	} catch {
		return false;
	}
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
 * BFS 找 workspace 下的子仓库根（绝对路径，排序稳定）。命中 `.git` 即为仓库
 * 根，不再下探（子模块按单条目呈现，与外层仓库口径一致）；单个候选仓库的
 * status 失败不拖垮聚合，全部失败才把错误抛给前端。
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
				for (const dirent of dirents) {
					if (dirent.name === ".git") {
						roots.push(dir);
						return;
					}
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

/** 子仓库模式的路径路由：workspace 相对路径 → 所属仓库根 + 仓库相对 POSIX 路径。 */
async function repoForPath(cwd: string, target: string): Promise<{ root: string; repoRel: string }> {
	const roots = await scanWorkspaceRepos(cwd);
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
	const out = await git(root, ["status", "--porcelain=v1", "-z", "--", repoRel]);
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
 * `git.status`：非仓库返回 repo:false（前端空态），仓库返回解析后的状态。
 * workspace 根不是仓库时扫描子仓库并聚合各仓库条目（path 归一到 workspace
 * 相对）；单仓库回填 branch/upstream，多仓库由前端展示"N 个仓库"。
 */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
	if (await isRepo(cwd)) {
		const out = await git(cwd, ["status", "--porcelain=v1", "-z", "-b"]);
		return { repo: true, ...parseStatusZ(out) };
	}
	const roots = await scanWorkspaceRepos(cwd);
	if (roots.length === 0) {
		return { repo: false, entries: [] };
	}
	const repos: GitWorkspaceRepo[] = [];
	const entries: GitStatusEntry[] = [];
	let firstError: unknown;
	for (const root of roots) {
		try {
			const parsed = parseStatusZ(await git(root, ["status", "--porcelain=v1", "-z", "-b"]));
			repos.push({ root: toWirePath(cwd, root), branch: parsed.branch, upstream: parsed.upstream });
			for (const entry of parsed.entries) {
				entries.push(entryAt(cwd, root, entry));
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
		...(repos.length === 1 ? { branch: repos[0]!.branch, upstream: repos[0]!.upstream } : {}),
	};
}

/**
 * 单文件/整个仓库的 unified diff。staged 走 `--cached`；工作树视角下未跟踪
 * 的文件（git diff 不显示）用文件内容合成一个 /dev/null 起始的 diff。
 * 子仓库模式下 path 为 workspace 相对，整工作区 diff 是各仓库 diff 的拼接。
 */
export async function gitDiff(cwd: string, path?: string, staged = false): Promise<string> {
	if (await isRepo(cwd)) {
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
		const roots = await scanWorkspaceRepos(cwd);
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
	if (!(await isRepo(cwd))) {
		for (const [root, repoPaths] of await groupByRepo(cwd, paths)) {
			await git(root, ["add", "--", ...repoPaths]);
		}
		return;
	}
	await git(cwd, ["add", "--", ...paths]);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	if (!(await isRepo(cwd))) {
		for (const [root, repoPaths] of await groupByRepo(cwd, paths)) {
			await git(root, ["reset", "-q", "HEAD", "--", ...repoPaths]);
		}
		return;
	}
	await git(cwd, ["reset", "-q", "HEAD", "--", ...paths]);
}

export async function gitCommit(cwd: string, message: string): Promise<void> {
	if (message.trim() === "") {
		throw new SidebarError("bad-request", "提交信息不能为空");
	}
	if (!(await isRepo(cwd))) {
		// 子仓库模式：对每个有已暂存条目的仓库各提交一次（同一提交信息）。
		const roots = await scanWorkspaceRepos(cwd);
		if (roots.length === 0) {
			throw new SidebarError("git-error", "当前目录不是 Git 仓库");
		}
		let committed = 0;
		for (const root of roots) {
			const status = parseStatusZ(await git(root, ["status", "--porcelain=v1", "-z"]));
			if (!status.entries.some((row) => row.x !== " " && row.x !== "?")) continue;
			await git(root, ["commit", "-m", message]);
			committed += 1;
		}
		if (committed === 0) {
			throw new SidebarError("bad-request", "没有已暂存的改动");
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
	if (!(await isRepo(cwd))) {
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
	if (await isRepo(cwd)) {
		const out = await git(cwd, ["log", `-n${count}`, "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e"]);
		return parseLog(out);
	}
	const roots = await scanWorkspaceRepos(cwd);
	const all: GitLogEntry[] = [];
	for (const root of roots) {
		try {
			const out = await git(root, ["log", `-n${count}`, "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e"]);
			const repo = toWirePath(cwd, root);
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
