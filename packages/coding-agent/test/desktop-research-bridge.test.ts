import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentSession } from "../src/core/agent-session.ts";
import { getQuestionChannel, registerPendingQuestion } from "../src/core/question-channel.ts";
import { defaultResearchPrompt, getResearchMode, RESEARCH_PUBLISH_TOOL } from "../src/core/research/agent.ts";
import { RESEARCH_DECOMPILE_TOOL } from "../src/core/research/decompile-tools.ts";
import { RESEARCH_EXECUTABLE_TOOL } from "../src/core/research/executable-tools.ts";
import { RESEARCH_MODEL_LAB_TOOL } from "../src/core/research/model-lab.ts";
import { ResearchReaClient } from "../src/core/research/rea-client.ts";
import { RESEARCH_REA_TOOL } from "../src/core/research/rea-tools.ts";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";
import type {
	DesktopClientRequestWithoutId,
	QuestionRequestMessage,
	ResearchPromptsExportResult,
	ResearchPromptsResult,
	ServerResponseMessage,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

it("keeps ordinary and research scopes separate through the real bridge and restores direction after restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "owl-research-bridge-"));
	const absolute = resolve(root);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-research-bridge-")) {
		throw new Error("Unsafe research bridge cleanup target");
	}
	const agentDir = join(root, "profile");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [], cacheWarming: { mode: "off" } }));
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const exportDir = join(root, "exports");
	vi.stubEnv("OWL_EXPORT_DIR", exportDir);
	const observed: Array<{ sessionId: string; mode: string | undefined; tools: string[]; instructions?: string }> = [];
	const reaClose = vi.spyOn(ResearchReaClient.prototype, "close");
	// Exercise bridge dispatch and persistence while guaranteeing no provider prompt can leave this process.
	const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
		this: AgentSession,
		message,
		options,
	) {
		const prepared = await this.extensionRunner.emitBeforeAgentStart(String(message), undefined, {
			cwd: this.sessionManager.getCwd(),
		});
		observed.push({
			sessionId: this.sessionManager.getSessionId(),
			mode: getResearchMode(this.sessionManager),
			tools: this.getAllTools().map((tool) => tool.name),
			instructions: prepared.systemPromptOptions.sections.owl_research,
		});
		this.sessionManager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
		options?.preflightResult?.("handled");
	});
	const noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("External requests forbidden in research bridge tests");
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
	async function connect(handle: DesktopServerHandle) {
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
				reject(new Error("Research bridge request timed out"));
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
	try {
		bridge = await start();
		const socket = await connect(bridge);
		const defaultPrompts = await request<ResearchPromptsResult>(socket, { type: "research.prompts.get" });
		expect(defaultPrompts).toMatchObject({
			ok: true,
			result: { settings: { enabled: false, activePresetId: null }, defaultPrompt: defaultResearchPrompt() },
		});
		if (!defaultPrompts.result) throw new Error("Missing research prompt defaults");
		const customPrompt = "用户设置的研究方法：从当前材料先做最小复现。";
		const promptSettings = {
			...defaultPrompts.result.settings,
			presets: [
				...defaultPrompts.result.settings.presets,
				{ id: "bridge-custom", name: "桥测试", content: customPrompt },
			],
		};
		expect(await request(socket, { type: "research.prompts.save", settings: promptSettings })).toMatchObject({
			ok: true,
		});
		const appliedPrompts = await request<ResearchPromptsResult>(socket, {
			type: "research.prompts.apply",
			presetId: "bridge-custom",
		});
		expect(appliedPrompts).toMatchObject({
			ok: true,
			result: {
				settings: { enabled: true, activePresetId: "bridge-custom" },
				defaultPrompt: defaultResearchPrompt(),
			},
		});
		const exportedSnapshot = {
			...promptSettings,
			presets: [...promptSettings.presets, { id: "export-only", name: "未保存导出", content: "此草稿不写入配置。" }],
		};
		const exported = await request<ResearchPromptsExportResult>(socket, {
			type: "research.prompts.export",
			settings: exportedSnapshot,
		});
		expect(exported.ok).toBe(true);
		if (!exported.result) throw new Error("Missing research prompt export file");
		expect(dirname(exported.result.savedPath)).toBe(resolve(exportDir));
		expect(basename(exported.result.savedPath)).toMatch(/^owl-research-prompts-.*\.json$/);
		expect(JSON.parse(await readFile(exported.result.savedPath, "utf8"))).toEqual(exportedSnapshot);
		expect(
			await request(socket, { type: "research.prompts.export", settings: { ...promptSettings, enabled: true } }),
		).toMatchObject({ ok: false });
		expect(await readdir(exportDir)).toEqual([basename(exported.result.savedPath)]);
		expect(await request(socket, { type: "research.prompts.apply", presetId: "missing" })).toMatchObject({
			ok: false,
			error: "选中的研究提示词预设不存在",
		});
		expect(
			await request(socket, { type: "research.prompts.save", settings: { ...promptSettings, enabled: true } }),
		).toMatchObject({ ok: false });
		expect((await request<ResearchPromptsResult>(socket, { type: "research.prompts.get" })).result).toEqual(
			appliedPrompts.result,
		);
		const invalid = await request(socket, { type: "session.create", researchMode: "unknown" as "auto" });
		expect(invalid).toMatchObject({ ok: false, error: "无效的研究方向" });
		const ordinary = await request<SessionSnapshotPayload>(socket, { type: "session.create" });
		expect(ordinary.ok).toBe(true);
		expect(ordinary.result?.researchMode).toBeUndefined();
		if (!ordinary.result?.sessionId) throw new Error(JSON.stringify(ordinary));
		const rejected = await request(socket, {
			type: "session.prompt",
			sessionId: ordinary.result.sessionId,
			message: "hello",
			researchMode: "auto",
		});
		expect(rejected).toMatchObject({ ok: false });
		expect(rejected.error).toContain("不是研究会话");
		expect(prompt).not.toHaveBeenCalled();
		await request(socket, { type: "session.prompt", sessionId: ordinary.result.sessionId, message: "ordinary" });
		expect(observed[0].mode).toBeUndefined();
		expect(observed[0].instructions).toBeUndefined();
		expect(observed[0].tools).not.toContain(RESEARCH_PUBLISH_TOOL);
		// 普通对话借用 REA 静态分析能力，研究工作台专属工具仍然不注册。
		expect(observed[0].tools).toContain(RESEARCH_REA_TOOL);
		for (const tool of [RESEARCH_EXECUTABLE_TOOL, RESEARCH_DECOMPILE_TOOL, RESEARCH_MODEL_LAB_TOOL]) {
			expect(observed[0].tools).not.toContain(tool);
		}
		const research = await request<SessionSnapshotPayload>(socket, {
			type: "session.create",
			researchMode: "auto",
			approvalMode: "confirm",
		});
		expect(research).toMatchObject({ ok: true, result: { researchMode: "auto", approvalMode: "confirm" } });
		if (!research.result?.sessionId) throw new Error(JSON.stringify(research));
		const id = research.result.sessionId;
		const questionId = randomUUID();
		const question: QuestionRequestMessage = {
			type: "question_request",
			requestId: questionId,
			sessionId: id,
			toolCallId: "scope-question",
			questions: [
				{
					header: "范围",
					question: "先看样本？",
					multiSelect: false,
					options: [{ label: "样本", description: "少量记录" }],
				},
			],
		};
		const resolveQuestion = vi.fn();
		registerPendingQuestion(questionId, { sessionId: id, toolCallId: question.toolCallId, resolve: resolveQuestion });
		const receiveQuestion = () =>
			new Promise<QuestionRequestMessage>((done, reject) => {
				const timer = setTimeout(() => {
					socket.off("message", receive);
					reject(new Error("Question replay timed out"));
				}, 5000);
				const receive = (raw: unknown) => {
					const value = JSON.parse(String(raw)) as QuestionRequestMessage;
					if (value.type !== "question_request" || value.requestId !== questionId) return;
					clearTimeout(timer);
					socket.off("message", receive);
					done(value);
				};
				socket.on("message", receive);
			});
		const originalQuestion = receiveQuestion();
		getQuestionChannel()?.broadcast(question);
		expect(await originalQuestion).toEqual(question);
		const replayedQuestion = receiveQuestion();
		await request(socket, { type: "session.resume", sessionId: id });
		expect(await replayedQuestion).toEqual(question);
		await request(socket, { type: "question.response", requestId: questionId, answers: [], cancelled: true });
		expect(resolveQuestion).toHaveBeenCalledWith({ answers: [], cancelled: true });
		await request(socket, { type: "session.setApprovalMode", sessionId: id, approvalMode: "plan" });
		expect(
			await request(socket, {
				type: "session.resume",
				sessionId: id,
				approvalMode: "auto",
				provider: "unknown",
				model: "ordinary-chat",
			}),
		).toMatchObject({ ok: true, result: { approvalMode: "plan" } });
		expect(
			await request(socket, {
				type: "session.prompt",
				sessionId: id,
				message: "整理一页资料",
				researchMode: "crawl",
			}),
		).toMatchObject({ ok: true });
		expect(observed[1]).toMatchObject({ sessionId: id, mode: "crawl" });
		expect(observed[1].instructions).toContain(customPrompt);
		expect(observed[1].instructions).not.toContain(defaultResearchPrompt());
		expect(observed[1].instructions).toContain("审批模式和实际工具边界照常生效");
		expect(observed[1].tools).toContain(RESEARCH_PUBLISH_TOOL);
		expect(observed[1].tools).toContain(RESEARCH_REA_TOOL);
		expect(observed[1].tools).toEqual(
			expect.arrayContaining([RESEARCH_EXECUTABLE_TOOL, RESEARCH_DECOMPILE_TOOL, RESEARCH_MODEL_LAB_TOOL]),
		);
		expect(await request(socket, { type: "session.resume", sessionId: id })).toMatchObject({
			ok: true,
			result: { researchMode: "crawl" },
		});
		const invalidPrompt = await request(socket, {
			type: "session.prompt",
			sessionId: id,
			message: "invalid",
			researchMode: "unknown" as "auto",
		});
		expect(invalidPrompt.ok).toBe(false);
		expect(prompt).toHaveBeenCalledTimes(2);
		const allHistory = await request<Array<{ id: string; scope: string }>>(socket, { type: "session.list" });
		expect(allHistory.result).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: ordinary.result.sessionId, scope: "chat" }),
				expect.objectContaining({ id, scope: "research" }),
			]),
		);
		const researchHistory = await request<Array<{ id: string; scope: string }>>(socket, {
			type: "session.list",
			scope: "research",
		});
		expect(researchHistory.result?.map((row) => row.id)).toEqual([id]);
		const ordinaryHistory = await request<Array<{ id: string; scope: string }>>(socket, {
			type: "session.list",
			scope: "chat",
		});
		expect(ordinaryHistory.result?.map((row) => row.id)).toEqual([ordinary.result.sessionId]);
		expect(await request(socket, { type: "session.list", scope: "other" as "chat" })).toMatchObject({
			ok: false,
			error: "无效的会话目录类型",
		});
		const restoredPrompts = await request<ResearchPromptsResult>(socket, { type: "research.prompts.restore" });
		expect(restoredPrompts).toMatchObject({
			ok: true,
			result: { settings: { enabled: false, activePresetId: "bridge-custom", presets: promptSettings.presets } },
		});
		socket.close();
		await bridge.close();
		expect(reaClose).toHaveBeenCalled();
		const originalClient = reaClose.mock.contexts[0];
		reaClose.mockClear();
		bridge = await start();
		const reopened = await connect(bridge);
		expect((await request<ResearchPromptsResult>(reopened, { type: "research.prompts.get" })).result).toEqual(
			restoredPrompts.result,
		);
		const restartedResearchHistory = await request<Array<{ id: string; scope: string }>>(reopened, {
			type: "session.list",
			scope: "research",
		});
		expect(restartedResearchHistory.result?.map((row) => row.id)).toEqual([id]);
		expect(
			await request(reopened, {
				type: "session.resume",
				sessionId: id,
				approvalMode: "auto",
				provider: "unknown",
				model: "ordinary-chat",
			}),
		).toMatchObject({
			ok: true,
			result: { researchMode: "crawl", approvalMode: "plan", messages: [{ role: "user", content: "整理一页资料" }] },
		});
		expect(
			await request(reopened, {
				type: "session.prompt",
				sessionId: id,
				message: "分析来源请求",
				researchMode: "web",
			}),
		).toMatchObject({ ok: true });
		expect(observed[2]).toMatchObject({ mode: "web" });
		expect(observed[2].instructions).toContain(defaultResearchPrompt());
		expect(observed[2].instructions).not.toContain(customPrompt);
		expect(observed[2].tools).toContain(RESEARCH_PUBLISH_TOOL);
		expect(observed[2].tools).toContain(RESEARCH_REA_TOOL);
		expect(observed[2].tools).toEqual(
			expect.arrayContaining([RESEARCH_EXECUTABLE_TOOL, RESEARCH_DECOMPILE_TOOL, RESEARCH_MODEL_LAB_TOOL]),
		);
		await bridge.close();
		bridge = undefined;
		expect(reaClose).toHaveBeenCalled();
		expect(reaClose.mock.contexts[0]).not.toBe(originalClient);
		expect(noFetch).not.toHaveBeenCalled();
	} finally {
		for (const socket of sockets) socket.close();
		await bridge?.close();
		prompt.mockRestore();
		reaClose.mockRestore();
		vi.unstubAllEnvs();
		await rm(absolute, { recursive: true, force: true });
	}
}, 30_000);

it("only permits rea inventory in desktop plan mode", () => {
	expect(isReadOnlyDesktopTool(RESEARCH_REA_TOOL, { action: "inventory" })).toBe(true);
	for (const action of [
		"javascript",
		"native_overview",
		"native_functions",
		"native_strings",
		"native_function",
		"native_references",
		"native_call_graph",
		"managed_metadata",
		"managed_members",
		"managed_native",
		"view",
		"close",
	]) {
		expect(isReadOnlyDesktopTool(RESEARCH_REA_TOOL, { action })).toBe(false);
	}
	for (const input of [undefined, {}, { action: "open" }, { action: "analyze" }, { action: "query" }]) {
		expect(isReadOnlyDesktopTool(RESEARCH_REA_TOOL, input)).toBe(false);
	}
});
