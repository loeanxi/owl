/** Dev-only, offline harness: actual MyselfPanel and shared Home components, in-memory files. */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BridgeClient } from "../bridge/client.ts";
import type {
	AgentPresetDefinition,
	DesktopClientRequestWithoutId,
	FsListing,
	FsReadResult,
	ProviderModelsMessage,
	QuestionAnswerPayload,
	QuestionRequest,
	ServerEventMessage,
	SessionSnapshotPayload,
	SessionStatsResult,
} from "../bridge/protocol.ts";
import { AgentConversation } from "../components/AgentConversation.tsx";
import { ChatStream } from "../components/ChatStream.tsx";
import { Composer } from "../components/Composer.tsx";
import { ConversationHeader, type ConversationView } from "../components/ConversationHeader.tsx";
import { GenuiSessionProvider } from "../components/Genui.tsx";
import { ContextView } from "../components/ContextView.tsx";
import { TrajectoryView } from "../features/trajectory/TrajectoryView.tsx";
import { rebuild } from "../hooks/transcript.ts";
import { MyselfPanel } from "../features/myself/MyselfPanel.tsx";
import { type MyselfChatIntent, myselfChatKey } from "../features/myself/myself-chat-controller.ts";
import {
	addTodoInRaw,
	dayKeyOf,
	newDayTemplate,
	nextDayKey,
	parseDay,
	todayKey,
	updateSummaryInRaw,
	weekDaysOf,
} from "../features/myself/myself-data.ts";
import { setUiLanguage } from "../i18n/index.ts";
import "../index.css";
import "../desktop-shell.css";

const CWD = "D:/owl/owl-myself";
const comparison = new URLSearchParams(location.search).get("comparison");
const historyMode = new URLSearchParams(location.search).has("history");
const HISTORY_STORAGE = "owl.debug.myself.history-fixtures";
const fixtureTime = new Date(`${todayKey()}T08:42:00`).getTime();
const styleFixture: Record<string, unknown>[] = [
	{ role: "user", content: [{ type: "text", text: "今天的任务：确定助理日程改版方案，完善供应商设置。" }], timestamp: fixtureTime },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "这是待办记录；只核对当天内容，再合并记录。" },
			{ type: "text", text: "先查看今天已有的事项，再把这两件事记进去。" },
			{ type: "toolCall", id: "style-read", name: "read", arguments: { path: `${CWD}/${todayKey()}.md` } },
			{ type: "toolCall", id: "style-edit", name: "edit", arguments: { path: `${CWD}/${todayKey()}.md`, oldText: "演示待办", newText: "日程改版与供应商设置" } },
		],
		stopReason: "toolUse", timestamp: fixtureTime + 1000,
		usage: { input: 200, output: 40, cacheRead: 120, cacheWrite: 0 }, model: "offline-agent",
	},
	{ role: "toolResult", toolCallId: "style-read", toolName: "read", content: [{ type: "text", text: "离线夹具：已读取今天的示例事项。" }], isError: false, timestamp: fixtureTime + 2000 },
	{ role: "toolResult", toolCallId: "style-edit", toolName: "edit", content: [{ type: "text", text: "离线夹具：已保留原内容并合并两条记录。" }], isError: false, timestamp: fixtureTime + 3000 },
	{
		role: "assistant", content: [{ type: "text", text: "已记下两件待办：\n- 确定助理日程改版方案\n- 完善供应商设置\n\n现在只是记录，等你决定开始处理。" }],
		stopReason: "stop", timestamp: fixtureTime + 4500, model: "offline-agent",
		usage: { input: 210, output: 50, cacheRead: 130, cacheWrite: 0 },
	},
];
const fixturePresets: AgentPresetDefinition[] = [
	{ id: "standard", name: "标准模式", description: "离线预设夹具：工具按当前配置使用。", builtin: true, order: 1 },
	{ id: "minimal", name: "极简模式", description: "离线预设夹具：使用基础工具。", builtin: true, order: 2, tools: ["read", "bash", "edit"] },
];
const today = todayKey();
const tomorrow = nextDayKey(today);
const previousDay = new Date(`${today}T12:00:00`);
previousDay.setDate(previousDay.getDate() - 1);
const yesterday = dayKeyOf(previousDay);
const SUMMARY = "离线验收总结：已核对日程与完成事项，明天继续处理剩余任务。";

