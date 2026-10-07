import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentSession } from "../src/core/agent-session.ts";
import type { DesktopClientRequestWithoutId, ServerResponseMessage } from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

// Agent 预设走真实桥挂载（mountSession 解析 + setActiveToolsByName 应用），不进 provider 请求。
const applyTools = vi.spyOn(AgentSession.prototype, "setActiveToolsByName");

let bridge: DesktopServerHandle | undefined;
let socket: WebSocket | undefined;
let cleanupRoot: string | undefined;

afterEach(async () => {
	applyTools.mockClear();
	socket?.close();
	socket = undefined;
	await bridge?.close().catch(() => {});
	bridge = undefined;
	// 桥全关后再清目录（Windows 上 news.sqlite 句柄释放晚于用例体）
	if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
	cleanupRoot = undefined;
});

function connect(port: number): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	return new Promise((done, reject) => {
		ws.once("open", () => done(ws));
		ws.once("error", reject);
	});
}

function request(
	ws: WebSocket,
	request: DesktopClientRequestWithoutId,
): Promise<Extract<ServerResponseMessage, { ok: boolean }>> {
	const id = request.type + ":" + randomUUID();
	return new Promise((done, reject) => {
		const onMessage = (data: string): void => {
			const message = JSON.parse(data) as ServerResponseMessage;
			if (message.type === "response" && message.id === id) {
				ws.off("message", onMessage);
				done(message);
			}
		};
		ws.on("message", onMessage);
		ws.once("error", reject);
		ws.send(JSON.stringify({ ...request, id }));
	});
}

it("bridge serves the preset roster, default selection and per-session preset application", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-agent-presets-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-agent-presets-")) {
		throw new Error("Unsafe agent presets cleanup target");
	}
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	cleanupRoot = root;
	try {
		bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
		socket = await connect(bridge.port);
		const ws = socket;

		// 花名册：内置四预设 + 默认 standard
		const list = await request(ws, { type: "preset.list" });
		expect(list.ok).toBe(true);
		const roster = list.result as { presets: { id: string }[]; defaultPreset: string };
		const names = roster.presets.map((preset) => preset.id);
		expect(names).toEqual(["standard", "ptc", "minimal", "cordis"]);

		// minimal 会话：工具集被替换成终端三件套，快照记录绑定
		const created = await request(ws, { type: "session.create", agentPreset: "minimal" });
		expect(created.ok).toBe(true);
		const snapshot = created.result as { sessionId: string; agentPreset?: string };
		expect(snapshot.agentPreset).toBe("minimal");
		expect(applyTools).toHaveBeenCalled();
		const minimalCall = applyTools.mock.calls.find(
			(call) => JSON.stringify(call[0]) === JSON.stringify(["read", "bash", "edit"]),
		);
		expect(minimalCall).toBeDefined();

		// ptc 会话：默认工具集 + codemode
		const ptcSession = await request(ws, { type: "session.create", agentPreset: "ptc" });
		expect(ptcSession.ok).toBe(true);
		const ptcSnapshot = ptcSession.result as { sessionId: string; agentPreset?: string };
		expect(ptcSnapshot.agentPreset).toBe("ptc");
		const ptcCall = applyTools.mock.calls.find((call) => (call[0] as string[]).includes("codemode"));
		expect(ptcCall).toBeDefined();

		// 未知预设 id：回退默认（standard），不抛错
		const ghost = await request(ws, { type: "session.create", agentPreset: "ghost" });
		expect(ghost.ok).toBe(true);
		expect((ghost.result as { agentPreset?: string }).agentPreset).toBe("standard");

		// 自定义预设：保存后可被会话引用，再删除
		const saved = await request(ws, {
			type: "preset.save",
			preset: {
				id: "test-ops",
				name: "冒烟助手",
				description: "",
				builtin: false,
				order: 100,
				tools: ["+codemode"],
			},
		});
		expect(saved.ok).toBe(true);
		const customSession = await request(ws, { type: "session.create", agentPreset: "test-ops" });
		expect((customSession.result as { agentPreset?: string }).agentPreset).toBe("test-ops");
		const removed = await request(ws, { type: "preset.delete", agentPreset: "test-ops" });
		expect(removed.ok).toBe(true);

		// 默认预设切换进花名册响应
		const setDefault = await request(ws, { type: "preset.setDefault", agentPreset: "minimal" });
		expect(setDefault.ok).toBe(true);
		const relist = await request(ws, { type: "preset.list" });
		expect((relist.result as { defaultPreset: string }).defaultPreset).toBe("minimal");
	} catch (error) {
		cleanupRoot = undefined;
		await rm(root, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
});
