import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
	handleFsRequest,
	handleWatchRequest,
	type WorkspaceHandlerContext,
} from "../src/modes/desktop/handlers/workspace.ts";

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async () => ({
	...(await vi.importActual<typeof ChildProcessModule>("node:child_process")),
	spawn: processMock.spawn,
}));
let root: string;
let ctx: WorkspaceHandlerContext;
const ws = {} as WebSocket;
beforeEach(async () => {
	root = resolve(await mkdtemp(join(tmpdir(), "owl-artifact-metadata-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-artifact-metadata-"))
		throw new Error("Unsafe test workspace");
	ctx = {
		defaultAgentDir: () => root,
		reply: vi.fn(),
		onDiagnostic: vi.fn(),
		broadcast: vi.fn(),
		sidebarWatchers: new Map(),
		viewerRequests: new WeakMap(),
	};
	processMock.spawn.mockReset().mockImplementation(() => {
		const child = new EventEmitter() as ChildProcess;
		child.unref = () => {};
		queueMicrotask(() => child.emit("spawn"));
		return child;
	});
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});
describe("artifact metadata and reveal acknowledgements", () => {
	it("checks a large binary file without reading or decoding its contents", async () => {
		await writeFile(join(root, "large.bin"), Buffer.alloc(2_000_000, 0));
		await handleFsRequest(ws, { type: "fs.stat", id: "stat", cwd: root, path: "large.bin" }, ctx);
		expect(ctx.reply).toHaveBeenCalledWith(ws, "stat", {
			ok: true,
			result: { size: 2_000_000, isFile: true, isDirectory: false },
		});
	});
	it("distinguishes directories and rejects missing or escaping paths", async () => {
		await mkdir(join(root, "folder"));
		await handleFsRequest(ws, { type: "fs.stat", id: "dir", cwd: root, path: "folder" }, ctx);
		expect(ctx.reply).toHaveBeenCalledWith(
			ws,
			"dir",
			expect.objectContaining({ result: expect.objectContaining({ isFile: false, isDirectory: true }) }),
		);
		await expect(
			handleFsRequest(ws, { type: "fs.stat", id: "missing", cwd: root, path: "missing.md" }, ctx),
		).rejects.toThrow();
		await expect(
			handleFsRequest(ws, { type: "fs.stat", id: "escape", cwd: root, path: "../outside.md" }, ctx),
		).rejects.toThrow();
	});
	it("does not open a file manager or claim success when a result was deleted", async () => {
		await expect(
			handleWatchRequest(
				ws,
				{ type: "open.external", id: "reveal", cwd: root, target: "deleted.md", action: "reveal" },
				ctx,
			),
		).rejects.toThrow();
		expect(processMock.spawn).not.toHaveBeenCalled();
		expect(ctx.reply).not.toHaveBeenCalled();
	});
	it("reports a launch failure and sends no successful acknowledgement", async () => {
		await writeFile(join(root, "result.md"), "delivered");
		processMock.spawn.mockImplementation(() => {
			const child = new EventEmitter() as ChildProcess;
			queueMicrotask(() => child.emit("error", new Error("file manager unavailable")));
			return child;
		});
		await expect(
			handleWatchRequest(
				ws,
				{ type: "open.external", id: "failed", cwd: root, target: "result.md", action: "reveal" },
				ctx,
			),
		).rejects.toThrow("file manager unavailable");
		expect(ctx.reply).not.toHaveBeenCalled();
	});
	it("acknowledges only after the file manager process has spawned", async () => {
		await writeFile(join(root, "result.md"), "delivered");
		await handleWatchRequest(
			ws,
			{ type: "open.external", id: "ok", cwd: root, target: "result.md", action: "reveal" },
			ctx,
		);
		expect(processMock.spawn).toHaveBeenCalledOnce();
		expect(ctx.reply).toHaveBeenCalledWith(ws, "ok", { ok: true });
	});
	it("keeps the file manager window visible instead of hiding it", async () => {
		// windowsHide: true 在 Windows 上会让 explorer /select 建出 visible=false 的窗口：
		// 进程退出码 0、应答成功，用户却看不到任何窗口。定位必须显式关闭隐藏。
		await writeFile(join(root, "result.md"), "delivered");
		await handleWatchRequest(
			ws,
			{ type: "open.external", id: "visible", cwd: root, target: "result.md", action: "reveal" },
			ctx,
		);
		const command = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
		expect(processMock.spawn).toHaveBeenCalledWith(
			command,
			process.platform === "win32"
				? [`/select,${join(root, "result.md")}`]
				: process.platform === "darwin"
					? ["-R", join(root, "result.md")]
					: [join(root, "result.md")],
			{ detached: true, stdio: "ignore", windowsHide: false },
		);
	});
	it("does not acknowledge an external URL launch until the system handler spawns", async () => {
		const child = new EventEmitter() as ChildProcess;
		child.unref = vi.fn();
		processMock.spawn.mockReturnValue(child);
		const opening = handleWatchRequest(
			ws,
			{ type: "open.external", id: "url", action: "url", target: "file:///D:/report.pdf" },
			ctx,
		);
		expect(ctx.reply).not.toHaveBeenCalled();
		expect(child.unref).not.toHaveBeenCalled();
		child.emit("spawn");
		await opening;
		expect(ctx.reply).toHaveBeenCalledWith(ws, "url", { ok: true });
		expect(child.unref).toHaveBeenCalledOnce();
		const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
		expect(processMock.spawn).toHaveBeenCalledWith(
			command,
			process.platform === "win32"
				? ["url.dll,FileProtocolHandler", "file:///D:/report.pdf"]
				: ["file:///D:/report.pdf"],
			{ detached: true, stdio: "ignore", windowsHide: false },
		);
	});

	it("propagates a URL handler launch failure without a successful acknowledgement", async () => {
		processMock.spawn.mockImplementation(() => {
			const child = new EventEmitter() as ChildProcess;
			queueMicrotask(() => child.emit("error", new Error("system handler not installed")));
			return child;
		});
		await expect(
			handleWatchRequest(
				ws,
				{ type: "open.external", id: "url-failed", action: "url", target: "https://example.com/" },
				ctx,
			),
		).rejects.toThrow("system handler not installed");
		expect(ctx.reply).not.toHaveBeenCalled();
	});

	it("keeps the external protocol allowlist before launching a handler", async () => {
		await expect(
			handleWatchRequest(
				ws,
				{ type: "open.external", id: "unsafe", action: "url", target: "javascript:alert(1)" },
				ctx,
			),
		).rejects.toThrow("不允许的协议");
		expect(processMock.spawn).not.toHaveBeenCalled();
	});
});