const todayRaw = `# ${today}（日程验收）

## 待办（手记）

- [ ] 完善 owl 助理 <!-- owl-task:{"status":"doing","time":"09:30","category":"工作","goal":"交付助理日程"} -->
- [ ] 核对供应商资料 <!-- owl-task:{"status":"waiting","time":"14:00","category":"工作","goal":"交付助理日程"} -->
- [ ] 给家人打电话 <!-- owl-task:{"time":"19:30","category":"生活","goal":"照顾生活"} -->
- [x] 整理验收清单

## AI 提炼（自动）

1. **交付助理日程** —— 完成日程页面与记录流程
2. **照顾生活** —— 留出联系家人的时间

## 对话

> 08:30 我：今天需要记录工作和生活。

## 完成情况

- [x] 整理验收清单

### 今日总结

已整理验收清单，其余事项继续推进。
`;
const yesterdayRaw = updateSummaryInRaw(
	addTodoInRaw(newDayTemplate(yesterday, "zh"), "昨天已完成的记录", { status: "done" }),
	"历史回顾：昨天完成了资料整理。",
);
const tomorrowRaw = addTodoInRaw(newDayTemplate(tomorrow, "zh"), "明天已有事项，不能被覆盖");
const files = new Map([
	[`${today}.md`, todayRaw],
	[`${yesterday}.md`, yesterdayRaw],
	[`${tomorrow}.md`, tomorrowRaw],
]);
const initialFiles = Object.fromEntries(files);
type Response = { ok: boolean; result?: unknown; error?: string };
type Request = DesktopClientRequestWithoutId & { id?: string };
type AgentAction = "record" | "summary" | "question";
type WriteRecord = { actor: "ui" | "agent"; path: string; content: string };
type Turn = { date: string; intent: MyselfChatIntent; text: string };
type AgentRun = {
	id: string;
	turn: Turn;
	messages: Record<string, unknown>[];
	questionTool?: string;
	timer?: ReturnType<typeof setTimeout>;
};
const requests: Request[] = [];
const writes: WriteRecord[] = [];
const failedWrites: { path: string; content: string }[] = [];
let failNextWrite = false;
const listeners = new Set<(message: ServerEventMessage) => void>();
const questionListeners = new Set<() => void>();
let questions: QuestionRequest[] = [];
const questionResponses: { requestId: string; answers: QuestionAnswerPayload[]; cancelled: boolean }[] = [];
let sessionId: string | undefined;
let sessionCount = 0;
let run: AgentRun | undefined;
let pendingAction: AgentAction | undefined;
let messages: Record<string, unknown>[] = [];
const preferences = {
	model: { provider: "debug", id: "offline-agent", name: "Offline Agent" },
	thinkingLevel: "high",
	approvalMode: "confirm",
	agentPreset: "standard",
};
type HistoryFixtureSession = {
	id: string;
	cwd: string;
	name: string;
	created: string;
	modified: string;
	messages: Record<string, unknown>[];
	preferences: typeof preferences;
	archivedAt?: string;
};
const historySessions = new Map<string, HistoryFixtureSession>();
let historyListMode: "normal" | "empty" | "error" | "delay" = "normal";
let failHistoryResumeId: string | undefined;
let mismatchHistoryResumeId: string | undefined;
function persistHistory(): void {
	if (!historyMode) return;
	localStorage.setItem(HISTORY_STORAGE, JSON.stringify({ sessions: [...historySessions.values()], sessionCount }));
}
function rememberCurrentHistory(updated = false): void {
	if (!historyMode || !sessionId) return;
	const current = historySessions.get(sessionId);
	const firstUser = messages.find((message) => message.role === "user");
	const content = Array.isArray(firstUser?.content) ? firstUser.content as { type?: string; text?: string }[] : [];
	const firstText = content.find((part) => part.type === "text")?.text ?? "";
	historySessions.set(sessionId, {
		id: sessionId, cwd: current?.cwd ?? CWD,
		name: current?.name || (firstText ? `新记录：${turnOf(firstText).text}` : "新会话"),
		created: current?.created ?? new Date().toISOString(),
		modified: updated ? new Date().toISOString() : current?.modified ?? new Date().toISOString(),
		messages: structuredClone(messages), preferences: structuredClone(preferences),
		...(current?.archivedAt ? { archivedAt: current.archivedAt } : {}),
	});
	persistHistory();
}
function historySnapshot(item: HistoryFixtureSession): SessionSnapshotPayload {
	return {
		sessionId: item.id, cwd: item.cwd, messages: structuredClone(item.messages),
		messageEntryIds: item.messages.map((_, index) => `debug-entry-${index}`),
		header: {}, name: item.name, running: false,
		approvalMode: item.preferences.approvalMode as "confirm" | "auto" | "plan",
		agentPreset: item.preferences.agentPreset,
	};
}

