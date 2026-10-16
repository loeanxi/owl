import { afterEach, describe, expect, it } from "vitest";
import {
	cancelAllPendingQuestions,
	cancelPendingQuestionsForSession,
	getAllPendingQuestionRequests,
	getPendingQuestionRequests,
	getQuestionChannel,
	type QuestionOutcome,
	registerPendingQuestion,
	resolveQuestion,
	setQuestionChannel,
} from "../src/core/question-channel.ts";
import type { DesktopServerMessage, QuestionRequestMessage } from "../src/modes/desktop/protocol.ts";

function question(requestId: string, sessionId: string): QuestionRequestMessage {
	return {
		type: "question_request",
		requestId,
		sessionId,
		toolCallId: `tool-${requestId}`,
		questions: [
			{
				header: "采集范围",
				question: "先看样本还是继续整理？",
				multiSelect: false,
				options: [{ label: "先看样本", description: "先核对两条记录", preview: "样本预览" }, { label: "继续整理" }],
			},
		],
	};
}

describe("pending question replay after reconnect", () => {
	afterEach(() => {
		cancelAllPendingQuestions();
		setQuestionChannel(undefined);
	});

	it("replays the complete unresolved message only to its own session without broadcasting again", () => {
		const sent: DesktopServerMessage[] = [];
		setQuestionChannel({ broadcast: (message) => sent.push(message), hasConnectedClients: () => true });
		const channel = getQuestionChannel();
		expect(channel?.hasConnectedClients()).toBe(true);
		for (const [requestId, sessionId] of [
			["first", "research"],
			["second", "research"],
			["other", "main"],
		]) {
			const message = question(requestId, sessionId);
			registerPendingQuestion(requestId, { sessionId, toolCallId: message.toolCallId, resolve: () => {} });
			channel?.broadcast(message);
		}
		expect(getPendingQuestionRequests("research")).toEqual([
			question("first", "research"),
			question("second", "research"),
		]);
		expect(getPendingQuestionRequests("main")).toEqual([question("other", "main")]);
		expect(getPendingQuestionRequests("missing")).toEqual([]);
		expect(sent).toHaveLength(3);
	});

	it("keeps replay payloads isolated from mutable tool or client objects", () => {
		setQuestionChannel({ broadcast: () => {}, hasConnectedClients: () => true });
		const original = question("first", "research");
		registerPendingQuestion(original.requestId, {
			sessionId: original.sessionId,
			toolCallId: original.toolCallId,
			resolve: () => {},
		});
		getQuestionChannel()?.broadcast(original);
		original.questions[0].options[0].label = "changed by caller";
		const restored = getPendingQuestionRequests("research");
		expect(restored).toEqual([question("first", "research")]);
		restored[0].questions[0].options[0].preview = "changed by client";
		expect(getPendingQuestionRequests("research")).toEqual([question("first", "research")]);
	});

	it("does not replay unregistered, mismatched or unrelated broadcasts", () => {
		const sent: DesktopServerMessage[] = [];
		setQuestionChannel({ broadcast: (message) => sent.push(message), hasConnectedClients: () => false });
		const channel = getQuestionChannel();
		expect(channel?.hasConnectedClients()).toBe(false);
		channel?.broadcast(question("unregistered", "research"));
		registerPendingQuestion("registered", {
			sessionId: "research",
			toolCallId: "tool-registered",
			resolve: () => {},
		});
		channel?.broadcast(question("registered", "main"));
		channel?.broadcast({ ...question("registered", "research"), toolCallId: "wrong-tool" });
		channel?.broadcast({ type: "event", sessionId: "research", event: { type: "agent_start" } });
		expect(getPendingQuestionRequests("research")).toEqual([]);
		expect(getPendingQuestionRequests("main")).toEqual([]);
		expect(sent).toHaveLength(4);
	});

	it("removes resolved and cancelled messages while preserving other sessions", () => {
		const outcomes: Record<string, QuestionOutcome> = {};
		setQuestionChannel({ broadcast: () => {}, hasConnectedClients: () => true });
		for (const [requestId, sessionId] of [
			["answer", "research"],
			["cancel", "research"],
			["other", "main"],
		]) {
			const message = question(requestId, sessionId);
			registerPendingQuestion(requestId, {
				sessionId,
				toolCallId: message.toolCallId,
				resolve: (outcome) => {
					outcomes[requestId] = outcome;
				},
			});
			getQuestionChannel()?.broadcast(message);
		}
		const answered = { cancelled: false, answers: [{ index: 0, selectedLabels: ["先看样本"] }] };
		expect(resolveQuestion("answer", answered)).toBe(true);
		expect(resolveQuestion("answer", answered)).toBe(false);
		expect(outcomes.answer).toEqual(answered);
		expect(getPendingQuestionRequests("research").map((message) => message.requestId)).toEqual(["cancel"]);
		cancelPendingQuestionsForSession("research");
		expect(outcomes.cancel).toEqual({ cancelled: true, answers: [] });
		expect(getPendingQuestionRequests("research")).toEqual([]);
		expect(getPendingQuestionRequests("main")).toEqual([question("other", "main")]);
		cancelAllPendingQuestions();
		expect(outcomes.other).toEqual({ cancelled: true, answers: [] });
		expect(getPendingQuestionRequests("main")).toEqual([]);
	});

	it("does not reuse a stale payload when a request registration is replaced", () => {
		setQuestionChannel({ broadcast: () => {}, hasConnectedClients: () => true });
		const message = question("reused", "research");
		registerPendingQuestion(message.requestId, {
			sessionId: message.sessionId,
			toolCallId: message.toolCallId,
			resolve: () => {},
		});
		getQuestionChannel()?.broadcast(message);
		registerPendingQuestion(message.requestId, { sessionId: "main", toolCallId: "new-tool", resolve: () => {} });
		expect(getPendingQuestionRequests("research")).toEqual([]);
		expect(getPendingQuestionRequests("main")).toEqual([]);
		setQuestionChannel(undefined);
		expect(getQuestionChannel()).toBeUndefined();
	});

	it("broadcasts a terminal decision once, without including answer contents", () => {
		const sent: DesktopServerMessage[] = [];
		const resolved: QuestionOutcome[] = [];
		setQuestionChannel({ broadcast: (message) => sent.push(message), hasConnectedClients: () => true });
		const message = question("answered", "research");
		registerPendingQuestion(message.requestId, {
			sessionId: message.sessionId,
			toolCallId: message.toolCallId,
			resolve: (outcome) => resolved.push(outcome),
		});
		getQuestionChannel()?.broadcast(message);
		const outcome = { cancelled: false, answers: [{ index: 0, customText: "private answer", note: "private note" }] };
		expect(resolveQuestion(message.requestId, outcome)).toBe(true);
		expect(resolveQuestion(message.requestId, outcome)).toBe(false);
		expect(sent.filter((item) => item.type === "event")).toEqual([
			{
				type: "event",
				sessionId: "research",
				event: { type: "question_resolved", requestId: "answered", cancelled: false, reason: "response" },
			},
		]);
		expect(resolved).toEqual([outcome]);
		expect(getAllPendingQuestionRequests()).toEqual([]);
	});

	it("broadcasts scoped cancellation and shutdown for each retired request", () => {
		const sent: DesktopServerMessage[] = [];
		setQuestionChannel({ broadcast: (message) => sent.push(message), hasConnectedClients: () => true });
		for (const [requestId, sessionId] of [
			["first", "research"],
			["second", "research"],
			["other", "main"],
		]) {
			registerPendingQuestion(requestId, { sessionId, toolCallId: requestId, resolve: () => {} });
			getQuestionChannel()?.broadcast({ ...question(requestId, sessionId), toolCallId: requestId });
		}
		cancelPendingQuestionsForSession("research");
		expect(getAllPendingQuestionRequests().map((item) => item.requestId)).toEqual(["other"]);
		expect(sent.filter((item) => item.type === "event")).toEqual(
			["first", "second"].map((requestId) => ({
				type: "event",
				sessionId: "research",
				event: { type: "question_resolved", requestId, cancelled: true, reason: "cancelled" },
			})),
		);
		cancelAllPendingQuestions();
		expect(sent.at(-1)).toEqual({
			type: "event",
			sessionId: "main",
			event: { type: "question_resolved", requestId: "other", cancelled: true, reason: "cancelled" },
		});
		expect(getAllPendingQuestionRequests()).toEqual([]);
	});

	it("settles all tools even if a disconnected notification sink throws", () => {
		const outcomes: QuestionOutcome[] = [];
		setQuestionChannel({
			broadcast: () => {
				throw new Error("socket disconnected");
			},
			hasConnectedClients: () => false,
		});
		for (const requestId of ["first", "second"])
			registerPendingQuestion(requestId, {
				sessionId: "research",
				toolCallId: requestId,
				resolve: (outcome) => outcomes.push(outcome),
			});
		expect(() => cancelAllPendingQuestions()).not.toThrow();
		expect(outcomes).toEqual([
			{ cancelled: true, answers: [] },
			{ cancelled: true, answers: [] },
		]);
	});
});
