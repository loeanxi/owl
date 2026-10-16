import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { applyEvent, applyRetryEvent, estimateTokens, outputRate, rebuild, type ChatEntry, type RetryBannerState } from "./transcript.ts";

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

test("message_end drops tool cards the assistant message no longer contains", () => {
	let entries = started();
	entries = event(entries, {
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "This response contained 17 tool calls, over the limit of 16. None were executed." }],
		},
	});
	assert.deepEqual(current(entries).tools, []);
	assert.match(current(entries).text, /over the limit of 16/);
});

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

test("user prompt images survive the authoritative rebuild", () => {
	const withImage = {
		role: "user",
		content: [{ type: "text", text: "看这张截图" }, { type: "image", data: "aGk=", mimeType: "image/png" }],
	};
	const entries = rebuild([withImage, assistant, result("read-1", "done")]);
	const userEntry = entries.find((entry) => entry.kind === "user") as Extract<ChatEntry, { kind: "user" }>;
	assert.equal(userEntry.text, "看这张截图");
	assert.deepEqual(userEntry.images, [{ data: "aGk=", mimeType: "image/png" }]);
	// 纯文本用户消息不带 images 字段
	const plain = rebuild([user]).at(0) as Extract<ChatEntry, { kind: "user" }>;
	assert.equal(plain.images, undefined);
	// agent_end 用含图片的用户快照整轮重建后，附图仍在
	const snapshot = [withImage, { role: "assistant", content: [{ type: "text", text: "收到" }] }];
	const replayed = event(rebuild([withImage]), { type: "agent_end", messages: snapshot });
	assert.deepEqual((replayed.at(0) as Extract<ChatEntry, { kind: "user" }>).images, [{ data: "aGk=", mimeType: "image/png" }]);
});

test("delivered user message with core-added attachments and image hints matches the optimistic row", () => {
	const wireText = "[Attached files for this turn]\n- D:\\omp\\README.md\n\n帮我下这俩个产品\n\n[Image: original 2201x1296, displayed at 2000x1178. Multiply coordinates by 1.10 to map to original image.]";
	const delivered = { role: "user", content: [{ type: "text", text: wireText }, { type: "image", data: "aGk=", mimeType: "image/png" }] };
	let entries: ChatEntry[] = [{ kind: "user", text: "帮我下这俩个产品", images: [{ data: "aGk=", mimeType: "image/png" }], attachedPaths: ["D:\\omp\\README.md"] }];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: delivered });
	assert.equal(entries.filter((entry) => entry.kind === "user").length, 1);

	const rebuilt = rebuild([delivered]).at(0) as Extract<ChatEntry, { kind: "user" }>;
	assert.equal(rebuilt.text, "帮我下这俩个产品");
	assert.deepEqual(rebuilt.attachedPaths, ["D:\\omp\\README.md"]);
	assert.equal(rebuilt.omittedImages, undefined);

	const imageOnly = rebuild([{ role: "user", content: [{ type: "text", text: "\n\n[Image omitted: could not be resized below the inline image size limit.]" }] }]).at(0) as Extract<ChatEntry, { kind: "user" }>;
	assert.equal(imageOnly.text, "");
	assert.equal(imageOnly.omittedImages, 1);

	const typed = rebuild([{ role: "user", content: "说明\n[Image: 用户自己写的]" }]).at(0) as Extract<ChatEntry, { kind: "user" }>;
	assert.equal(typed.text, "说明\n[Image: 用户自己写的]");
});

