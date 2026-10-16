import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AgentSession } from "../src/core/agent-session.ts";
import * as sessionServices from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type ExecutionAnomalyListResult, ExecutionAnomalyStore } from "../src/modes/desktop/execution-anomalies.ts";
import { EXECUTION_ANOMALY_REPORT_TOOL } from "../src/modes/desktop/execution-anomaly-extension.ts";
import type {
	DesktopClientRequestWithoutId,
	DesktopServerMessage,
	ServerResponseMessage,
	SessionSnapshotPayload,
} from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";
import * as toolsManager from "../src/utils/tools-manager.ts";

let root: string;
let agentDir: string;
let cwd: string;
let bridge: DesktopServerHandle | undefined;
let socket: WebSocket | undefined;
let noFetch: ReturnType<typeof vi.fn<typeof fetch>>;
const mounted = new Map<string, AgentSession>();
const messages: DesktopServerMessage[] = [];

beforeEach(async () => {
	root = resolve(await mkdtemp(join(tmpdir(), "owl-anomalies-bridge-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-anomalies-bridge-"))
		throw new Error("Unsafe execution anomaly bridge cleanup target");
	agentDir = join(root, "agent");
	cwd = join(root, "workspace");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ plugins: [], cacheWarming: { mode: "off" }, owlMemory: { enabled: false } }),
	);
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Network is forbidden in execution anomaly bridge tests");
	});
	vi.stubGlobal("fetch", noFetch);
	vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
	const create = sessionServices.createAgentSessionFromServices;
	vi.spyOn(sessionServices, "createAgentSessionFromServices").mockImplementation(async (options) => {
		const runtime = await create(options);
		mounted.set(runtime.session.sessionId, runtime.session);
		return runtime;
	});
	await connectBridge();
});

afterEach(async () => {
	socket?.terminate();
	socket = undefined;
	await bridge?.close();
	bridge = undefined;
	mounted.clear();
	messages.length = 0;
	expect(noFetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (root) await rm(root, { recursive: true, force: true });
});

async function connectBridge(): Promise<void> {
	bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
	socket = ws;
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as DesktopServerMessage));
	await new Promise<void>((done, reject) => {
		ws.once("open", done);
		ws.once("error", reject);
	});
}

type MalformedListRequest = {
	type: "execution.anomalies.list";
	status?: unknown;
	query?: unknown;
	processing?: unknown;
};

function rpc<T = unknown>(
	payload: DesktopClientRequestWithoutId | MalformedListRequest,
): Promise<ServerResponseMessage & { result?: T }> {
	const ws = socket;
	if (!ws) throw new Error("Missing fixture WebSocket");
	const id = randomUUID();
	return new Promise((done, reject) => {
		const receive = (data: unknown): void => {
			const message = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
			if (message.type !== "response" || message.id !== id) return;
			clearTimeout(timer);
			ws.off("message", receive);
			done(message);
		};
		const timer = setTimeout(() => {
			ws.off("message", receive);
			reject(new Error(`Execution anomaly bridge RPC timed out: ${payload.type}`));
		}, 10_000);
		ws.on("message", receive);
		ws.send(JSON.stringify({ ...payload, id }));
	});
}

function failure(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "Fixture command exited with code 1" }],
		isError: true,
		timestamp: 100,
	};
}

