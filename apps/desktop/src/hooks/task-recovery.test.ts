import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../bridge/client.ts";
import type { SessionStatsResult } from "../bridge/protocol.ts";
import { t } from "../i18n/index.ts";
import { continueTask, taskRecovery } from "./task-recovery.ts";
import { applyRetryEvent, type ChatEntry, type RetryBannerState, type ToolCard } from "./transcript.ts";
import type { ServerEventMessage } from "../bridge/protocol.ts";

type Assistant = Extract<ChatEntry, { kind: "assistant" }>;
const user: ChatEntry = { kind: "user", text: "完成当前任务" };
const failed = (overrides: Partial<Assistant> = {}): Assistant => ({ kind: "assistant", text: "已检查文件", thinking: "", tools: [], error: "network offline", entryId: "failed-response", ...overrides });
const oldRetry: RetryBannerState = { phase: "failed", attempt: 3, reason: "old failure" };

describe("task recovery eligibility", () => {
	it("keeps an accepted request failure actionable even before a new assistant response exists", () => {
		const wire = (event: Record<string, unknown>): ServerEventMessage => ({ type: "event", sessionId: "current", event });
		const stopped = failed({ error: undefined, aborted: true });
		const status = applyRetryEvent(null, wire({ type: "auto_retry_end", success: false, attempt: 0, finalError: "post-acceptance failure", requestFailed: true }));
		expect(taskRecovery([user, stopped], status)?.reason).toBe("post-acceptance failure");
		expect(taskRecovery([user], status)?.reason).toBe("post-acceptance failure");
		expect(applyRetryEvent(status, wire({ type: "agent_start" }))).toBeNull();
		expect(applyRetryEvent(status, wire({ type: "agent_settled", aborted: true }))).toBeNull();
	});
	it("counts saved tool results and distinguishes uncertain tool executions within the failed turn", () => {
		const tool = (id: string, status: ToolCard["status"], output = false): ToolCard => ({ id, status, name: "read", args: "{}", summary: id, ...(output ? { output: { text: "saved", totalLines: 1 } } : {}) });
		const earlier = failed({ error: undefined, tools: [tool("old-turn", "ok", true)] });
		const entries = [earlier, user, failed({ error: undefined, tools: [tool("read", "ok", true), tool("write", "running")] }), failed({ tools: [tool("command", "error", true), tool("pending", "pending")] })];
		expect(taskRecovery(entries)).toEqual({ id: "failed-response:network offline", reason: "network offline", completedTools: 2, uncertainTools: 2 });
	});

	it("does not resurrect an old failure after a new user turn or successful response", () => {
		expect(taskRecovery([user, failed(), { kind: "user", text: "下一项任务" }], oldRetry)).toBeUndefined();
		expect(taskRecovery([user, failed(), failed({ error: undefined, text: "已完成", entryId: "success", endedAt: 200 })], oldRetry)).toBeUndefined();
	});

	it("does not offer recovery during automatic retry or for a user-initiated stop", () => {
		expect(taskRecovery([user, failed()], { phase: "retrying", attempt: 2, maxAttempts: 3, delayMs: 100, startedAt: 0 })).toBeUndefined();
		expect(taskRecovery([user, failed({ aborted: true })], oldRetry)).toBeUndefined();
		expect(taskRecovery([], oldRetry)).toBeUndefined();
	});
});

describe("continueTask", () => {
	it("awaits the chosen model before continuing the same session without rewinding history", async () => {
		const stats: SessionStatsResult = { thinkingLevel: "high", availableThinkingLevels: ["high"], supportsThinking: true };
		const modelChange = Promise.withResolvers<{ ok: boolean; result: SessionStatsResult }>();
		const client = new BridgeClient("ws://fixture.invalid/ws");
		const request = vi.spyOn(client, "request").mockReturnValueOnce(modelChange.promise).mockResolvedValueOnce({ ok: true });
		const continuation = continueTask(client, "current-session", "provider/model/variant");
		expect(request).toHaveBeenCalledExactlyOnceWith({ type: "session.setModel", sessionId: "current-session", provider: "provider", model: "model/variant" });
		modelChange.resolve({ ok: true, result: stats });
		expect(await continuation).toEqual(stats);
		expect(request.mock.calls.map(([payload]) => payload)).toEqual([
			{ type: "session.setModel", sessionId: "current-session", provider: "provider", model: "model/variant" },
			{ type: "session.continue", sessionId: "current-session", message: t("app.resumePrompt") },
		]);
	});

	it("does not continue when the chosen model cannot be applied", async () => {
		const client = new BridgeClient("ws://fixture.invalid/ws");
		const request = vi.spyOn(client, "request").mockResolvedValue({ ok: false, error: "model unavailable" });
		await expect(continueTask(client, "current-session", "provider/model")).rejects.toThrow("model unavailable");
		expect(request).toHaveBeenCalledOnce();
	});

	it("continues with the current model and propagates failure for another attempt", async () => {
		const client = new BridgeClient("ws://fixture.invalid/ws");
		const request = vi.spyOn(client, "request").mockResolvedValueOnce({ ok: false, error: "offline" }).mockResolvedValueOnce({ ok: true });
		await expect(continueTask(client, "current-session")).rejects.toThrow("offline");
		await expect(continueTask(client, "current-session")).resolves.toBeUndefined();
		expect(request.mock.calls.map(([payload]) => payload.type)).toEqual(["session.continue", "session.continue"]);
	});

	it.each(["invalid", "/model", "provider/"])("rejects invalid model selection %s before making requests", async (model) => {
		const client = new BridgeClient("ws://fixture.invalid/ws");
		const request = vi.spyOn(client, "request");
		await expect(continueTask(client, "current-session", model)).rejects.toThrow(t("recovery.invalidModel"));
		expect(request).not.toHaveBeenCalled();
	});
});