test("auto retry events drive the banner state independent of transcript entries", () => {
	const wire = (payload: Record<string, unknown>) => ({ type: "event", sessionId: "session", event: payload }) as unknown as ServerEventMessage;
	// 无关事件不影响横幅状态（返回原引用，React 可跳过重渲染）
	const idle: RetryBannerState | null = null;
	assert.equal(applyRetryEvent(idle, wire({ type: "message_end", message: { role: "assistant" } })), idle);
	// auto_retry_start → 倒计时横幅；供应商错误走 formatProviderError 人话化
	const retrying = applyRetryEvent(null, wire({
		type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000,
		errorMessage: '429: {"code":"1308","message":"已达到 5 小时的使用上限。"}',
	}));
	assert.ok(retrying?.phase === "retrying");
	assert.equal(retrying.attempt, 2);
	assert.equal(retrying.maxAttempts, 3);
	assert.equal(retrying.delayMs, 4000);
	assert.match(retrying.reason ?? "", /额度或限流/);
	// 成功 → 横幅清除
	assert.equal(applyRetryEvent(retrying, wire({ type: "auto_retry_end", success: true, attempt: 2 })), null);
	// 用户手动停止的取消不算失败：横幅清掉
	assert.equal(applyRetryEvent(retrying, wire({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" })), null);
	// 重试预算耗尽 → failed 横幅（常驻到用户下次发言）
	const failed = applyRetryEvent(retrying, wire({ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded_error" }));
	assert.ok(failed?.phase === "failed");
	assert.equal(failed.attempt, 3);
	assert.equal(failed.reason, "overloaded_error");
	// 下一轮 auto_retry_start 重新进入 retrying
	assert.ok(applyRetryEvent(failed, wire({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded_error" }))?.phase === "retrying");
});

test("agent_end 权威重建保留用户消息行的 entryId（会话回退按钮依赖）", () => {
	// 乐观追加的用户行经 entry_appended 补上条目 id
	let entries: ChatEntry[] = [{ kind: "user", text: "你好", entryId: "e-user-1" }];
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好！" }] } });
	// agent_end 的 run 快照从本轮 user 消息起：重建曾把带 id 的用户行替换成无 id 副本
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: "你好" },
			{ role: "assistant", content: [{ type: "text", text: "你好！" }] },
		],
	});
	const userRow = entries.find((entry) => entry.kind === "user");
	assert.equal(userRow?.kind === "user" ? userRow.entryId : undefined, "e-user-1");

	// 第二轮：乐观行 + agent_start 边界 + entry_appended 补 id，agent_end 后两条用户行都保留各自 id
	entries = [...entries, { kind: "user", text: "第二条", entryId: undefined } as ChatEntry];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "entry_appended", entry: { type: "message", id: "e-user-2", message: { role: "user" } } });
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: "第二条" },
			{ role: "assistant", content: [{ type: "text", text: "回答" }] },
		],
	});
	const userRows = entries.filter((entry) => entry.kind === "user");
	assert.deepEqual(
		userRows.map((entry) => (entry.kind === "user" ? entry.entryId : undefined)),
		["e-user-1", "e-user-2"],
	);
});

test("assistant 行经 entry_appended 补 entryId（新对话中分支按钮依赖），agent_end 重建后保留", () => {
	// 新会话第一轮：乐观 user 行经 entry_appended 补 id；回答含两次 LLM 调用时，
	// 每次落盘各发一条 entry_appended，按序逐条对号
	let entries: ChatEntry[] = [{ kind: "user", text: "你好" }];
	entries = event(entries, { type: "entry_appended", entry: { type: "message", id: "e-user-1", message: { role: "user" } } });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一段" }] } });
	entries = event(entries, { type: "entry_appended", entry: { type: "message", id: "e-asst-1", message: { role: "assistant" } } });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "收尾" }] } });
	entries = event(entries, { type: "entry_appended", entry: { type: "message", id: "e-asst-2", message: { role: "assistant" } } });
	const assistantIds = () => entries.filter((entry) => entry.kind === "assistant").map((entry) => (entry.kind === "assistant" ? entry.entryId : undefined));
	assert.deepEqual(assistantIds(), ["e-asst-1", "e-asst-2"]);

	// agent_end 权威重建：assistant 行的 id 按尾部对齐取回——回答一结束分支按钮不再消失
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: "你好" },
			{ role: "assistant", content: [{ type: "text", text: "第一段" }] },
			{ role: "assistant", content: [{ type: "text", text: "收尾" }] },
		],
	});
	assert.deepEqual(assistantIds(), ["e-asst-1", "e-asst-2"]);

	// 过期/乱序的重复落盘事件（最近一条 assistant 已有 id）不动转录，React 可跳过重渲染
	const before = entries;
	entries = event(entries, { type: "entry_appended", entry: { type: "message", id: "e-asst-stale", message: { role: "assistant" } } });
	assert.equal(entries, before);
	// toolResult 不单独成行：其落盘事件与转录无关
	entries = event(before, { type: "entry_appended", entry: { type: "message", id: "e-tool-1", message: { role: "toolResult" } } });
	assert.equal(entries, before);
});