function emit(event: Record<string, unknown>): void {
	if (sessionId) for (const listener of listeners) listener({ type: "event", sessionId, event });
}
function publishQuestions(next: QuestionRequest[]): void {
	questions = next;
	for (const listener of questionListeners) listener();
}
function appendMessage(message: Record<string, unknown>): void {
	messages.push(message);
	run?.messages.push(message);
	emit({ type: "message_start", message });
	emit({ type: "message_end", message });
	rememberCurrentHistory(true);
}
function stats(): SessionStatsResult {
	const users = messages.filter((message) => message.role === "user").length;
	const assistants = messages.filter((message) => message.role === "assistant").length;
	return {
		model: preferences.model,
		thinkingLevel: preferences.thinkingLevel,
		availableThinkingLevels: ["off", "low", "medium", "high"],
		supportsThinking: true,
		contextUsage: {
			tokens: 4800,
			contextWindow: 200000,
			percent: 2.4,
			breakdown: { systemPrompt: 700, toolDefinitions: 1200, messages: 2000, toolResults: 900 },
		},
		stats: {
			userMessages: users,
			assistantMessages: assistants,
			toolCalls: assistants,
			tokens: {
				input: assistants * 200,
				output: assistants * 40,
				cacheRead: assistants * 120,
				cacheWrite: 0,
				total: assistants * 360,
			},
			cost: 0,
		},
	};
}
function snapshot(): SessionSnapshotPayload {
	rememberCurrentHistory();
	return {
		sessionId: sessionId ?? "",
		cwd: CWD,
		messages,
		messageEntryIds: messages.map((_, index) => `debug-entry-${index}`),
		header: {},
		approvalMode: preferences.approvalMode as "confirm" | "auto" | "plan",
		agentPreset: preferences.agentPreset,
	};
}
function turnOf(message: string): Turn {
	const first = message.split("\n", 1)[0]!;
	if (first.startsWith("<owl-myself-turn>") && first.endsWith("</owl-myself-turn>")) {
		const parsed: unknown = JSON.parse(first.slice("<owl-myself-turn>".length, -"</owl-myself-turn>".length));
		if (parsed && typeof parsed === "object") {
			const value = parsed as Record<string, unknown>;
			if (
				typeof value.date === "string" &&
				typeof value.text === "string" &&
				["record", "plan", "process"].includes(String(value.intent))
			)
				return { date: value.date, text: value.text, intent: value.intent as MyselfChatIntent };
		}
	}
	return { date: today, text: message, intent: "record" };
}
function toolStart(name: string, args: Record<string, unknown>): string {
	const id = `${run?.id}-${name}`;
	appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "读取所选日期，然后仅合并本轮日程。" },
			{ type: "toolCall", id, name, arguments: args },
		],
		stopReason: "toolUse",
		timestamp: Date.now(),
		model: preferences.model.id,
		usage: { input: 200, output: 40, cacheRead: 120, cacheWrite: 0 },
	});
	emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
	return id;
}
function toolEnd(id: string, name: string, text: string): void {
	const result = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
	messages.push(result);
	run?.messages.push(result);
	emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: false });
	rememberCurrentHistory(true);
}
function finishRun(reply: string, aborted = false): void {
	if (!run) return;
	clearTimeout(run.timer);
	appendMessage({
		role: "assistant",
		content: [{ type: "text", text: reply }],
		stopReason: aborted ? "aborted" : "stop",
		timestamp: Date.now(),
		model: preferences.model.id,
		usage: { input: 200, output: 40, cacheRead: 120, cacheWrite: 0 },
	});
	const finished = run.messages;
	run = undefined;
	emit({ type: "agent_end", messages: finished });
	emit({ type: "agent_settled", aborted });
}
function executeRun(action: AgentAction): void {
	if (!run || !sessionId) return;
	const { turn } = run;
	if (action === "question") {
		run.questionTool = toolStart("ask_user_question", {
			questions: [{ header: "日程安排", question: "这项记录需要安排在哪个时间？" }],
		});
		publishQuestions([
			{
				type: "question_request",
				requestId: `${sessionId}:${run.id}`,
				sessionId,
				toolCallId: run.questionTool,
				questions: [
					{
						header: "日程安排",
						question: "这项记录需要安排在哪个时间？",
						multiSelect: false,
						options: [
							{ label: "上午", description: "安排在上午。" },
							{ label: "下午", description: "安排在下午。" },
						],
					},
				],
			},
		]);
		return;
	}
	const path = `${turn.date}.md`;
	const reading = toolStart("read", { path: `${CWD}/${path}` });
	const latest = files.get(path) ?? newDayTemplate(turn.date, "zh");
	toolEnd(reading, "read", latest);
	const editing = toolStart("edit", { path: `${CWD}/${path}` });
	const content = action === "summary" ? updateSummaryInRaw(latest, SUMMARY) : addTodoInRaw(latest, turn.text);
	files.set(path, content);
	writes.push({ actor: "agent", path, content });
	toolEnd(editing, "edit", "已合并写入所选日期日程文件。");
	finishRun(action === "summary" ? "已根据完成事项更新当天总结。" : `已记录：${turn.text}`);
}

