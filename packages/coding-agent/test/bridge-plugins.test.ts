import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { importExtensionRuntimeModule } from "../src/core/extensions/loader.ts";
import {
	type BridgePluginContext,
	bridgePluginSessionTools,
	bridgeRequestRoutes,
	closeBridgePlugins,
	handleBridgePluginHttp,
	type LoadedBridgePlugin,
	loadBridgePlugins,
} from "../src/modes/desktop/bridge-plugins.ts";
import { collectUsageStats } from "../src/modes/desktop/usage-stats.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../src/utils/atomic-file.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "owl-bridge-plugins-"));
	roots.push(root);
	return root;
}

function writePlugin(dir: string, owl: unknown, files: Record<string, string>): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: dir.split(/[\\/]/).pop(), owl }));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

function context(agentDir: string, diagnostics: string[]): BridgePluginContext {
	return {
		agentDir,
		isTrustedOrigin: () => true,
		getGlobalSetting: async () => undefined,
		onDiagnostic: (message) => diagnostics.push(message),
		broadcast: () => {},
		sessionDirFor: (cwd) => join(agentDir, "sessions", cwd),
		collectUsageStats,
		files: { atomicWriteFileSync, backupCorruptFile, withFileLockSync },
	};
}

function fakeResponse() {
	const state = { status: 0, body: "", headersSent: false };
	const response = {
		get headersSent() {
			return state.headersSent;
		},
		writeHead(status: number) {
			state.status = status;
			state.headersSent = true;
			return response;
		},
		end(body?: string) {
			state.body = body ?? "";
			return response;
		},
	};
	return { state, response: response as unknown as ServerResponse };
}

describe("loadBridgePlugins", () => {
	it("只加载 owl.bridge 声明的入口，跳过禁用、远程和只有会话扩展的插件", async () => {
		const root = tempRoot();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writePlugin(
			join(root, "wall"),
			{ bridge: ["./bridge.ts"] },
			{
				"bridge.ts": "export default (ctx: { agentDir: string }) => ({ name: ctx.agentDir });\n",
			},
		);
		writePlugin(
			join(agentDir, "vendor", "rel"),
			{ bridge: ["./bridge.mjs"] },
			{
				"bridge.mjs": "export default () => ({});\n",
			},
		);
		writePlugin(join(root, "off"), { bridge: ["./bridge.mjs"] }, { "bridge.mjs": "throw new Error('loaded');\n" });
		writePlugin(
			join(root, "session-only"),
			{ extensions: ["./index.ts"] },
			{ "index.ts": "export default () => {};\n" },
		);

		const diagnostics: string[] = [];
		const loaded = await loadBridgePlugins(
			[
				join(root, "wall"),
				"vendor/rel",
				{ source: join(root, "off"), disabled: true },
				join(root, "session-only"),
				"npm:owl-anything",
				join(root, "missing"),
			],
			context(agentDir, diagnostics),
			importExtensionRuntimeModule,
		);

		expect(loaded.map((entry) => entry.name)).toEqual(["wall", "rel"]);
		expect(diagnostics).toEqual([]);
	});

	it("单个插件加载失败只记诊断，其余照常加载", async () => {
		const root = tempRoot();
		writePlugin(join(root, "broken"), { bridge: ["./bridge.mjs"] }, { "bridge.mjs": "throw new Error('boom');\n" });
		writePlugin(join(root, "nofactory"), { bridge: ["./bridge.mjs"] }, { "bridge.mjs": "export default 42;\n" });
		writePlugin(join(root, "ok"), { bridge: ["./bridge.mjs"] }, { "bridge.mjs": "export default () => ({});\n" });

		const diagnostics: string[] = [];
		const loaded = await loadBridgePlugins(
			[join(root, "broken"), join(root, "nofactory"), join(root, "ok")],
			context(root, diagnostics),
			importExtensionRuntimeModule,
		);

		expect(loaded.map((entry) => entry.name)).toEqual(["ok"]);
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0]).toContain("boom");
		expect(diagnostics[1]).toContain("没有默认导出工厂函数");
	});
});