test("assistant 轮耗时取 message_end 的真实结束时刻，并穿越 agent_end 权威重建", () => {
	// wire 的 assistant timestamp 是响应「开始」时刻；不含生成耗时
	const startedAt = Date.now() - 5_000;
	let entries: ChatEntry[] = [{ kind: "user", text: "你好", timestamp: startedAt - 1_000 }];
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好！" } });
	entries = event(entries, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "你好！" }], stopReason: "stop", timestamp: startedAt },
	});
	const settled = current(entries);
	assert.ok(settled.endedAt !== undefined);
	assert.ok(settled.endedAt >= startedAt + 1_000, "结束时刻应明显晚于响应开始时刻");
	assert.ok(settled.endedAt <= Date.now() + 5);

	// agent_end 权威重建按开始时间戳找回结束时刻：轮耗时标注不因重建缩水成 1s
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: "你好", timestamp: startedAt - 1_000 },
			{ role: "assistant", content: [{ type: "text", text: "你好！" }], stopReason: "stop", timestamp: startedAt },
		],
	});
	const rebuilt = current(entries);
	assert.equal(rebuilt.timestamp, startedAt);
	assert.equal(rebuilt.endedAt, settled.endedAt);
});

test("a delivered queued message enters the transcript once, when the model receives it", () => {
	let entries: ChatEntry[] = [{ kind: "user", text: "检查项目" }];
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先看" } });
	entries = event(entries, { type: "message_start", message: { role: "user", content: "再看日志" } });
	const delivered = entries.filter((entry) => entry.kind === "user" && entry.text === "再看日志");
	assert.equal(delivered.length, 1);
	entries = event(entries, { type: "message_start", message: { role: "user", content: "再看日志" } });
	assert.equal(entries.filter((entry) => entry.kind === "user" && entry.text === "再看日志").length, 1);
});

test("a /skill: command and its expanded skill block count as the same user message", () => {
	const expanded = '<skill name="loean7-cosplay" location="D:/skills/loean7-cosplay/SKILL.md">\nReferences are relative to D:/skills/loean7-cosplay.\n\n# body\n</skill>';
	let entries: ChatEntry[] = [{ kind: "user", text: "/skill:loean7-cosplay" }];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "user", content: expanded } });
	assert.equal(entries.filter((entry) => entry.kind === "user").length, 1);

	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = [...entries, { kind: "user", text: "/skill:loean7-cosplay 再来", queued: true }];
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: expanded },
			{ role: "assistant", content: [{ type: "text", text: "好" }] },
			{ role: "user", content: `${expanded}\n\n再来` },
			{ role: "assistant", content: [{ type: "text", text: "完成" }] },
		],
	});
	assert.equal(entries.filter((entry) => entry.kind === "user").length, 2);
	assert.equal(entries.some((entry) => entry.kind === "user" && entry.queued), false);
});