const mockClient = {
	async request<T = unknown>(payload: Request): Promise<{ ok: boolean; result?: T; error?: string }> {
		requests.push(payload);
		let response: Response;
		switch (payload.type) {
			case "fs.tree": {
				const result: FsListing = {
					path: "",
					entries: [...files.keys()].map((name) => ({
						name,
						path: name,
						isDir: false,
						hidden: false,
						isSymlink: false,
						broken: false,
					})),
					truncated: false,
				};
				response = { ok: true, result };
				break;
			}
			case "fs.read": {
				const content = files.get(payload.path);
				const result: FsReadResult | undefined =
					content === undefined ? undefined : { kind: "text", content, truncated: false, size: content.length };
				response = result
					? { ok: true, result }
					: { ok: false, error: `ENOENT: no such file or directory, open '${payload.path}'` };
				break;
			}
			case "fs.write":
				if (failNextWrite) {
					failNextWrite = false;
					failedWrites.push({ path: payload.path, content: payload.content });
					response = { ok: false, error: "EACCES: offline fixture write failed once" };
					break;
				}
				files.set(payload.path, payload.content);
				writes.push({ actor: "ui", path: payload.path, content: payload.content });
				response = { ok: true, result: { path: payload.path, size: payload.content.length } };
				break;
			case "fs.search":
				response = {
					ok: true,
					result: payload.query.includes("retry-note") ? [{ path: "retry-note.md", isDir: false }] : [],
				};
				break;
			case "session.create":
				rememberCurrentHistory();
				sessionId = `debug-myself-session-${++sessionCount}`;
				messages = [];
				response = { ok: true, result: snapshot() };
				break;
			case "session.list": {
				if (historyListMode === "delay") await new Promise((resolve) => setTimeout(resolve, 350));
				if (historyListMode === "error") { response = { ok: false, error: "离线夹具：历史列表加载失败" }; break; }
				rememberCurrentHistory();
				response = { ok: true, result: historyListMode === "empty" ? [] : [...historySessions.values()].filter((item) => item.messages.length).map((item) => ({
					id: item.id, path: `offline-fixture/${item.id}.jsonl`, cwd: item.cwd, name: item.name,
					created: item.created, modified: item.modified, messageCount: item.messages.length,
					firstMessage: item.name, allMessagesText: item.name, scope: "chat", preset: item.preferences.agentPreset,
					...(item.archivedAt ? { archivedAt: item.archivedAt } : {}),
				})).sort((a, b) => b.modified.localeCompare(a.modified)) };
				break;
			}
			case "session.resume": {
				if (historyMode) {
					if (failHistoryResumeId === payload.sessionId) { failHistoryResumeId = undefined; response = { ok: false, error: "离线夹具：会话恢复失败" }; break; }
					const target = historySessions.get(payload.sessionId);
					if (!target) { response = { ok: false, error: "Unknown offline history session" }; break; }
					if (mismatchHistoryResumeId === payload.sessionId) { mismatchHistoryResumeId = undefined; response = { ok: true, result: { ...historySnapshot(target), cwd: "D:/offline/other-workspace" } }; break; }
					rememberCurrentHistory();
					sessionId = target.id;
					messages = structuredClone(target.messages);
					Object.assign(preferences, structuredClone(target.preferences));
					response = { ok: true, result: historySnapshot(target) };
					break;
				}
				response =
					payload.sessionId === sessionId
						? { ok: true, result: snapshot() }
						: { ok: false, error: "Unknown debug session" };
				break;
			}
			case "rewind.execute": {
				if (payload.sessionId !== sessionId) return { ok: false, error: "Wrong offline session for rewind" };
				const index = Number(payload.entryId.replace("debug-entry-", ""));
				const target = messages[index];
				const content = Array.isArray(target?.content) ? target.content : [];
				const editorText = content.find((part: unknown) => Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "text")) as { text?: string } | undefined;
				messages = messages.slice(0, Number.isFinite(index) ? index : 0);
				response = { ok: true, result: { editorText: editorText?.text, snapshot: snapshot(), restored: 0, deleted: 0, skipped: [] } };
				break;
			}
			case "session.fork": {
				if (payload.sessionId !== sessionId) return { ok: false, error: "Wrong offline session for branch" };
				sessionId = `debug-myself-branch-${++sessionCount}`;
				response = { ok: true, result: snapshot() };
				break;
			}
			case "session.prompt": {
				if (run || payload.sessionId !== sessionId) return { ok: false, error: "Debug session is busy or missing" };
				run = { id: `run-${Date.now()}`, turn: turnOf(payload.message), messages: [] };
				emit({ type: "agent_start" });
				appendMessage({
					role: "user",
					content: [{ type: "text", text: payload.message }, ...(payload.images ?? [])],
					timestamp: Date.now(),
				});
				const action =
					pendingAction ??
					(run.turn.intent === "plan" && /总结|summary/i.test(run.turn.text) ? "summary" : "record");
				pendingAction = undefined;
				run.timer = setTimeout(() => executeRun(action), 180);
				response = { ok: true };
				break;
			}
			case "session.abort":
				publishQuestions([]);
				finishRun("用户已停止本轮。", true);
				response = { ok: true };
				break;
			case "session.stats":
				response = { ok: true, result: stats() };
				break;
			case "session.running":
				response = { ok: true, result: { running: run && sessionId ? [sessionId] : [] } };
				break;
			case "session.setModel":
				preferences.model = { provider: payload.provider, id: payload.model, name: payload.model };
				response = { ok: true, result: stats() };
				break;
			case "session.setThinkingLevel":
				preferences.thinkingLevel = payload.level;
				response = { ok: true, result: stats() };
				break;
			case "session.setApprovalMode":
				preferences.approvalMode = payload.approvalMode;
				response = { ok: true, result: stats() };
				break;
			case "session.setPreset":
				preferences.agentPreset = payload.agentPreset;
				response = { ok: true, result: snapshot() };
				break;
			case "preset.list":
				response = { ok: true, result: { presets: fixturePresets, defaultPreset: "standard" } };
				break;
			case "session.queue.remove":
			case "session.queue.promote":
				response = { ok: true };
				break;
			case "session.compact":
				response = { ok: true, result: stats() };
				break;
			case "commands.list":
				response = {
					ok: true,
					result: {
						commands: ["new", "settings", "model", "thinking", "compact"].map((name) => ({
							name,
							kind: "builtin",
						})),
					},
				};
				break;
			case "context.get":
				response = {
					ok: true,
					result: {
						sessionId,
						requests: [
							{
								seq: 1,
								ts: Date.now(),
								model: preferences.model,
								composition: {
									system: 700,
									inject: 300,
									user: 900,
									assistant: 500,
									toolResult: 1200,
									toolSchemas: 1200,
									other: 0,
								},
								totalTokens: 4800,
								contextWindow: 200000,
								usage: { input: 200, output: 40, cacheRead: 120, cacheWrite: 0, totalTokens: 360 },
							},
						],
						events: [],
						tools: [
							{ name: "read", source: "builtin" },
							{ name: "edit", source: "builtin" },
						],
					},
				};
				break;
			case "owl-ui.action":
				response = { ok: true };
				break;
			default:
				response = { ok: false, error: `Unsupported offline debug request: ${payload.type}` };
		}
		return { ...response, result: response.result as T };
	},
	onSessionEvent(listener: (message: ServerEventMessage) => void): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	respondQuestion(requestId: string, answers: QuestionAnswerPayload[], cancelled: boolean): Promise<{ ok: boolean }> {
		const question = questions.find((request) => request.requestId === requestId);
		if (!question || !run) return Promise.resolve({ ok: false });
		questionResponses.push({ requestId, answers, cancelled });
		publishQuestions(questions.filter((request) => request.requestId !== requestId));
		if (run.questionTool)
			toolEnd(run.questionTool, "ask_user_question", cancelled ? "用户取消提问。" : "用户已回答。");
		finishRun(
			cancelled
				? "已取消提问，等待你的下一条记录。"
				: `已收到安排：${answers[0]?.customText || answers[0]?.selectedLabels?.join("、") || "已回答"}。`,
		);
		return Promise.resolve({ ok: true });
	},
} as unknown as BridgeClient;

