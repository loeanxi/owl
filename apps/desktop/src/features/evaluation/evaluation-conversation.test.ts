import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationResultView, EvaluationRunView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import { conversationMarkdown, evaluationConversations, evaluationHasLiveWork } from "./evaluation-conversation.ts";

function result(id: string, retryOf: string | null = null, attempt = 1): EvaluationResultView {
	return { id, retryOf, attempt, taskId: "G01", sample: 1, anonymousLabel: id, revealed: false, status: "completed", output: "answer", thinking: "", artifact: null, checks: [], error: null, rating: null, followups: [] };
}

test("retry chains remain in their original shuffled window and keep every scoring identity", () => {
	const originalB = result("B");
	const originalA = result("A");
	const retryA = result("C", "A", 2);
	const secondRetryA = result("D", "C", 3);
	const groups = evaluationConversations([originalB, originalA, retryA, secondRetryA]);
	assert.deepEqual(groups.map((group) => group.root.id), ["B", "A"]);
	assert.deepEqual(groups[1].attempts.map((entry) => entry.id), ["A", "C", "D"]);
});

test("orphan retry records and cycles terminate without hiding any attempt", () => {
	const orphan = result("orphan", "missing", 2);
	const cycleA = result("a", "b");
	const cycleB = result("b", "a", 2);
	const groups = evaluationConversations([orphan, cycleA, cycleB]);
	assert.deepEqual(groups.flatMap((group) => group.attempts.map((entry) => entry.id)).sort(), ["a", "b", "orphan"]);
});

test("conversation text renders Markdown while raw HTML, scripts and images cannot execute or load", () => {
	const html = conversationMarkdown('**bold**\n<script>alert(1)</script>\n<img src="https://example.com/pixel" onerror="alert(1)">\n![tracking](https://example.com/pixel)\n[bad](javascript:alert(1))');
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script|<img|href="javascript:/);
	assert.match(html, /tracking/);
});

test("a completed benchmark continues polling while a conversation has live work", () => {
	const fixture = { status: "completed", results: [result("A")] } as EvaluationRunView;
	assert.equal(evaluationHasLiveWork(fixture), false);
	fixture.results[0].followups = [{ id: "followup", prompt: "follow up", status: "running", output: "", thinking: "", artifact: null, checks: [], error: null }];
	assert.equal(evaluationHasLiveWork(fixture), true);
	fixture.results[0].followups[0].status = "cancelled";
	assert.equal(evaluationHasLiveWork(fixture), false);
});
