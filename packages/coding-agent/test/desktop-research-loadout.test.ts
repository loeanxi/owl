import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
	BUILTIN_AGENT_PRESETS,
	getSessionPresetId,
	resolvePresetAppendPrompt,
	setSessionPresetEntry,
} from "../src/core/agent-presets.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { getResearchMode, RESEARCH_MODE_ENTRY } from "../src/core/research/agent.ts";
import { RESEARCH_CHECKPOINT_TOOL } from "../src/core/research/checkpoint.ts";
import { RESEARCH_REA_TOOL } from "../src/core/research/rea-tools.ts";
import { researchToolLoadout } from "../src/core/research/tool-loadout.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";
import { DesktopPermissionQueue } from "../src/modes/desktop/permission-queue.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerResponseMessage,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";
import * as toolManager from "../src/utils/tools-manager.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("permits only the checkpoint ledger addition without granting external model or file side effects in plan mode", () => {
	for (const action of ["save", "read"])
		expect(isReadOnlyDesktopTool(RESEARCH_CHECKPOINT_TOOL, { action })).toBe(true);
	for (const [name, input] of [
		["research_model_lab", { action: "run" }],
		["research_decompile", { action: "decompile" }],
		["research_rea", { action: "native_overview" }],
		["write", { path: "fixture.txt", content: "not executed" }],
	] as const)
		expect(isReadOnlyDesktopTool(name, input)).toBe(false);
});