const providers: ProviderModelsMessage[] = [
	{
		id: "debug",
		name: "Offline fixture",
		models: [
			{ id: "offline-agent", name: "Offline Agent", reasoning: true, contextWindow: 200000 },
			{ id: "offline-fast", name: "Offline Fast", reasoning: true, contextWindow: 128000 },
		],
	},
];
const testApi = {
	snapshot: () =>
		structuredClone({
			today,
			yesterday,
			tomorrow,
			week: weekDaysOf(today),
			files: Object.fromEntries(files),
			initialFiles,
			requests,
			writes,
			failedWrites,
			sessionCount,
			sessionId,
			running: Boolean(run),
			questions,
			questionResponses,
			summary: SUMMARY,
			preferences,
			comparison,
			historyMode,
			historySessions: [...historySessions.values()],
			storage: Object.fromEntries(Object.entries(localStorage)),
		}),
	nextAgentAction: (action: AgentAction): void => {
		pendingAction = action;
	},
	failNextWrite: (): void => {
		failNextWrite = true;
	},
	setHistoryListMode: (mode: "normal" | "empty" | "error" | "delay"): void => { historyListMode = mode; },
	failHistoryResumeOnce: (id: string): void => { failHistoryResumeId = id; },
	mismatchHistoryResumeOnce: (id: string): void => { mismatchHistoryResumeId = id; },
	read: (path: string): string | undefined => files.get(path),
	parse: (date: string) => parseDay(files.get(`${date}.md`) ?? "", date),
};
declare global {
	interface Window {
		__myselfTest: typeof testApi;
	}
}
window.__myselfTest = testApi;
setUiLanguage("zh");
if (!historyMode) {
	localStorage.removeItem(myselfChatKey(CWD));
	localStorage.removeItem(`${myselfChatKey(CWD)}.preferences`);
}
if (historyMode) {
	if (new URLSearchParams(location.search).has("resetHistory")) {
		for (const key of Object.keys(localStorage))
			if (key === HISTORY_STORAGE || key.startsWith("owl.myself.chat.")) localStorage.removeItem(key);
	}
	const stored = localStorage.getItem(HISTORY_STORAGE);
	if (stored) {
		const parsed = JSON.parse(stored) as { sessions: HistoryFixtureSession[]; sessionCount: number };
		for (const item of parsed.sessions) historySessions.set(item.id, item);
		sessionCount = parsed.sessionCount;
	} else {
		const makeSession = (id: string, cwd: string, name: string, day: string, reply: string): HistoryFixtureSession => ({
			id, cwd, name, created: `${day}T08:30:00+08:00`, modified: `${day}T09:00:00+08:00`, preferences: structuredClone(preferences),
			messages: [
				{ role: "user", content: [{ type: "text", text: name }], timestamp: new Date(`${day}T08:30:00+08:00`).getTime() },
				{ role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: new Date(`${day}T08:31:00+08:00`).getTime(), model: "offline-agent" },
			],
		});
		const fixtures = [
			makeSession("debug-history-today", CWD, "今天：助理日程改版", today, "今日旧会话已恢复。"),
			makeSession("debug-history-yesterday", "d:\\OWL\\owl-myself\\", "昨天：供应商资料", yesterday, "昨天的供应商会话已恢复。"),
			makeSession("debug-history-other", "D:/offline/other-workspace", "其他工作区会话", today, "这是其他工作区，不属于我的助理。"),
			{ ...makeSession("debug-history-archived", CWD, "已归档会话", yesterday, "已归档的旧记录。"), archivedAt: `${today}T08:00:00+08:00` },
		];
		for (const item of fixtures) historySessions.set(item.id, item);
		sessionCount = fixtures.length;
		localStorage.setItem(myselfChatKey(CWD), "debug-history-today");
		persistHistory();
	}
	const boundId = localStorage.getItem(myselfChatKey(CWD));
	const bound = boundId ? historySessions.get(boundId) : undefined;
	if (bound) { sessionId = bound.id; messages = structuredClone(bound.messages); Object.assign(preferences, structuredClone(bound.preferences)); }
}
if (comparison === "home" || comparison === "myself") {
	sessionId = comparison === "home" ? "debug-home-style-session" : "debug-myself-style-session";
	sessionCount = 1;
	messages = structuredClone(styleFixture);
	localStorage.setItem(myselfChatKey(CWD), sessionId);
}
document.documentElement.dataset.owlTheme = "light";
document.documentElement.dataset.owlPreset = "codex";

