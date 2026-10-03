import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { applyEvent, rebuild, type ChatEntry } from "./transcript.ts";

const user = { role: "user", content: "检查项目" };
const calls = [
	{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
	{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "node --version" } },
];
const assistant = { role: "assistant", content: calls, stopReason: "toolUse" };
const result = (id: string, text: string, isError = false) => ({
	role: "toolResult", toolCallId: id, toolName: id === "read-1" ? "read" : "bash",
	content: [{ type: "text", text }], isError,
});
function event(entries: ChatEntry[], payload: Record<string, unknown>): ChatEntry[] {
	return applyEvent(entries, { type: "event", sessionId: "session", event: payload } as unknown as ServerEventMessage);
}
function current(entries: ChatEntry[]): Extract<ChatEntry, { kind: "assistant" }> {
	const found = entries.findLast((entry) => entry.kind === "assistant");
	assert.ok(found?.kind === "assistant");
	return found;
}
function started(): ChatEntry[] {
	let entries: ChatEntry[] = [{ kind: "user", text: "检查项目" }];
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	for (const [contentIndex, call] of calls.entries()) {
		entries = event(entries, { type: "message_update", assistantMessageEvent: {
			type: "toolcall_start", contentIndex, id: call.id, toolName: call.name,
		} });
		entries = event(entries, { type: "message_update", assistantMessageEvent: {
			type: "toolcall_end", contentIndex, toolCall: call,
		} });
	}
	return entries;
}

test("wire call ids survive argument generation without pretending execution completed", () => {
	const entries = started();
	assert.deepEqual(current(entries).tools.map(({ id, status }) => ({ id, status })), [
		{ id: "read-1", status: "pending" }, { id: "bash-1", status: "pending" },
	]);
	assert.equal(current(entries).tools[0].args, JSON.stringify(calls[0].arguments));
});

test("parallel tools settle independently while the agent is active and snapshots stay immutable", () => {
	let entries = started();
	for (const call of calls) entries = event(entries, {
		type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments,
	});
	const before = entries;
	entries = event(entries, { type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash",
		partialResult: { content: [{ type: "text", text: "working" }] } });
	assert.equal(current(entries).tools[1].output?.text, "working");
	assert.equal(current(before).tools[1].output, undefined);
	entries = event(entries, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read",
		result: { content: [{ type: "text", text: "file contents" }] }, isError: false });
	assert.equal(current(entries).tools[0].status, "ok");
	assert.equal(current(entries).tools[1].status, "running");
	assert.equal(current(before).tools[0].status, "running");
});

test("errors and explicit cancellation retain their output immediately", () => {
	let entries = started();
	entries = event(entries, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read",
		result: { content: [{ type: "text", text: "File not found" }] }, isError: true });
	entries = event(entries, { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash",
		result: { content: [{ type: "text", text: "Operation aborted" }] }, isError: true });
	assert.deepEqual(current(entries).tools.map((tool) => tool.status), ["error", "cancelled"]);
	assert.equal(current(entries).tools[0].output?.text, "File not found");
});

test("tool result artifacts and agent_end match replay without duplicating rows or losing history", () => {
	const history: ChatEntry[] = [{ kind: "user", text: "上一轮" }, { kind: "assistant", text: "旧回答", thinking: "", tools: [] }];
	let entries = [...history, ...started()];
	const readResult = { ...result("read-1", "截图"), content: [
		{ type: "text", text: "截图" }, { type: "image", data: "base64", mimeType: "image/png" },
	], details: { fullOutputPath: "D:/temp/output.txt" } };
	const bashResult = result("bash-1", "Command failed", true);
	entries = event(entries, { type: "message_end", message: assistant });
	entries = event(entries, { type: "message_end", message: readResult });
	assert.equal(current(entries).tools[0].output?.images?.[0].data, "base64");
	assert.equal(current(entries).tools[0].output?.fullPath, "D:/temp/output.txt");
	const messages = [user, assistant, readResult, bashResult, { role: "assistant", content: [{ type: "text", text: "完成" }] }];
	entries = event(entries, { type: "agent_end", messages });
	assert.deepEqual(entries, [...history, ...rebuild(messages)]);
	assert.deepEqual(event(entries, { type: "agent_end", messages }), entries);
	assert.equal(entries.filter((entry) => entry.kind === "toolResult").length, 0);
});

