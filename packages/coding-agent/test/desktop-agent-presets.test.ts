import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentSession } from "../src/core/agent-session.ts";
import * as sessionServices from "../src/core/agent-session-services.ts";
import type { DesktopClientRequestWithoutId, ServerResponseMessage } from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

// Agent 预设走真实桥挂载（mountSession 解析 + setActiveToolsByName 应用），不进 provider 请求。
const applyTools = vi.spyOn(AgentSession.prototype, "setActiveToolsByName");
const mounted: { session: AgentSession; services: sessionServices.AgentSessionServices }[] = [];
const createSessionFromServices = sessionServices.createAgentSessionFromServices;
const createSession = vi
	.spyOn(sessionServices, "createAgentSessionFromServices")
	.mockImplementation(async (options) => {
		const result = await createSessionFromServices(options);
		mounted.push({ session: result.session, services: options.services });
		return result;
	});

let bridge: DesktopServerHandle | undefined;
let socket: WebSocket | undefined;
let cleanupRoot: string | undefined;

afterEach(async () => {
	applyTools.mockClear();
	createSession.mockClear();
	mounted.length = 0;
	socket?.terminate();
	socket = undefined;
	await bridge?.close().catch(() => {});
	bridge = undefined;
	// 桥全关后再清目录（Windows 上 news.sqlite 句柄释放晚于用例体）
	if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
	cleanupRoot = undefined;
	vi.unstubAllEnvs();
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
		const cleanup = (): void => {
			clearTimeout(timeout);
			ws.off("message", onMessage);
			ws.off("error", onError);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onMessage = (data: string): void => {
			const message = JSON.parse(data) as ServerResponseMessage;
			if (message.type === "response" && message.id === id) {
				cleanup();
				done(message);
			}
		};
		const timeout = setTimeout(() => onError(new Error(`Desktop request timed out: ${request.type}`)), 15_000);
		ws.on("message", onMessage);
		ws.once("error", onError);
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

		// 花名册：内置五预设 + 默认 standard
		const list = await request(ws, { type: "preset.list" });
		expect(list.ok).toBe(true);
		const roster = list.result as { presets: { id: string }[]; defaultPreset: string };
		const names = roster.presets.map((preset) => preset.id);
		expect(names).toEqual(["standard", "ptc", "minimal", "pi", "cordis"]);

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

it("isolates Pi resources and preserves session settings when switching and resuming through the bridge", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-agent-presets-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-agent-presets-")) {
		throw new Error("Unsafe agent presets cleanup target");
	}
	cleanupRoot = root;
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const extensionsDir = join(agentDir, "extensions");
	const skillsDir = join(agentDir, "skills", "fixture-skill");
	const promptsDir = join(agentDir, "prompts");
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(extensionsDir, { recursive: true }),
		mkdir(skillsDir, { recursive: true }),
		mkdir(promptsDir, { recursive: true }),
	]);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	await Promise.all([
		writeFile(join(cwd, "AGENTS.md"), "Follow fixture_project_instructions for this workspace."),
		writeFile(join(agentDir, "SYSTEM.md"), "fixture_system_prompt"),
		writeFile(join(agentDir, "APPEND_SYSTEM.md"), "fixture_append_prompt"),
		writeFile(
			join(promptsDir, "fixture-prompt.md"),
			"---\ndescription: Fixture template\n---\nfixture_template_body",
		),
		writeFile(
			join(skillsDir, "SKILL.md"),
			"---\nname: fixture-skill\ndescription: Fixture skill\n---\nfixture_skill_body",
		),
		writeFile(
			join(extensionsDir, "fixture.ts"),
			`export default function(pi) {
  pi.registerTool({ name: "fixture_external", label: "Fixture", description: "Fixture tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: undefined }) });
}`,
		),
		writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultTools: ["+process", "+grep", "+fixture_external"],
				defaultProvider: "preset-fixture",
				defaultModel: "initial",
				owlCustomPrompt: "fixture_custom_prompt",
				owlUserImpression: "fixture_user_impression",
				owlSidebar: { injectOpenTool: true },
				cacheWarming: { mode: "off" },
			}),
		),
		writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"preset-fixture": {
						baseUrl: "https://unused.invalid/v1",
						api: "openai-completions",
						apiKey: "unused-no-network",
						models: [
							{ id: "initial", name: "Initial", reasoning: true, contextWindow: 8192, maxTokens: 1024 },
							{ id: "selected", name: "Selected", reasoning: true, contextWindow: 8192, maxTokens: 1024 },
						],
					},
				},
			}),
		),
	]);
	const serverOptions = { port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} };
	bridge = await startDesktopServer(serverOptions);
	socket = await connect(bridge.port);
	let ws = socket;
	const latestMounted = (): (typeof mounted)[number] => {
		const value = mounted.at(-1);
		if (!value) throw new Error("No runtime was mounted");
		return value;
	};
	const expectPiResources = ({ session, services }: (typeof mounted)[number]): void => {
		const tools = ["bash", "edit", "read", "write"];
		expect(session.getActiveToolNames().sort()).toEqual(tools);
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(tools);
		expect(session.getCallableToolNames().sort()).toEqual(tools);
		expect(services.resourceLoader.getSkills().skills).toEqual([]);
		expect(services.resourceLoader.getPrompts().prompts).toEqual([]);
		expect(services.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
			"<inline:owl-permissions>",
		]);
		expect(session.systemPrompt).toContain("expert coding assistant");
		expect(session.systemPrompt).toContain("fixture_project_instructions");
		for (const excluded of [
			"desktop_work",
			"update_user_impression",
			"tool_search",
			"fixture_system_prompt",
			"fixture_append_prompt",
			"fixture_custom_prompt",
			"fixture_user_impression",
			"fixture_skill_body",
		]) {
			expect(session.systemPrompt).not.toContain(excluded);
		}
	};

	// A new Pi session ignores the user's extra tool/resource defaults.
	const createdPi = await request(ws, { type: "session.create", agentPreset: "pi" });
	expect(createdPi.ok, JSON.stringify(createdPi)).toBe(true);
	const piRuntime = latestMounted();
	expectPiResources(piRuntime);
	piRuntime.session.setActiveToolsByName(["read", "bash", "edit", "write", "process", "fixture_external"]);
	expectPiResources(piRuntime);
	await piRuntime.session.reload();
	expectPiResources(piRuntime);

	const createdStandard = await request(ws, {
		type: "session.create",
		agentPreset: "standard",
		thinkingLevel: "high",
	});
	expect(createdStandard.ok, JSON.stringify(createdStandard)).toBe(true);
	const sessionId = (createdStandard.result as { sessionId: string }).sessionId;
	const standardRuntime = latestMounted();
	expect(standardRuntime.services.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain(
		"fixture-skill",
	);
	expect(standardRuntime.services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toContain(
		"fixture-prompt",
	);
	expect(standardRuntime.session.getAllTools().map((tool) => tool.name)).toContain("fixture_external");
	expect(standardRuntime.session.systemPrompt).toContain("desktop_work");
	expect(standardRuntime.session.systemPrompt).toContain("fixture_append_prompt");
	expect(standardRuntime.session.systemPrompt).toContain("fixture_user_impression");
	expect(
		(await request(ws, { type: "session.setModel", sessionId, provider: "preset-fixture", model: "selected" })).ok,
	).toBe(true);
	expect((await request(ws, { type: "session.setThinkingLevel", sessionId, level: "medium" })).ok).toBe(true);
	expect((await request(ws, { type: "session.setApprovalMode", sessionId, approvalMode: "confirm" })).ok).toBe(true);

	// Requests sent during a runtime replacement must observe the completed Pi session.
	const switching = request(ws, { type: "session.setPreset", sessionId, agentPreset: "pi" });
	const observing = request(ws, { type: "session.resume", sessionId });
	const [switchedPi, observed] = await Promise.all([switching, observing]);
	expect(switchedPi.ok, JSON.stringify(switchedPi)).toBe(true);
	expect(observed.ok, JSON.stringify(observed)).toBe(true);
	expect(observed.result).toMatchObject({ sessionId, agentPreset: "pi", approvalMode: "confirm" });
	const switchedRuntime = latestMounted();
	expect(switchedRuntime.session).not.toBe(standardRuntime.session);
	expect(switchedRuntime.session.sessionManager.getSessionId()).toBe(sessionId);
	expect(switchedRuntime.session.model).toMatchObject({ provider: "preset-fixture", id: "selected" });
	expect(switchedRuntime.session.thinkingLevel).toBe("medium");
	expectPiResources(switchedRuntime);
	expect((await request(ws, { type: "session.resume", sessionId })).result).toMatchObject({
		sessionId,
		agentPreset: "pi",
		approvalMode: "confirm",
	});

	const switchedStandard = await request(ws, { type: "session.setPreset", sessionId, agentPreset: "standard" });
	expect(switchedStandard.ok, JSON.stringify(switchedStandard)).toBe(true);
	const restoredStandard = latestMounted();
	expect(restoredStandard.session.sessionManager.getSessionId()).toBe(sessionId);
	expect(restoredStandard.session.model).toMatchObject({ provider: "preset-fixture", id: "selected" });
	expect(restoredStandard.session.thinkingLevel).toBe("medium");
	expect(restoredStandard.session.getAllTools().map((tool) => tool.name)).toContain("fixture_external");
	expect(restoredStandard.session.systemPrompt).toContain("desktop_work");
	expect(restoredStandard.session.systemPrompt).toContain("fixture_append_prompt");
	expect(restoredStandard.session.systemPrompt).toContain("fixture_user_impression");

	// Persist a local transcript, then verify a cold resume uses the saved Pi profile and approval.
	expect((await request(ws, { type: "session.setPreset", sessionId, agentPreset: "pi" })).ok).toBe(true);
	latestMounted().session.sessionManager.appendMessage({
		role: "user",
		content: "fixture history",
		timestamp: Date.now(),
	});
	socket.terminate();
	socket = undefined;
	await bridge.close();
	bridge = await startDesktopServer(serverOptions);
	socket = await connect(bridge.port);
	ws = socket;
	const resumed = await request(ws, { type: "session.resume", sessionId, approvalModeFallback: "auto" });
	expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
	expect(resumed.result).toMatchObject({
		sessionId,
		agentPreset: "pi",
		approvalMode: "confirm",
		thinkingLevel: "medium",
	});
	const resumedRuntime = latestMounted();
	expect(resumedRuntime.session.model).toMatchObject({ provider: "preset-fixture", id: "selected" });
	expectPiResources(resumedRuntime);
	expect(await request(ws, { type: "session.setPreset", sessionId, agentPreset: "standard" })).toMatchObject({
		ok: false,
		error: "preset-locked",
	});

	// Pi as the ordinary default must keep research conversations' dedicated capabilities available.
	expect((await request(ws, { type: "preset.setDefault", agentPreset: "pi" })).ok).toBe(true);
	const research = await request(ws, { type: "session.create", researchMode: "auto" });
	expect(research.ok, JSON.stringify(research)).toBe(true);
	expect(research.result).toMatchObject({ agentPreset: "standard", researchMode: "auto" });
	const researchSessionId = (research.result as { sessionId: string }).sessionId;
	const researchRuntime = latestMounted();
	expect(researchRuntime.session.getAllTools().map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["research_publish", "research_executable", "research_decompile", "research_model_lab"]),
	);
	expect(
		await request(ws, { type: "session.setPreset", sessionId: researchSessionId, agentPreset: "pi" }),
	).toMatchObject({ ok: false, error: "研究会话需要专属工具，不能切换到 Pi 模式" });
	expect(latestMounted()).toBe(researchRuntime);
	expect((await request(ws, { type: "session.resume", sessionId: researchSessionId })).result).toMatchObject({
		agentPreset: "standard",
		researchMode: "auto",
	});
}, 30_000);