function DebugMyself(): React.JSX.Element {
	const [pending, setPending] = useState<QuestionRequest[]>(questions);
	useEffect(() => {
		const refresh = (): void => setPending([...questions]);
		questionListeners.add(refresh);
		return () => {
			questionListeners.delete(refresh);
		};
	}, []);
	return (
		<MyselfPanel
			active
			client={mockClient}
			connected
			workspaceDir="D:/owl"
			agentDir="offline-debug-only"
			providers={providers}
			defaultModel="debug/offline-agent"
			defaultThinkingLevel="high"
			defaultApprovalMode="confirm"
			questions={pending}
			onQuestionAnswer={(requestId, answers, cancelled) => {
				void mockClient.respondQuestion(requestId, answers, cancelled);
			}}
		/>
	);
}
const noop = (): void => {};
function DebugHomeComparison(): React.JSX.Element {
	const [view, setView] = useState<ConversationView>("chat");
	const entries = rebuild(messages, snapshot().messageEntryIds);
	return <div className="owl-main-frame" style={{ margin: 0, border: 0, borderRadius: 0 }}>
		<AgentConversation
			header={<ConversationHeader title="Owl Si" workspaceDir={CWD} view={view} onViewChange={setView} terminalOpen={false} sidebarOpen={false} onToggleTerminal={noop} onToggleSidebar={noop} sessionId={sessionId} onExport={noop} onExportTurns={noop} />}
			view={view}
			chat={<GenuiSessionProvider client={mockClient} sessionId={sessionId}><ChatStream entries={entries} activity="idle" client={mockClient} cwd={CWD} onRegenerate={() => { void mockClient.request({ type: "rewind.execute", sessionId: sessionId!, entryId: "debug-entry-0", mode: "conversation" }); }} onEditMessage={(entryId) => { void mockClient.request({ type: "rewind.execute", sessionId: sessionId!, entryId, mode: "conversation" }); }} onBranch={(entryId) => { void mockClient.request({ type: "session.fork", sessionId: sessionId!, entryId }); }} /></GenuiSessionProvider>}
			context={<ContextView client={mockClient} cwd={CWD} sessionId={sessionId} requireSession active={view === "context"} />}
			trajectory={<TrajectoryView entries={entries} active={view === "trajectory"} />}
			questionDock={{ requests: [], activeRequest: undefined, onAnswer: noop }}
			composer={<Composer client={mockClient} connected disabled={false} running={false} onSend={noop} onAbort={noop} onPause={noop} onResume={noop} providers={providers} model="debug/offline-agent" onModel={noop} thinkingLevel="high" onThinkingLevel={noop} approvalMode="confirm" onApprovalMode={noop} agentPresets={fixturePresets} defaultPresetId="standard" agentPreset="standard" agentPresetLocked onAgentPresetSelect={noop} sessionInfo={stats()} workspaceDir={CWD} projects={[CWD]} onSwitchProject={noop} commands={[]} searchFiles={async () => []} />}
		/>
	</div>;
}
createRoot(document.getElementById("app")!).render(
	<StrictMode>
		{comparison === "home" ? <DebugHomeComparison /> : <DebugMyself />}
	</StrictMode>,
);
