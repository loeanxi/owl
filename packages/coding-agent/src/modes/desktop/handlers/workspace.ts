/**
 * owl desktop bridge — workspace 域 handler（fs / git / watch+open / project）。
 *
 * 从 serve.ts 的 handleRequest 分组原样搬迁：共享闭包（reply / onDiagnostic /
 * broadcast / sidebarWatchers / viewerRequests）改为显式上下文注入，逻辑零改动。
 */

import { spawn } from "node:child_process";
import { constants, mkdirSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { WebSocket } from "ws";
import { expandTildePath } from "../../../config.ts";
import { listWorkspaceViewers, openWorkspaceViewer } from "../../../core/workspace-viewers.ts";
import { EditorDraftStore } from "../editor-drafts.ts";
import { canonicalEditorWorkspace, editorPathKey, saveEditorFile } from "../editor-files.ts";
import type { DesktopClientRequest, DesktopServerMessage } from "../protocol.ts";
import {
	invalidateDirectoryCache,
	listWorkspaceDirectory,
	mkdirWorkspaceEntry,
	readWorkspaceFile,
	readWorkspaceFileBinary,
	removeWorkspaceEntry,
	renameWorkspaceEntry,
	resolveUnderWorkspace,
	SidebarError,
	searchWorkspaceFiles,
	toWirePath,
	writeWorkspaceFile,
} from "../sidebar-fs.ts";
import {
	gitCommit,
	gitCommitDetail,
	gitCommitDiff,
	gitDiff,
	gitDiscard,
	gitHistory,
	gitLog,
	gitPush,
	gitStage,
	gitStatus,
	gitUnstage,
} from "../sidebar-git.ts";
import { githubCommitChecks } from "../sidebar-github.ts";
import { createDirectoryWatchers, createGitStateWatcher, type DirectoryWatchers } from "../sidebar-watch.ts";

export interface WorkspaceHandlerContext {
	defaultAgentDir: () => string;
	reply: (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;
	onDiagnostic: (message: string) => void;
	broadcast: (message: DesktopServerMessage) => void;
	sidebarWatchers: Map<string, DirectoryWatchers>;
	viewerRequests: WeakMap<WebSocket, Set<AbortController>>;
}

/** Project 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type ProjectRequest = Extract<DesktopClientRequest, { type: "project.create" }>;

export async function handleProjectRequest(
	ws: WebSocket,
	request: ProjectRequest,
	ctx: WorkspaceHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "project.create": {
			// 新建/打开项目目录：mkdir -p 后返回规范绝对路径，前端拿它当 session.create 的 cwd。
			const raw = request.path?.trim();
			if (!raw || !isAbsolute(expandTildePath(raw))) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: "需要绝对路径，例如 D:\\mycode\\new-project（支持 ~ 前缀）",
				});
				return;
			}
			try {
				const path = resolve(expandTildePath(raw));
				mkdirSync(path, { recursive: true });
				ctx.reply(ws, request.id, { ok: true, result: { path } });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: `无法创建目录：${error instanceof Error ? error.message : String(error)}`,
				});
			}
			return;
		}
	}
}

/** Fs 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type FsRequest = Extract<
	DesktopClientRequest,
	{ type: `fs.${string}` | `editor.${string}` | "viewer.list" | "viewer.open" }
>;

export async function handleFsRequest(ws: WebSocket, request: FsRequest, ctx: WorkspaceHandlerContext): Promise<void> {
	if (request.type.startsWith("editor.")) {
		const editor = request as Extract<FsRequest, { type: `editor.${string}` }>;
		const agentDir = ctx.defaultAgentDir();
		const profile = editorPathKey(canonicalEditorWorkspace(agentDir));
		const assertProfile = (): void => {
			if (
				!editor.expectedProfile ||
				editorPathKey(canonicalEditorWorkspace(editor.expectedProfile)) !== profile ||
				editorPathKey(canonicalEditorWorkspace(ctx.defaultAgentDir())) !== profile
			) {
				throw new SidebarError("profile-changed", "账号已变化，未读取或写入其他账号的编辑材料");
			}
		};
		assertProfile();
		const drafts = new EditorDraftStore(agentDir, assertProfile);
		switch (editor.type) {
			case "editor.file.save": {
				const absolute = await resolveUnderWorkspace(editor.cwd, editor.path);
				assertProfile();
				const result = await saveEditorFile(
					editor.cwd,
					absolute,
					editor.content,
					editor.expectedRevision,
					assertProfile,
				);
				if (result.status === "saved") invalidateDirectoryCache(dirname(absolute));
				ctx.reply(ws, editor.id, { ok: true, result });
				return;
			}
			case "editor.draft.get":
				ctx.reply(ws, editor.id, { ok: true, result: drafts.get(editor.cwd, editor.path) });
				return;
			case "editor.draft.put":
				ctx.reply(ws, editor.id, { ok: true, result: drafts.put(editor) });
				return;
			case "editor.draft.remove":
				ctx.reply(ws, editor.id, {
					ok: true,
					result: drafts.remove(editor.cwd, editor.path, editor.expectedDraftRevision),
				});
				return;
			case "editor.draft.list":
				ctx.reply(ws, editor.id, { ok: true, result: drafts.list(editor.cwd) });
				return;
		}
	}
	switch (request.type) {
		case "fs.tree": {
			ctx.reply(ws, request.id, { ok: true, result: await listWorkspaceDirectory(request.cwd, request.path ?? "") });
			return;
		}
		case "viewer.list": {
			ctx.reply(ws, request.id, { ok: true, result: { viewers: listWorkspaceViewers() } });
			return;
		}
		case "viewer.open": {
			const controller = new AbortController();
			const pending = ctx.viewerRequests.get(ws) ?? new Set<AbortController>();
			ctx.viewerRequests.set(ws, pending);
			pending.add(controller);
			try {
				const result = await openWorkspaceViewer(request.viewerId, {
					cwd: request.cwd,
					path: request.path,
					signal: controller.signal,
				});
				ctx.reply(ws, request.id, { ok: true, result });
			} finally {
				pending.delete(controller);
			}
			return;
		}
		case "fs.read": {
			ctx.reply(ws, request.id, { ok: true, result: await readWorkspaceFile(request.cwd, request.path) });
			return;
		}
		case "fs.stat": {
			const absolute = await resolveUnderWorkspace(request.cwd, request.path);
			const info = await stat(absolute);
			await access(absolute, constants.R_OK);
			ctx.reply(ws, request.id, {
				ok: true,
				result: { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() },
			});
			return;
		}
		case "fs.readBin": {
			ctx.reply(ws, request.id, { ok: true, result: await readWorkspaceFileBinary(request.cwd, request.path) });
			return;
		}
		case "fs.write": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: await writeWorkspaceFile(request.cwd, request.path, request.content),
			});
			return;
		}
		case "fs.mkdir": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: await mkdirWorkspaceEntry(request.cwd, request.path, request.name),
			});
			return;
		}
		case "fs.rename": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: await renameWorkspaceEntry(request.cwd, request.path, request.name),
			});
			return;
		}
		case "fs.remove": {
			ctx.reply(ws, request.id, { ok: true, result: await removeWorkspaceEntry(request.cwd, request.path) });
			return;
		}
		case "fs.search": {
			ctx.reply(ws, request.id, { ok: true, result: await searchWorkspaceFiles(request.cwd, request.query) });
			return;
		}
	}
}

/** Git 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type GitRequest = Extract<DesktopClientRequest, { type: `git.${string}` }>;

export async function handleGitRequest(
	ws: WebSocket,
	request: GitRequest,
	ctx: WorkspaceHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "git.status": {
			ctx.reply(ws, request.id, { ok: true, result: await gitStatus(request.cwd) });
			return;
		}
		case "git.diff": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: { diff: await gitDiff(request.cwd, request.path, request.staged === true) },
			});
			return;
		}
		case "git.stage": {
			await gitStage(request.cwd, request.paths);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "git.unstage": {
			await gitUnstage(request.cwd, request.paths);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "git.commit": {
			await gitCommit(request.cwd, request.message, request.repo);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "git.discard": {
			await gitDiscard(request.cwd, request.path);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "git.log": {
			ctx.reply(ws, request.id, { ok: true, result: await gitLog(request.cwd, request.count) });
			return;
		}
		case "git.history": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: await gitHistory(request.cwd, {
					repo: request.repo,
					all: request.all,
					skip: request.skip,
					count: request.count,
				}),
			});
			return;
		}
		case "git.show": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: await gitCommitDetail(request.cwd, request.hash, request.repo),
			});
			return;
		}
		case "git.showDiff": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: {
					diff: await gitCommitDiff(request.cwd, request.hash, request.paths, request.against, request.repo),
				},
			});
			return;
		}
		case "git.push": {
			await gitPush(request.cwd, request.repo);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "git.checks": {
			ctx.reply(ws, request.id, {
				ok: true,
				result: await githubCommitChecks(request.cwd, request.hashes, request.repo),
			});
			return;
		}
	}
}

/** Watch 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type WatchRequest = Extract<DesktopClientRequest, { type: "watch.set" | "open.external" }>;

/**
 * 启动系统处理器（explorer / 协议处理器）。
 *
 * 实测（Windows 11 + explorer）：windowsHide: true 会让 explorer /select 建出 visible=false
 * 的窗口——进程正常退出、应答成功，用户却看不到任何窗口（旧的隐藏窗口还会越积越多）。
 * 本函数只会用来“让用户看到点什么”，必须保持窗口可见，别再加回 windowsHide: true。
 */
async function spawnExternalHandler(command: string, args: string[]): Promise<void> {
	await new Promise<void>((done, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			done();
		});
	});
}

