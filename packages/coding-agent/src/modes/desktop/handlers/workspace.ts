/**
 * owl desktop bridge — workspace 域 handler（fs / git / watch+open / project）。
 *
 * 从 serve.ts 的 handleRequest 分组原样搬迁：共享闭包（reply / onDiagnostic /
 * broadcast / sidebarWatchers / viewerRequests）改为显式上下文注入，逻辑零改动。
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { WebSocket } from "ws";
import { expandTildePath } from "../../../config.ts";
import { listWorkspaceViewers, openWorkspaceViewer } from "../../../core/workspace-viewers.ts";
import type { DesktopClientRequest, DesktopServerMessage } from "../protocol.ts";
import {
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
import { gitCommit, gitDiff, gitDiscard, gitLog, gitStage, gitStatus, gitUnstage } from "../sidebar-git.ts";
import { createDirectoryWatchers, type DirectoryWatchers } from "../sidebar-watch.ts";

export interface WorkspaceHandlerContext {
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
export type FsRequest = Extract<DesktopClientRequest, { type: `fs.${string}` | "viewer.list" | "viewer.open" }>;

export async function handleFsRequest(ws: WebSocket, request: FsRequest, ctx: WorkspaceHandlerContext): Promise<void> {
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
	}
}

/** Watch 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type WatchRequest = Extract<DesktopClientRequest, { type: "watch.set" | "open.external" }>;

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
				watchers = createDirectoryWatchers(
					(dir) => {
						ctx.broadcast({
							type: "event",
							sessionId: "",
							event: { type: "fs_changed", cwd: key, dirs: [toWirePath(key, dir)] },
						});
					},
					(dir, error) => {
						ctx.onDiagnostic(`sidebar watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
					},
				);
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
				if (process.platform === "darwin") {
					spawn("open", ["-R", absolute], { detached: true, stdio: "ignore" }).unref();
				} else if (process.platform === "win32") {
					spawn("explorer", [`/select,${absolute}`], { detached: true, stdio: "ignore" }).unref();
				} else {
					spawn("xdg-open", [absolute], { detached: true, stdio: "ignore" }).unref();
				}
			} else {
				// 自定义协议（vscode:// 等）白名单后交给系统处理器；argv 直传不落 shell。
				const allowed = new Set(["vscode:", "cursor:", "zed:", "file:", "http:", "https:"]);
				const parsed = new URL(request.target);
				if (!allowed.has(parsed.protocol)) {
					throw new SidebarError("bad-request", `不允许的协议：${parsed.protocol}`);
				}
				spawn("rundll32", ["url.dll,FileProtocolHandler", request.target], {
					detached: true,
					stdio: "ignore",
				}).unref();
			}
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
	}
}