test("queued follow-up does not freeze the in-progress assistant", () => {
	let entries: ChatEntry[] = [{ kind: "user", text: "检查项目" }];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先看" } });
	entries = [...entries, { kind: "user", text: "再看日志", queued: true, timestamp: 1 }];
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "目录" } });
	const streaming = entries.find((entry) => entry.kind === "assistant");
	assert.ok(streaming?.kind === "assistant");
	assert.equal(streaming.text, "先看目录");
	entries = event(entries, { type: "tool_execution_start", toolCallId: "bash-9", toolName: "bash", args: { command: "ls" } });
	entries = event(entries, {
		type: "tool_execution_end",
		toolCallId: "bash-9",
		isError: false,
		result: { content: [{ type: "text", text: "ok" }] },
	});
	const card = entries.find((entry) => entry.kind === "assistant");
	assert.ok(card?.kind === "assistant");
	assert.equal(card.tools.find((tool) => tool.id === "bash-9")?.status, "ok");
	const queued = entries.find((entry) => entry.kind === "user" && entry.queued);
	assert.ok(queued?.kind === "user");
	assert.equal(queued.text, "再看日志");
});

test("an aborted run keeps a follow-up the snapshot did not include", () => {
	let entries: ChatEntry[] = [{ kind: "user", text: "检查项目" }];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先看" } });
	entries = [...entries, { kind: "user", text: "再看日志", queued: true }];
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: "检查项目" },
			{ role: "assistant", content: [{ type: "text", text: "先看" }], stopReason: "aborted" },
		],
	});
	const queued = entries.filter((entry) => entry.kind === "user" && entry.text === "再看日志");
	assert.equal(queued.length, 1);
	assert.equal(queued[0]?.kind === "user" && queued[0].queued, true);
});

test("a delivered follow-up is not duplicated when the run snapshot includes it", () => {
	let entries: ChatEntry[] = [{ kind: "user", text: "检查项目" }];
	entries = event(entries, { type: "agent_start" });
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	entries = [...entries, { kind: "user", text: "再看日志", queued: true }];
	entries = event(entries, {
		type: "agent_end",
		messages: [
			{ role: "user", content: "检查项目" },
			{ role: "assistant", content: [{ type: "text", text: "先看" }] },
			{ role: "user", content: "再看日志" },
			{ role: "assistant", content: [{ type: "text", text: "看完了" }] },
		],
	});
	const queued = entries.filter((entry) => entry.kind === "user" && entry.text === "再看日志");
	assert.equal(queued.length, 1);
	assert.equal(queued[0]?.kind === "user" && queued[0].queued, undefined);
});

test("an aborted settlement marks the current run while retaining completed and failed tool results", () => {
	const history = rebuild([user, { role: "assistant", content: [{ type: "text", text: "旧回答" }] }]);
	let entries = event([...history, { kind: "user", text: "检查项目" }], { type: "agent_start" });
	entries = event(entries, { type: "agent_end", messages: [user, assistant, result("read-1", "done"), result("bash-1", "failed", true)] });
	const before = entries;
	entries = event(entries, { type: "agent_settled", aborted: true });
	assert.equal(current(entries).aborted, true);
	assert.deepEqual(current(entries).tools.map((tool) => tool.status), ["ok", "error"]);
	assert.equal(current(before).aborted, undefined);
	assert.deepEqual(entries.slice(0, history.length), history);
});

