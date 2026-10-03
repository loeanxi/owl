import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentSession } from "../src/core/agent-session.ts";
import { getQuestionChannel, registerPendingQuestion } from "../src/core/question-channel.ts";
import { getResearchMode, RESEARCH_PUBLISH_TOOL } from "../src/core/research/agent.ts";
import type {
	DesktopClientRequestWithoutId,
	QuestionRequestMessage,
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
	const observed: Array<{ sessionId: string; mode: string | undefined; tools: string[] }> = [];
	// Exercise bridge dispatch and persistence while guaranteeing no provider prompt can leave this process.
	const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
		this: AgentSession,
		message,
	) {
		observed.push({
			sessionId: this.sessionManager.getSessionId(),
			mode: getResearchMode(this.sessionManager),
			tools: this.getAllTools().map((tool) => tool.name),
		});
		this.sessionManager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
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
		expect(observed[0].tools).not.toContain(RESEARCH_PUBLISH_TOOL);
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
		expect(observed[1].tools).toContain(RESEARCH_PUBLISH_TOOL);
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
		socket.close();
		await bridge.close();
		bridge = await start();
		const reopened = await connect(bridge);
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
		expect(observed[2].tools).toContain(RESEARCH_PUBLISH_TOOL);
		expect(noFetch).not.toHaveBeenCalled();
	} finally {
		for (const socket of sockets) socket.close();
		await bridge?.close();
		prompt.mockRestore();
		vi.unstubAllEnvs();
		await rm(absolute, { recursive: true, force: true });
	}
}, 30_000);
