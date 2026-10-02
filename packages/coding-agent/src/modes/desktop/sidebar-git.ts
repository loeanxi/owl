/**
 * owl 侧边栏工作台的 Git 层：只调 CLI（argv 数组、无 shell 插值），绝不设置
 * 用户身份或改配置。移植自 dsh-better-sidebar 的 git.ts 的子集——owl 桌面
 * 端先落 status / diff / stage / unstage / commit / discard / log 七个能力
 * （文件变动 tab 的最小闭环），worktree / 子仓库 / 历史视图后续再加。
 *
 * 状态解析走 `status --porcelain=v1 -z`（NUL 分隔，路径不做引号转义，中文
 * 文件名安全）；diff 统一 `-U3 --no-color --no-ext-diff`；未跟踪文件的
 * 单文件 diff 由本模块读文件内容合成（git diff 不显示 untracked）。
 */

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { SidebarError, messageOf, toWirePath } from "./sidebar-fs.ts";
import type { GitLogEntry, GitStatusResult } from "./protocol.ts";

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

/** `git.status`：非仓库返回 repo:false（前端空态），仓库返回解析后的状态。 */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
	if (!(await isRepo(cwd))) {
		return { repo: false, entries: [] };
	}
	const out = await git(cwd, ["status", "--porcelain=v1", "-z", "-b"]);
	return { repo: true, ...parseStatusZ(out) };
}

/**
 * 单文件/整个仓库的 unified diff。staged 走 `--cached`；工作树视角下未跟踪
 * 的文件（git diff 不显示）用文件内容合成一个 /dev/null 起始的 diff。
 */
export async function gitDiff(cwd: string, path?: string, staged = false): Promise<string> {
	if (!(await isRepo(cwd))) {
		throw new SidebarError("git-error", "当前目录不是 Git 仓库");
	}
	if (staged) {
		const args = ["diff", "--cached", "--no-color", "--no-ext-diff", "-U3"];
		if (path !== undefined) args.push("--", path);
		return await git(cwd, args);
	}
	if (path !== undefined) {
		const status = await gitStatus(cwd);
		const entry = status.entries.find((row) => row.path === path);
		if (entry !== undefined && entry.x === "?" && entry.y === "?") {
			return untrackedDiff(cwd, path);
		}
		return await git(cwd, ["diff", "--no-color", "--no-ext-diff", "-U3", "--", path]);
	}
	return await git(cwd, ["diff", "--no-color", "--no-ext-diff", "-U3"]);
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
	const header = [`diff --git a/${posix} b/${posix}`, "new file mode 100644", "--- /dev/null", `+++ b/${posix}`, `@@ -0,0 +1,${lines.length} @@`];
	return [...header, ...lines.map((line) => `+${line}`), ""].join("\n");
}

export async function gitStage(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	await git(cwd, ["add", "--", ...paths]);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	await git(cwd, ["reset", "-q", "HEAD", "--", ...paths]);
}

export async function gitCommit(cwd: string, message: string): Promise<void> {
	if (message.trim() === "") {
		throw new SidebarError("bad-request", "提交信息不能为空");
	}
	// 不带 -a：只提交已暂存的内容，与界面上的暂存语义一致。
	await git(cwd, ["commit", "-m", message]);
}

/**
 * 丢弃一个文件的工作树改动：未跟踪文件直接删除（VS Code 同款语义），
 * 已跟踪文件 checkout 回索引版本。
 */
export async function gitDiscard(cwd: string, path: string): Promise<void> {
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

/** 提交历史（新→旧）。 */
export async function gitLog(cwd: string, count = 50): Promise<GitLogEntry[]> {
	if (!(await isRepo(cwd))) return [];
	const out = await git(cwd, [
		"log",
		`-n${count}`,
		"--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e",
	]);
	return parseLog(out);
}

/** 把 git 报告的路径（仓库根相对）归一到 workspace 相对 POSIX 形式。 */
export function wirePathOf(cwd: string, raw: string): string {
	return toWirePath(resolve(cwd), resolve(cwd, raw));
}
