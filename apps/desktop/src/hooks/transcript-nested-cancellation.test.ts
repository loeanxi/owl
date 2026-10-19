import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { workActionFacts } from "../components/work-process-model.ts";
import { applyEvent, type ChatEntry, rebuild } from "./transcript.ts";

const user = { role: "user", content: "检查项目，随后停止这轮执行" };
const assistant = {
	role: "assistant",
	content: [{ type: "toolCall", id: "code-1", name: "codemode", arguments: { code: "await tools.read({path: 'a.ts'})" } }],
	stopReason: "toolUse",
};

function event(entries: ChatEntry[], payload: Record<string, unknown>): ChatEntry[] {
	return applyEvent(entries, { type: "event", sessionId: "nested-cancellation", event: payload } as unknown as ServerEventMessage);
}

function tools(entries: ChatEntry[]) {
	return entries.flatMap((entry) => entry.kind === "assistant" ? entry.tools : []);
}

for (const withFailure of [false, true]) {
	test(`nested cancellation stays cancelled through live result, agent_end and reload (real error=${withFailure})`, () => {
		const calls = [
			{ id: "code-1/1", name: "read", arguments: { path: "a.ts" }, status: "error", error: "Operation aborted" },
			...(withFailure ? [{ id: "code-1/2", name: "read", arguments: { path: "missing.ts" }, status: "error", error: "ENOENT: missing.ts" }] : []),
		];
		let entries = event(rebuild([user]), { type: "agent_start" });
		entries = event(entries, { type: "message_start", message: assistant });
		entries = event(entries, { type: "message_end", message: assistant });
		for (const call of calls) {
			entries = event(entries, { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments, parentToolCallId: "code-1" });
			entries = event(entries, {
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: call.name,
				parentToolCallId: "code-1",
				isError: true,
				result: { content: [{ type: "text", text: call.error }] },
			});
		}
		const assertOutcomes = (state: ChatEntry[]) => {
			const cards = tools(state);
			assert.equal(cards.find((card) => card.id === "code-1/1")?.status, "cancelled");
			assert.equal(cards.find((card) => card.id === "code-1/1")?.output?.text, "Operation aborted");
			const facts = workActionFacts(cards.map((card) => ({ key: card.id, card })));
			assert.deepEqual(facts.issues.map(({ card }) => card.id), withFailure ? ["code-1/2"] : []);
			if (withFailure) assert.equal(cards.find((card) => card.id === "code-1/2")?.output?.text, "ENOENT: missing.ts");
		};
		assertOutcomes(entries);
		const before = entries;
		const persisted = {
			role: "toolResult",
			toolCallId: "code-1",
			toolName: "codemode",
			isError: true,
			content: [{ type: "text", text: "Operation aborted" }],
			nestedCalls: { calls, complete: true },
		};
		entries = event(entries, { type: "message_end", message: persisted });
		assertOutcomes(entries);
		assertOutcomes(before);
		const messages = [user, assistant, persisted];
		entries = event(entries, { type: "agent_end", messages });
		entries = event(entries, { type: "agent_settled", aborted: true });
		assertOutcomes(entries);
		assertOutcomes(rebuild(messages));
	});
}

test("nested ledger keeps real errors that merely mention cancellation and does not relabel success", () => {
	const messages = [user, assistant, {
		role: "toolResult",
		toolCallId: "code-1",
		toolName: "codemode",
		isError: false,
		content: [{ type: "text", text: "Collected child results." }],
		nestedCalls: {
			complete: true,
			calls: [
				{ id: "code-1/1", name: "read", status: "error", error: "Operation aborted: permission denied" },
				{ id: "code-1/2", name: "read", status: "error" },
				{ id: "code-1/3", name: "read", status: "error", error: "  Operation aborted\n" },
				{ id: "code-1/4", name: "read", status: "ok", error: "Operation aborted" },
				{ id: "code-1/5", name: "read", status: "unfinished" },
			],
		},
	}];
	const cards = tools(rebuild(messages));
	assert.deepEqual(cards.map((card) => card.status), ["ok", "error", "error", "cancelled", "ok", "cancelled"]);
	assert.deepEqual(workActionFacts(cards.map((card) => ({ key: card.id, card }))).issues.map(({ card }) => card.id), ["code-1/1", "code-1/2"]);
});