export async function handleWatchRequest(
	ws: WebSocket,
	request: WatchRequest,
	ctx: WorkspaceHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "watch.set": {
			// watcher 集按项目归一（resolve 后的绝对路径做 key）；replace 语义
			// 由 add/remove 差分实现，避免每次展开/收起都重建全部句柄。
			const key = resolve(request.cwd);
			let watchers = ctx.sidebarWatchers.get(key);
			if (watchers === undefined) {
				const report = (target: string, error: unknown): void => {
					ctx.onDiagnostic(`sidebar watch ${target}: ${error instanceof Error ? error.message : String(error)}`);
				};
				const directories = createDirectoryWatchers((dir) => {
					ctx.broadcast({
						type: "event",
						sessionId: "",
						event: { type: "fs_changed", cwd: key, dirs: [toWirePath(key, dir)] },
					});
				}, report);
				const gitState = createGitStateWatcher(
					key,
					() => ctx.broadcast({ type: "event", sessionId: "", event: { type: "git_changed", cwd: key } }),
					report,
				);
				watchers = {
					...directories,
					close() {
						directories.close();
						gitState.close();
					},
				};
				ctx.sidebarWatchers.set(key, watchers);
			}
			const wanted = new Set<string>();
			for (const relativeDir of request.dirs.slice(0, 64)) {
				await resolveUnderWorkspace(request.cwd, relativeDir)
					.then((absolute) => wanted.add(absolute))
					.catch(() => {});
			}
			for (const dir of watchers.dirs()) {
				if (!wanted.has(dir)) watchers.remove(dir);
			}
			for (const dir of wanted) {
				watchers.add(dir);
			}
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "open.external": {
			if (request.action === "reveal") {
				// workspace 相对路径 → 围栏解析成绝对路径，文件管理器定位。
				const base = request.cwd ?? process.cwd();
				const absolute = await resolveUnderWorkspace(base, request.target);
				const info = await stat(absolute);
				await access(absolute, constants.R_OK);
				const command =
					process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
				const args =
					process.platform === "darwin"
						? ["-R", absolute]
						: process.platform === "win32"
							? [`/select,${absolute}`]
							: [info.isDirectory() ? absolute : dirname(absolute)];
				await spawnExternalHandler(command, args);
			} else {
				// 自定义协议（vscode:// 等）白名单后交给系统处理器；argv 直传不落 shell。
				const allowed = new Set(["vscode:", "cursor:", "zed:", "file:", "http:", "https:"]);
				const parsed = new URL(request.target);
				if (!allowed.has(parsed.protocol)) {
					throw new SidebarError("bad-request", `不允许的协议：${parsed.protocol}`);
				}
				const command =
					process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
				await spawnExternalHandler(
					command,
					process.platform === "win32" ? ["url.dll,FileProtocolHandler", request.target] : [request.target],
				);
			}
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
	}
}