test("interrupted replay does not mark missing tool results successful, and a new turn stays isolated", () => {
	const previous = rebuild([user, { ...assistant, stopReason: "aborted", errorMessage: "Aborted" }]);
	assert.ok(current(previous).tools.every((tool) => tool.status === "cancelled"));
	let entries: ChatEntry[] = [...previous, { kind: "user", text: "新任务" }];
	const before = entries;
	entries = event(entries, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read",
		result: { content: [{ type: "text", text: "late old result" }] }, isError: false });
	assert.deepEqual(entries, before);
	assert.deepEqual(rebuild([user, assistant]).filter((entry) => entry.kind === "assistant")[0].tools.map((tool) => tool.status), ["pending", "pending"]);
});

test("text/tool/text order stays explicit through message finalization and replay", () => {
	const message = { role: "assistant", content: [
		{ type: "text", text: "我先检查" }, calls[0], { type: "text", text: "检查结果" },
	] };
	let entries = event([{ kind: "user", text: "检查项目" }], { type: "message_start", message });
	entries = event(entries, { type: "message_end", message });
	assert.deepEqual(current(entries).segments, [
		{ kind: "text", text: "我先检查" }, { kind: "tool", toolId: "read-1" }, { kind: "text", text: "检查结果" },
	]);
	assert.deepEqual(current(entries).segments, current(rebuild([user, message])).segments);
});

test("agent_end handles leading system patches and user-less continuation runs", () => {
	const entries = started();
	const withPatch = event(entries, { type: "agent_end", messages: [
		{ role: "system", content: "updated prompt" }, user, assistant, result("read-1", "read"), result("bash-1", "done"),
	] });
	assert.equal(withPatch.filter((entry) => entry.kind === "user").length, 1);
	const continuation = event(entries, { type: "agent_end", messages: [assistant, result("read-1", "read"), result("bash-1", "done")] });
	assert.equal(continuation.filter((entry) => entry.kind === "user").length, 1);
	assert.equal(current(continuation).tools[1].status, "ok");
});

test("nested execution stays with its parent and canonical replay retains its actual outcome", () => {
	let entries = started();
	entries = event(entries, { type: "tool_execution_start", toolCallId: "nested-1", toolName: "grep", args: { pattern: "TODO" }, parentToolCallId: "read-1" });
	entries = event(entries, { type: "tool_execution_end", toolCallId: "nested-1", toolName: "grep", parentToolCallId: "read-1", result: { content: [{ type: "text", text: "not found" }] }, isError: true });
	assert.equal(current(entries).tools.find((tool) => tool.id === "nested-1")?.status, "error");
	const persisted = { ...result("read-1", "parent done"), nestedCalls: { calls: [{ id: "nested-1", name: "grep", arguments: { pattern: "TODO" }, status: "error", error: "not found" }], complete: true } };
	entries = event(entries, { type: "agent_end", messages: [user, assistant, persisted] });
	const nested = current(entries).tools.find((tool) => tool.id === "nested-1");
	assert.equal(nested?.status, "error");
	assert.equal(nested?.parentToolCallId, "read-1");
	assert.equal(nested?.output?.text, "not found");
});

test("a user-less continuation replaces only its run and preserves the preceding assistant and tools", () => {
	const previous = rebuild([user, assistant, result("read-1", "file contents"), result("bash-1", "v24")]);
	let entries = event(previous, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "继续后的答案" } });
	const messages = [{ role: "assistant", content: [{ type: "text", text: "继续后的答案" }] }];
	entries = event(entries, { type: "agent_end", messages });
	assert.deepEqual(entries, [...previous, ...rebuild(messages)]);
	assert.equal(entries.filter((entry) => entry.kind === "assistant").length, 2);
	assert.equal((entries[1] as Extract<ChatEntry, { kind: "assistant" }>).tools[0].output?.text, "file contents");
	assert.deepEqual(event(entries, { type: "agent_end", messages }), entries);
	// A third run starts after the second one, rather than inheriting its boundary.
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "最后一个回答" }] }] });
	assert.equal(entries.filter((entry) => entry.kind === "assistant").length, 3);
});

test("agent_start includes the optimistic user for a new prompt without duplicating that user", () => {
	const history = rebuild([{ role: "user", content: "旧任务" }, { role: "assistant", content: [{ type: "text", text: "旧回答" }] }]);
	let entries: ChatEntry[] = [...history, { kind: "user", text: "检查项目" }];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "agent_end", messages: [user, assistant, result("read-1", "new file")] });
	assert.deepEqual(entries, [...history, ...rebuild([user, assistant, result("read-1", "new file")])]);
	assert.equal(entries.filter((entry) => entry.kind === "user").length, 2);
});