describe("execution anomalies through the real desktop bridge", () => {
	it("validates settings list input and reads filtered records from the shared persistent store", async () => {
		expect(await rpc({ type: "execution.anomalies.list" })).toMatchObject({
			ok: true,
			result: { records: [], total: 0 },
		});
		expect(await rpc({ type: "execution.anomalies.list", status: "unknown" })).toMatchObject({
			ok: false,
			error: "执行异常日志状态无效",
		});
		expect(await rpc({ type: "execution.anomalies.list", query: 123 })).toMatchObject({
			ok: false,
			error: "执行异常搜索内容无效",
		});
		expect(await rpc({ type: "execution.anomalies.list", processing: "unknown" })).toMatchObject({
			ok: false,
			error: "执行异常处理筛选无效",
		});
		const log = new ExecutionAnomalyStore(agentDir);
		log.record({ sessionId: "s1", kind: "tool_error", summary: "Missing fixture file", timestamp: 100 });
		const reported = log.record({
			sessionId: "s2",
			kind: "model_error",
			summary: "Fixture HTTP 503",
			timestamp: 200,
		});
		log.report("s2", {
			id: reported.id,
			cause: "Service unavailable",
			action: "Deferred retry",
			outcome: "unresolved",
		});
		const filtered = await rpc<ExecutionAnomalyListResult>({
			type: "execution.anomalies.list",
			query: "HTTP 503",
			status: "reported",
		});
		expect(filtered.result?.total).toBe(1);
		expect(filtered.result?.records[0].id).toBe(reported.id);
		expect(
			(await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list", sessionId: "s1" })).result?.records,
		).toEqual([expect.objectContaining({ sessionId: "s1", status: "pending" })]);
	});

	it("soft-processes and restores an anomaly without changing observed evidence or its model report", async () => {
		const log = new ExecutionAnomalyStore(agentDir);
		const observed = log.record({
			sessionId: "processing-session",
			kind: "tool_error",
			summary: "Fixture wrong path",
		});
		const original = log.report(observed.sessionId, {
			id: observed.id,
			cause: "Fixture path typo",
			action: "Read verified path",
			outcome: "resolved",
		});
		const originalWire: typeof original = JSON.parse(JSON.stringify(original));
		const fields = {
			type: "execution.anomalies.process" as const,
			anomalyId: observed.id,
			kind: "optimized" as const,
			note: "Preserve exact discovered paths",
			verification: "Fixture verified",
		};
		expect(await rpc({ ...fields, verification: " " })).toMatchObject({ ok: false });
		expect(log.get(observed.id)).toEqual(original);
		const changedBefore = messages.filter((message) => message.type === "execution.anomalies.changed").length;
		expect(await rpc(fields)).toMatchObject({
			ok: true,
			result: {
				...originalWire,
				processing: { kind: "optimized", note: fields.note, verification: fields.verification },
			},
		});
		expect((await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list" })).result?.total).toBe(0);
		expect(
			(await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list", processing: "optimized" })).result
				?.records,
		).toEqual([expect.objectContaining({ id: original.id, report: original.report })]);
		expect(
			(await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list", processing: "all" })).result?.total,
		).toBe(1);
		await vi.waitFor(() =>
			expect(messages.filter((message) => message.type === "execution.anomalies.changed").length).toBeGreaterThan(
				changedBefore,
			),
		);
		expect(await rpc({ type: "execution.anomalies.restore", anomalyId: original.id })).toMatchObject({
			ok: true,
			result: originalWire,
		});
		expect((await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list" })).result?.records).toEqual([
			originalWire,
		]);
	});

	it("imports only the resumed history branch and deduplicates it after a cold bridge restart", async () => {
		const history = SessionManager.create(cwd, join(agentDir, "Owl-history", "fixture"));
		const fork = history.appendMessage({ role: "user", content: "Fixture task", timestamp: 50 });
		history.appendMessage(failure("abandoned-error"));
		history.branch(fork);
		history.appendMessage(failure("current-error"));
		const resumed = await rpc({ type: "session.resume", sessionId: history.getSessionId() });
		expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
		const before = await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list" });
		expect(before.result?.records).toEqual([
			expect.objectContaining({ sessionId: history.getSessionId(), toolCallId: "current-error", status: "pending" }),
		]);
		socket?.terminate();
		socket = undefined;
		await bridge?.close();
		bridge = undefined;
		await connectBridge();
		expect((await rpc({ type: "session.resume", sessionId: history.getSessionId() })).ok).toBe(true);
		const after = await rpc<ExecutionAnomalyListResult>({ type: "execution.anomalies.list" });
		expect(after.result).toEqual(before.result);
	});

	it("keeps the real report tool active in minimal and Pi, permits it in plan mode, and broadcasts reports", async () => {
		const log = new ExecutionAnomalyStore(agentDir);
		for (const agentPreset of ["minimal", "pi"]) {
			const created = await rpc<SessionSnapshotPayload>({
				type: "session.create",
				agentPreset,
				approvalMode: "plan",
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			const sessionId = created.result!.sessionId;
			const session = mounted.get(sessionId);
			if (!session) throw new Error("Missing real mounted session");
			expect(session.getActiveToolNames()).toContain(EXECUTION_ANOMALY_REPORT_TOOL);
			expect(session.getAllTools().map((tool) => tool.name)).toContain(EXECUTION_ANOMALY_REPORT_TOOL);
			const item = log.record({ sessionId, kind: "tool_error", summary: `${agentPreset} fixture failure` });
			const input = { id: item.id, cause: "Fixture cause", action: "Fixture verification", outcome: "resolved" };
			expect(
				(
					await session.extensionRunner.emitToolCall({
						type: "tool_call",
						toolCallId: "report-fixture",
						toolName: EXECUTION_ANOMALY_REPORT_TOOL,
						input,
					})
				)?.block,
			).not.toBe(true);
			const tool = session.agent.state.tools.find((candidate) => candidate.name === EXECUTION_ANOMALY_REPORT_TOOL);
			if (!tool) throw new Error("Report tool absent from model's actual loadout");
			const changedBefore = messages.filter((message) => message.type === "execution.anomalies.changed").length;
			const execution = await tool.execute("report-fixture", input, undefined, undefined);
			expect(execution.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("已补充执行异常记录") }),
			]);
			await vi.waitFor(() =>
				expect(messages.filter((message) => message.type === "execution.anomalies.changed").length).toBeGreaterThan(
					changedBefore,
				),
			);
			expect(log.get(item.id)).toMatchObject({
				status: "reported",
				report: { outcome: "resolved", cause: "Fixture cause" },
			});
		}
	});
});
