import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResearchResult } from "../bridge/protocol.ts";
import { applyEvent, type ChatEntry, rebuild } from "./transcript.ts";

const published: ResearchResult = {
	id: "research-result-1",
	createdAt: "unknown",
	mode: "binary",
	status: "partial",
	title: "静态分析",
	summary: "来自工具保存的结果",
	columns: [],
	rows: [],
	sources: [],
	findings: [{ kind: "unverified", text: "尚未动态验证", sourceIds: [] }],
};

function resultMessage(result: ResearchResult = published): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: "missing-call",
		toolName: "research_publish",
		content: [{ type: "text", text: "已整理\n详情保存在结果中" }],
		isError: false,
		details: { researchResult: result },
	};
}

function event(entries: ChatEntry[], payload: Record<string, unknown>): ChatEntry[] {
	return applyEvent(entries, { type: "event", sessionId: "research-session", event: payload });
}

function orphans(entries: ChatEntry[]): Extract<ChatEntry, { kind: "toolResult" }>[] {
	return entries.filter((entry): entry is Extract<ChatEntry, { kind: "toolResult" }> => entry.kind === "toolResult");
}

test("restored orphan research results retain their payload without requiring message timestamps or calls", () => {
	const entries = rebuild([
		{ role: "user", content: "分析文件" },
		resultMessage(),
		{ role: "user", content: "还要多久" },
		{ role: "assistant", content: [{ type: "text", text: "正在处理" }] },
	]);
	assert.equal(entries[1].kind, "toolResult");
	assert.deepEqual(orphans(entries)[0].researchResult, published);
	assert.equal(orphans(entries)[0].brief, "已整理");
	assert.equal(orphans(entries)[0].toolName, "research_publish");
});

test("restored orphan error, cancellation, invalid payload and prose carry no research evidence", () => {
	for (const message of [
		{ ...resultMessage(), isError: true },
		{ ...resultMessage(), details: { researchResult: published, cancelled: true } },
		{ ...resultMessage(), details: { researchResult: { ...published, title: "" } } },
		{ ...resultMessage(), details: undefined, content: [{ type: "text", text: JSON.stringify(published) }] },
	]) {
		const entries = rebuild([{ role: "user", content: "分析" }, message]);
		assert.equal(orphans(entries).length, 1);
		assert.equal(orphans(entries)[0].researchResult, undefined);
	}
});

test("live orphan execution and message events publish once and retain a corrected result", () => {
	const initial: ChatEntry[] = [{ kind: "user", text: "分析" }];
	let entries = event(initial, {
		type: "tool_execution_end",
		toolCallId: "missing-call",
		toolName: "research_publish",
		result: { content: [{ type: "text", text: "已整理" }], details: { researchResult: published } },
		isError: false,
	});
	assert.equal(initial.length, 1);
	assert.equal(orphans(entries).length, 1);
	assert.equal(orphans(entries)[0].toolName, "research_publish");
	assert.deepEqual(orphans(entries)[0].researchResult, published);
	const before = entries;
	const revised = { ...published, summary: "补充后的结果" };
	entries = event(entries, { type: "message_end", message: resultMessage(revised) });
	assert.equal(orphans(entries).length, 1);
	assert.deepEqual(orphans(entries)[0].researchResult, revised);
	assert.deepEqual(orphans(before)[0].researchResult, published);
});

test("live orphan messages without tool-call identity preserve successful structured research results", () => {
	const entries = event([{ kind: "user", text: "分析" }], {
		type: "message_end",
		message: { ...resultMessage(), toolCallId: undefined },
	});
	assert.deepEqual(orphans(entries)[0].researchResult, published);
});

test("live orphan errors, cancellation, invalid evidence and ordinary tool output remain ignored", () => {
	const initial: ChatEntry[] = [{ kind: "user", text: "分析" }];
	for (const [result, isError] of [
		[resultMessage(), true],
		[{ ...resultMessage(), details: { researchResult: published, cancelled: true } }, false],
		[{ ...resultMessage(), details: { researchResult: { ...published, rows: [{ unexpected: true }] } } }, false],
		[{ ...resultMessage(), details: undefined, content: [{ type: "text", text: JSON.stringify(published) }] }, false],
	] as const) {
		assert.equal(
			event(initial, {
				type: "tool_execution_end",
				toolCallId: "missing-call",
				toolName: "research_publish",
				result,
				isError,
			}),
			initial,
		);
	}
	assert.equal(event(initial, { type: "message_end", message: { ...resultMessage(), toolName: "read" } }), initial);
});

test("late results belonging to a prior tool call cannot attach to a new user turn", () => {
	const initial = rebuild([
		{ role: "user", content: "旧任务" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "missing-call", name: "research_publish", arguments: {} }],
		},
		{ role: "user", content: "新任务" },
	]);
	assert.equal(event(initial, { type: "message_end", message: resultMessage() }), initial);
	assert.equal(orphans(initial).length, 0);
});

test("queued follow-ups do not prevent orphan publication events from merging in the current turn", () => {
	let entries: ChatEntry[] = [
		{ kind: "user", text: "分析" },
		{ kind: "user", text: "稍后看另一文件", queued: true },
	];
	entries = event(entries, { type: "message_end", message: resultMessage() });
	entries = event(entries, { type: "message_end", message: resultMessage() });
	assert.equal(orphans(entries).length, 1);
	assert.equal(entries.filter((entry) => entry.kind === "user" && entry.queued).length, 1);
});

test("an orphan republished in another user turn keeps each turn's own revision", () => {
	let entries = event([{ kind: "user", text: "分析" }], { type: "message_end", message: resultMessage() });
	entries = [...entries, { kind: "user", text: "补充分析" }];
	const revised = { ...published, summary: "补充分析结果" };
	entries = event(entries, { type: "message_end", message: resultMessage(revised) });
	assert.deepEqual(
		orphans(entries).map((entry) => entry.researchResult),
		[published, revised],
	);
});

test("agent_end restores an orphan publication without duplicating a live artifact or losing history", () => {
	const history: ChatEntry[] = [
		{ kind: "user", text: "旧问题" },
		{ kind: "assistant", text: "旧回答", thinking: "", tools: [] },
	];
	let entries = event([...history, { kind: "user", text: "分析" }], { type: "agent_start" });
	entries = event(entries, { type: "message_end", message: resultMessage() });
	const messages = [{ role: "user", content: "分析" }, resultMessage()];
	entries = event(entries, { type: "agent_end", messages });
	assert.deepEqual(entries, [...history, ...rebuild(messages)]);
	assert.equal(orphans(entries).length, 1);
	assert.deepEqual(orphans(entries)[0].researchResult, published);
});