test("aborted settlement cancels unfinished tools and preserves an existing assistant error", () => {
	let entries = event([{ kind: "user", text: "检查项目" }], { type: "agent_start" });
	entries = event(entries, { type: "agent_end", messages: [user, assistant] });
	entries = event(entries, { type: "agent_settled", aborted: true });
	assert.ok(current(entries).tools.every((tool) => tool.status === "cancelled"));
	let failed = event([{ kind: "user", text: "检查项目" }], { type: "agent_start" });
	failed = event(failed, { type: "agent_end", messages: [user, { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" }] });
	const before = failed;
	failed = event(failed, { type: "agent_settled", aborted: true });
	assert.equal(current(failed).error, "provider failed");
	assert.equal(current(failed).aborted, undefined);
	assert.deepEqual(failed, before);
});

test("normal or old settlement events preserve history and an idle stop cannot relabel the previous run", () => {
	let entries = event([{ kind: "user", text: "检查项目" }], { type: "agent_start" });
	entries = event(entries, { type: "agent_end", messages: [user, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] });
	entries = event(entries, { type: "agent_settled", aborted: false });
	const completed = entries;
	entries = event(entries, { type: "agent_settled", aborted: true });
	assert.deepEqual(entries, completed);
	assert.equal(current(entries).aborted, undefined);
	const abortedHistory = rebuild([user, { ...assistant, stopReason: "aborted" }]);
	assert.deepEqual(event(abortedHistory, { type: "agent_settled" }), abortedHistory);
	entries = event([...entries, { kind: "user", text: "next" }], { type: "agent_start" });
	entries = event(entries, { type: "agent_end", messages: [{ role: "user", content: "next" }, { role: "assistant", content: [{ type: "text", text: "next reply" }], stopReason: "stop" }] });
	entries = event(entries, { type: "agent_settled", aborted: false });
	assert.equal(current(entries).aborted, undefined);
});

test("the next run finishes normally while the preceding stopped run retains its marker", () => {
	let entries = event([{ kind: "user", text: "检查项目" }], { type: "agent_start" });
	entries = event(entries, { type: "agent_end", messages: [user, assistant] });
	entries = event(entries, { type: "agent_settled", aborted: true });
	const previous = entries;
	entries = event([...entries, { kind: "user", text: "next" }], { type: "agent_start" });
	entries = event(entries, { type: "agent_end", messages: [{ role: "user", content: "next" }, { role: "assistant", content: [{ type: "text", text: "next reply" }], stopReason: "stop" }] });
	entries = event(entries, { type: "agent_settled", aborted: false });
	assert.equal(current(entries).aborted, undefined);
	assert.deepEqual(entries.slice(0, previous.length), previous);
	assert.equal(current(previous).aborted, true);
});

test("resuming an active snapshot without agent_start still marks its stopped tool run", () => {
	const snapshot = [
		{ role: "user", content: "旧任务" },
		{ role: "assistant", content: [{ type: "text", text: "旧回答" }], stopReason: "stop" },
		user,
		assistant,
		result("read-1", "done"),
	];
	const replayed = rebuild(snapshot);
	let entries = rebuild(snapshot, undefined, { running: true, runStartMessageIndex: 3 });
	entries = event(entries, { type: "agent_end", messages: [user, assistant, result("read-1", "done")] });
	assert.equal(entries.filter((entry) => entry.kind === "user").length, 2);
	entries = event(entries, { type: "agent_settled", aborted: true });
	assert.equal(current(entries).aborted, true);
	assert.deepEqual(current(entries).tools.map((tool) => tool.status), ["ok", "cancelled"]);
	assert.deepEqual(entries.slice(0, 2), replayed.slice(0, 2));
	assert.equal(current(replayed).aborted, undefined);
});

test("restored active pre-settlement replies can stop while the same idle history is unchanged", () => {
	const snapshot = [user, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }];
	const active = rebuild(snapshot, undefined, { running: true, runStartMessageIndex: 1 });
	const stopped = event(active, { type: "agent_settled", aborted: true });
	assert.equal(current(stopped).aborted, true);
	const idle = rebuild(snapshot, undefined, { running: false, runStartMessageIndex: 1 });
	assert.deepEqual(event(idle, { type: "agent_settled", aborted: true }), idle);
	assert.equal(current(idle).aborted, undefined);
	const completed = event(rebuild(snapshot, undefined, { running: true, runStartMessageIndex: 1 }), { type: "agent_settled", aborted: false });
	assert.deepEqual(event(completed, { type: "agent_settled", aborted: true }), completed);
});

test("a restored user-less continuation cannot mark the previous reply before its new assistant exists", () => {
	const snapshot = [
		user,
		{ role: "assistant", content: [{ type: "text", text: "previous reply" }], stopReason: "stop" },
		{ role: "custom", customType: "owl.resume", content: "continue", display: false },
	];
	const active = rebuild(snapshot, undefined, { running: true, runStartMessageIndex: 3 });
	const stoppedBeforeReply = event(active, { type: "agent_settled", aborted: true });
	assert.deepEqual(stoppedBeforeReply, rebuild(snapshot));
	assert.equal(current(stoppedBeforeReply).aborted, undefined);
	const withReply = [...snapshot, { role: "assistant", content: [{ type: "text", text: "continued reply" }], stopReason: "stop" }];
	const stoppedAfterReply = event(rebuild(withReply, undefined, { running: true, runStartMessageIndex: 3 }), { type: "agent_settled", aborted: true });
	assert.equal(current(stoppedAfterReply).aborted, true);
	assert.equal(stoppedAfterReply[1]?.kind === "assistant" && stoppedAfterReply[1].aborted, undefined);
});

test("流式增量累计估算 TPS，message_end 带用量后改用真实输出数", (t) => {
	let clock = 10_000;
	t.mock.method(Date, "now", () => clock);
	let entries: ChatEntry[] = [{ kind: "user", text: "写代码" }];
	entries = event(entries, { type: "message_start", message: { role: "assistant", content: [] } });
	clock = 12_000; // 首字延迟不计入速度
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先想想" } });
	assert.equal(outputRate(current(entries)), undefined, "不足 1 秒不出速度");
	clock = 14_000;
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好的" } });
	entries = event(entries, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"path\":\"a.ts\"}" } });
	assert.deepEqual(current(entries).stream, { firstAt: 12_000, lastAt: 14_000, estTokens: 3 + 2 + estimateTokens("{\"path\":\"a.ts\"}") });
	assert.deepEqual(outputRate(current(entries)), { tps: current(entries).stream!.estTokens / 2, estimated: true });

	clock = 16_000;
	entries = event(entries, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "好的" }], stopReason: "stop", timestamp: 11_000, usage: { input: 10, output: 200 } },
	});
	assert.deepEqual(outputRate(current(entries)), { tps: 40, estimated: false });

	entries = event(entries, {
		type: "agent_end",
		messages: [{ role: "user", content: "写代码" }, { role: "assistant", content: [{ type: "text", text: "好的" }], stopReason: "stop", timestamp: 11_000, usage: { input: 10, output: 200 } }],
	});
	assert.deepEqual(current(entries).stream, { firstAt: 12_000, lastAt: 14_000, estTokens: 3 + 2 + estimateTokens("{\"path\":\"a.ts\"}") });
	assert.deepEqual(outputRate(current(entries)), { tps: 40, estimated: false });
	assert.deepEqual(outputRate({
		kind: "assistant", text: "完成", thinking: "", tools: [],
		timestamp: 1_000, endedAt: 4_450,
		usage: { input: 34, output: 64, cacheRead: 13_588, cacheWrite: 0 },
		stream: { firstAt: 4_200, lastAt: 4_400, estTokens: 64 },
	}), { tps: 64 / 3.45, estimated: false });
});

test("没有流式统计时，用结束时刻与响应开始时刻算平均 TPS", () => {
	const entry: Extract<ChatEntry, { kind: "assistant" }> = {
		kind: "assistant", text: "完成", thinking: "", tools: [],
		timestamp: 1_000, endedAt: 5_000,
		usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
	};
	assert.deepEqual(outputRate(entry), { tps: 10, estimated: false });
	assert.equal(outputRate({ ...entry, endedAt: 1_500 }), undefined);
	const restored = rebuild([{
		role: "assistant",
		content: [{ type: "text", text: "完成" }],
		timestamp: 1_000,
		persistedAt: 5_000,
		usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
	}]);
	assert.equal(current(restored).endedAt, 5_000);
	assert.deepEqual(outputRate(current(restored)), { tps: 10, estimated: false });
});

test("estimateTokens：中日韩字符按 1 个，其余按 4 字符 1 个", () => {
	assert.equal(estimateTokens("你好"), 2);
	assert.equal(estimateTokens("abcdefgh"), 2);
	assert.equal(estimateTokens(""), 0);
});