it.each([
	{
		name: "a replaced default tool list",
		settings: { defaultTools: ["read", "bash"] },
		expectedPreset: "standard",
		explicitPreset: undefined,
		staticAnalysis: true,
	},
	{
		name: "the Home minimal default",
		settings: { owlDefaultPreset: "minimal" },
		expectedPreset: "minimal",
		explicitPreset: undefined,
		staticAnalysis: false,
	},
	{
		name: "the Home PTC default",
		settings: { owlDefaultPreset: "ptc" },
		expectedPreset: "ptc",
		explicitPreset: undefined,
		staticAnalysis: true,
	},
	{
		name: "the Home creator default",
		settings: { owlDefaultPreset: "cordis" },
		expectedPreset: "cordis",
		explicitPreset: undefined,
		staticAnalysis: true,
	},
	{
		name: "the Home custom default",
		settings: { owlDefaultPreset: "research-fixture" },
		expectedPreset: "research-fixture",
		explicitPreset: undefined,
		staticAnalysis: false,
	},
	{
		name: "the incompatible Home Pi default",
		settings: { owlDefaultPreset: "pi" },
		expectedPreset: "standard",
		explicitPreset: undefined,
		staticAnalysis: false,
	},
	{
		name: "an explicit PTC selection over the Home minimal default",
		settings: { owlDefaultPreset: "minimal" },
		expectedPreset: "ptc",
		explicitPreset: "ptc",
		staticAnalysis: false,
	},
])(
	"keeps combined research tools active with $name, reload and historical resume",
	async ({ settings, expectedPreset, explicitPreset, staticAnalysis }) => {
		const root = resolve(await mkdtemp(join(tmpdir(), "owl-research-loadout-")));
		if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-loadout-")) {
			throw new Error("Unsafe research loadout cleanup target");
		}
		const agentDir = join(root, "profile");
		const cwd = join(root, "workspace");
		await mkdir(agentDir);
		await mkdir(cwd);
		const savedSettings = { plugins: [], cacheWarming: "off", ...settings };
		await writeFile(join(agentDir, "settings.json"), JSON.stringify(savedSettings));
		await mkdir(join(agentDir, "presets"));
		await writeFile(
			join(agentDir, "presets", "research-fixture.json"),
			JSON.stringify({
				id: "research-fixture",
				name: "Research fixture",
				description: "Offline custom preset",
				builtin: false,
				order: 100,
				tools: ["read"],
				appendPrompt: "<research_fixture_preset>Fixture {{agentDir}}</research_fixture_preset>",
			}),
		);
		await writeFile(
			join(agentDir, "presets", "pi-fixture.json"),
			JSON.stringify({
				id: "pi-fixture",
				name: "Pi fixture",
				description: "Offline Pi copy",
				builtin: false,
				order: 101,
				runtime: "pi",
				tools: ["read", "bash", "edit", "write"],
			}),
		);
		vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
		vi.spyOn(toolManager, "ensureTool").mockResolvedValue(undefined);
		const noFetch = vi.fn<typeof fetch>(async () => {
			throw new Error("External requests forbidden in research loadout tests");
		});
		vi.stubGlobal("fetch", noFetch);
		const observed = new Map<string, { session: AgentSession; snapshots: string[][] }>();
		const permission = vi.spyOn(DesktopPermissionQueue.prototype, "request").mockResolvedValue(false);
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
			this: AgentSession,
			message,
			options,
		) {
			if (message === "reload" || message === "reload blank") await this.reload();
			if (message === "discover browser") {
				this.setActiveToolsByName([...this.getActiveToolNames(), "browser_network"]);
			}
			const sessionId = this.sessionManager.getSessionId();
			const record = observed.get(sessionId) ?? { session: this, snapshots: [] };
			record.session = this;
			record.snapshots.push(this.getActiveToolNames());
			observed.set(sessionId, record);
			if (message !== "inspect blank" && message !== "reload blank")
				this.sessionManager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
			options?.preflightResult?.("handled");
		});
		let bridge: DesktopServerHandle | undefined;
		const sockets: WebSocket[] = [];
		async function start() {
			return startDesktopServer({
				port: 0,
				agentDir,
				cwd,
				mcpServers: {},
				onDiagnostic: () => {},
				news: {
					fetch: noFetch,
					listModels: () => [],
					callModel: async () => {
						throw new Error("Model calls forbidden");
					},
					resolveModel: async () => {
						throw new Error("Model calls forbidden");
					},
				},
			});
		}
		async function connect(handle: DesktopServerHandle): Promise<WebSocket> {
			const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
			sockets.push(socket);
			await new Promise<void>((done, reject) => {
				socket.once("open", done);
				socket.once("error", reject);
			});
			return socket;
		}
		function request<T>(
			socket: WebSocket,
			payload: DesktopClientRequestWithoutId,
		): Promise<ServerResponseMessage & { result?: T }> {
			const id = randomUUID();
			return new Promise((done, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error(`Research loadout request timed out: ${payload.type}`));
				}, 5000);
				const receive = (data: unknown) => {
					const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					socket.off("message", receive);
					done(response);
				};
				socket.on("message", receive);
				socket.send(JSON.stringify({ ...payload, id }));
			});
		}
		async function inspect(socket: WebSocket, sessionId: string, message = "record") {
			const count = observed.get(sessionId)?.snapshots.length ?? 0;
			expect(await request(socket, { type: "session.prompt", sessionId, message })).toMatchObject({ ok: true });
			await vi.waitFor(() => expect(observed.get(sessionId)?.snapshots.length).toBe(count + 1));
			const record = observed.get(sessionId);
			if (!record) throw new Error("Session observation missing");
			return record;
		}
		try {
			bridge = await start();
			const socket = await connect(bridge);
			const ordinary = await request<SessionSnapshotPayload>(socket, { type: "session.create" });
			const ordinaryId = ordinary.result?.sessionId;
			if (!ordinaryId) throw new Error(JSON.stringify(ordinary));
			expect(ordinary.result?.researchMode).toBeUndefined();
			const ordinaryRecord = await inspect(socket, ordinaryId);
			expect(ordinaryRecord.session.getAllTools().map((tool) => tool.name)).not.toContain(RESEARCH_CHECKPOINT_TOOL);
			// 研究工作台专属工具在普通对话里不注册。REA 静态分析由静态分析扩展提供，
			// 但预设收窄工具集时（极简、Pi、显式工具表）同样不可达。
			for (const name of researchToolLoadout([]).filter(
				(name) => name.startsWith("research_") && name !== RESEARCH_REA_TOOL,
			)) {
				expect(ordinaryRecord.session.getAllTools().map((tool) => tool.name)).not.toContain(name);
				expect(ordinaryRecord.snapshots[0]).not.toContain(name);
			}
			expect(
				ordinaryRecord.session
					.getAllTools()
					.map((tool) => tool.name)
					.includes(RESEARCH_REA_TOOL),
			).toBe(staticAnalysis);
			if ("owlDefaultPreset" in settings) {
				expect(ordinary.result?.agentPreset).toBe(settings.owlDefaultPreset);
				if (settings.owlDefaultPreset === "minimal")
					expect(ordinaryRecord.snapshots[0]).toEqual(["read", "bash", "edit"]);
				if (settings.owlDefaultPreset === "pi")
					expect(ordinaryRecord.snapshots[0]).toEqual(["read", "bash", "edit", "write"]);
			} else {
				expect(ordinaryRecord.snapshots[0]).toEqual(["read", "bash"]);
			}
			const research = await request<SessionSnapshotPayload>(socket, {
				type: "session.create",
				researchMode: "auto",
				...(explicitPreset ? { agentPreset: explicitPreset } : {}),
			});
			const id = research.result?.sessionId;
			if (!id) throw new Error(JSON.stringify(research));
			expect(research.result?.agentPreset).toBe(expectedPreset);
			expect(research.result?.approvalMode).toBe("confirm");
			for (const agentPreset of ["pi", "pi-fixture"]) {
				expect(await request(socket, { type: "session.create", researchMode: "auto", agentPreset })).toMatchObject({
					ok: false,
					error: "研究会话需要专属工具，不能切换到 Pi 模式",
				});
				expect(await request(socket, { type: "session.setPreset", sessionId: id, agentPreset })).toMatchObject({
					ok: false,
					error: "研究会话需要专属工具，不能切换到 Pi 模式",
				});
			}
			let blankRecord = await inspect(socket, id, "inspect blank");
			for (const agentPreset of ["ptc", "minimal", "cordis", "research-fixture", "standard"]) {
				const previous = blankRecord.session;
				expect(await request(socket, { type: "session.setPreset", sessionId: id, agentPreset })).toMatchObject({
					ok: true,
					result: { agentPreset },
				});
				blankRecord = await inspect(socket, id, "inspect blank");
				expect(blankRecord.session).not.toBe(previous);
				expect(getSessionPresetId(blankRecord.session.sessionManager)).toBe(agentPreset);
				for (const name of researchToolLoadout([]))
					expect(blankRecord.session.getActiveToolNames()).toContain(name);
				const preset = BUILTIN_AGENT_PRESETS.find((item) => item.id === agentPreset);
				if (preset?.appendPrompt)
					expect(blankRecord.session.systemPrompt).toContain(resolvePresetAppendPrompt(preset, { agentDir }));
				if (agentPreset === "research-fixture") {
					expect(blankRecord.session.systemPrompt).toContain(
						`<research_fixture_preset>Fixture ${agentDir}</research_fixture_preset>`,
					);
					expect(blankRecord.session.getActiveToolNames()).not.toContain("bash");
				}
				if (agentPreset === "standard") {
					expect(blankRecord.session.systemPrompt).not.toContain("<ptc_mode>");
					expect(blankRecord.session.systemPrompt).not.toContain("<minimal_mode>");
					expect(blankRecord.session.systemPrompt).not.toContain("<creator_mode>");
					expect(blankRecord.session.systemPrompt).not.toContain("<research_fixture_preset>");
				}
				await inspect(socket, id, "reload blank");
				for (const name of researchToolLoadout([]))
					expect(blankRecord.session.getActiveToolNames()).toContain(name);
				if (agentPreset === "research-fixture")
					expect(blankRecord.session.getActiveToolNames()).not.toContain("bash");
			}
			const record = await inspect(socket, id);
			expect(record.session.getActiveToolNames()).toContain(RESEARCH_CHECKPOINT_TOOL);
			const checkpointEvent = {
				type: "tool_call" as const,
				toolName: RESEARCH_CHECKPOINT_TOOL,
				toolCallId: "checkpoint-permission-fixture",
				input: {
					action: "save",
					goal: "研究进度审批样本",
					status: "in_progress",
					completed: [],
					findings: [],
					nextActions: [],
					blockers: [],
					evidenceRefs: [],
				},
			};
			expect((await record.session.extensionRunner.emitToolCall(checkpointEvent))?.block).not.toBe(true);
			expect(permission).not.toHaveBeenCalled();
			const writeEvent = {
				type: "tool_call" as const,
				toolName: "write",
				toolCallId: "write-permission-fixture",
				input: { path: "fixture.txt", content: "not executed" },
			};
			expect((await record.session.extensionRunner.emitToolCall(writeEvent))?.block).toBe(true);
			expect(permission).toHaveBeenCalledOnce();
			expect(
				await request(socket, { type: "session.setApprovalMode", sessionId: id, approvalMode: "plan" }),
			).toMatchObject({ ok: true });
			expect((await record.session.extensionRunner.emitToolCall(checkpointEvent))?.block).not.toBe(true);
			expect((await record.session.extensionRunner.emitToolCall(writeEvent))?.block).toBe(true);
			expect(permission).toHaveBeenCalledOnce();
			expect(
				await request(socket, { type: "session.setApprovalMode", sessionId: id, approvalMode: "confirm" }),
			).toMatchObject({ ok: true });
			expect(await request(socket, { type: "session.setPreset", sessionId: id, agentPreset: "ptc" })).toMatchObject({
				ok: false,
				error: "preset-locked",
			});
			for (const name of researchToolLoadout([])) expect(record.snapshots[0]).toContain(name);
			expect(record.session.getAllTools().map((tool) => tool.name)).toContain("browser_network");
			await inspect(socket, id, "discover browser");
			expect(record.session.getActiveToolNames()).toContain("browser_network");
			await inspect(socket, id, "reload");
			for (const name of researchToolLoadout([])) expect(record.session.getActiveToolNames()).toContain(name);
			expect(record.session.getAllTools().map((tool) => tool.name)).toContain("browser_network");

			// An older session can carry both a selected direction and a restrictive ordinary preset.
			record.session.sessionManager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "binary" });
			setSessionPresetEntry(record.session.sessionManager, "minimal");
			const previousSession = record.session;
			await bridge.close();
			bridge = await start();
			const reopened = await connect(bridge);
			const resumed = await request<SessionSnapshotPayload>(reopened, { type: "session.resume", sessionId: id });
			expect(resumed).toMatchObject({ ok: true, result: { agentPreset: "minimal", approvalMode: "confirm" } });
			const restored = await inspect(reopened, id);
			expect(restored.session).not.toBe(previousSession);
			expect(getResearchMode(restored.session.sessionManager)).toBeDefined();
			expect(getSessionPresetId(restored.session.sessionManager)).toBe("minimal");
			expect(restored.session.systemPrompt).toContain("<minimal_mode>");
			for (const name of researchToolLoadout([])) expect(restored.session.getActiveToolNames()).toContain(name);
			expect(restored.session.getAllTools().map((tool) => tool.name)).toContain("browser_network");
			setSessionPresetEntry(restored.session.sessionManager, "pi-fixture");
			await bridge.close();
			bridge = await start();
			const legacySocket = await connect(bridge);
			expect(await request(legacySocket, { type: "session.resume", sessionId: id })).toMatchObject({
				ok: true,
				result: { agentPreset: "standard", approvalMode: "confirm" },
			});
			const legacy = await inspect(legacySocket, id);
			expect(getSessionPresetId(legacy.session.sessionManager)).toBe("standard");
			for (const name of researchToolLoadout([])) expect(legacy.session.getActiveToolNames()).toContain(name);
			expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual(savedSettings);
			expect(noFetch).not.toHaveBeenCalled();
		} finally {
			for (const socket of sockets) socket.close();
			await bridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

it("passes an initial loadout through the SDK without narrowing deferred tools or changing explicit allowlists", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-research-sdk-loadout-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-sdk-loadout-")) {
		throw new Error("Unsafe SDK loadout cleanup target");
	}
	const sessions: AgentSession[] = [];
	const deferred: ToolDefinition = {
		name: "fixture_deferred",
		label: "Fixture deferred tool",
		description: "Offline fixture available for later discovery",
		exposure: "deferred",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: undefined }),
	};
	try {
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			credentials: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "bash"], cacheWarming: "off" }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				noThemes: true,
			},
		});
		const combined = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			toolActivation: "on-demand",
			initialActiveToolNames: ["read", "write"],
			customTools: [deferred],
		});
		sessions.push(combined.session);
		expect(combined.session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(combined.session.getAllTools().map((tool) => tool.name)).toContain(deferred.name);
		await combined.session.reload();
		expect(combined.session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(combined.session.getAllTools().map((tool) => tool.name)).toContain(deferred.name);
		const restricted = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			toolActivation: "on-demand",
			tools: ["read"],
			initialActiveToolNames: ["read", "write"],
			customTools: [deferred],
		});
		sessions.push(restricted.session);
		expect(restricted.session.getActiveToolNames()).toEqual(["read"]);
		expect(restricted.session.getAllTools().map((tool) => tool.name)).not.toContain(deferred.name);
	} finally {
		for (const session of sessions) session.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