describe("handleBridgePluginHttp", () => {
	const request = {} as IncomingMessage;

	it("按顺序分发，第一个认领的插件生效", async () => {
		const seen: string[] = [];
		const claim = (name: string, handled: boolean): LoadedBridgePlugin => ({
			name,
			plugin: {
				handleHttp: async () => {
					seen.push(name);
					return handled;
				},
			},
		});
		const plugins = [claim("skip", false), claim("take", true), claim("never", true)];
		const { response } = fakeResponse();
		expect(await handleBridgePluginHttp(plugins, request, response, () => {})).toBe(true);
		expect(seen).toEqual(["skip", "take"]);
	});

	it("无人认领时交还分发链", async () => {
		const { response } = fakeResponse();
		const plugins: LoadedBridgePlugin[] = [
			{ name: "a", plugin: { handleHttp: async () => false } },
			{ name: "b", plugin: {} },
		];
		expect(await handleBridgePluginHttp(plugins, request, response, () => {})).toBe(false);
	});

	it("插件抛错时回 500 并记诊断", async () => {
		const diagnostics: string[] = [];
		const { state, response } = fakeResponse();
		const plugins: LoadedBridgePlugin[] = [
			{
				name: "bad",
				plugin: {
					handleHttp: async () => {
						throw new Error("kaput");
					},
				},
			},
		];
		expect(await handleBridgePluginHttp(plugins, request, response, (message) => diagnostics.push(message))).toBe(
			true,
		);
		expect(state.status).toBe(500);
		expect(diagnostics[0]).toContain("kaput");
	});
});

describe("bridgeRequestRoutes", () => {
	it("按类型建路由，重复认领时先加载的生效并记诊断", async () => {
		const diagnostics: string[] = [];
		const routes = bridgeRequestRoutes(
			[
				{ name: "career", plugin: { requests: { "career.get": () => "first" } } },
				{ name: "life", plugin: { requests: { "life.probe": () => "life", "career.get": () => "second" } } },
				{ name: "http-only", plugin: {} },
			],
			(message) => diagnostics.push(message),
		);
		expect([...routes.keys()].sort()).toEqual(["career.get", "life.probe"]);
		expect(await routes.get("career.get")?.({ type: "career.get", id: "1" }, { origin: undefined })).toBe("first");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("career.get");
	});
});

describe("bridgePluginSessionTools", () => {
	const tool = (name: string) => ({ name }) as ToolDefinition;

	it("按加载顺序汇总，插件拿到会话 id 与 cwd；某个插件抛错只跳过它", async () => {
		const seen: unknown[] = [];
		const diagnostics: string[] = [];
		const tools = await bridgePluginSessionTools(
			[
				{
					name: "map",
					plugin: {
						sessionTools: (session) => {
							seen.push(session);
							return [tool("map_search"), tool("map_nearby")];
						},
					},
				},
				{
					name: "bad",
					plugin: {
						sessionTools: async () => {
							throw new Error("no tools");
						},
					},
				},
				{ name: "http-only", plugin: {} },
				{ name: "mail", plugin: { sessionTools: async () => [tool("mail_read")] } },
			],
			{ sessionId: "s1", cwd: "/work" },
			(message) => diagnostics.push(message),
		);
		expect(tools.map((entry) => entry.name)).toEqual(["map_search", "map_nearby", "mail_read"]);
		expect(seen).toEqual([{ sessionId: "s1", cwd: "/work" }]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("no tools");
	});
});

describe("closeBridgePlugins", () => {
	it("逐个关闭，某个失败不影响其他", async () => {
		const closed: string[] = [];
		const diagnostics: string[] = [];
		await closeBridgePlugins(
			[
				{
					name: "bad",
					plugin: {
						close: () => {
							throw new Error("stuck");
						},
					},
				},
				{ name: "good", plugin: { close: async () => void closed.push("good") } },
			],
			(message) => diagnostics.push(message),
		);
		expect(closed).toEqual(["good"]);
		expect(diagnostics[0]).toContain("stuck");
	});
});
