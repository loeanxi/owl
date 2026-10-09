import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { createFrameBatcher, isStreamingDeltaEvent } from "./event-batch.ts";

test("同一帧内的多条 delta 只 flush 一次（无 rAF 时走 setTimeout 兜底）", async () => {
	const batches: number[][] = [];
	const batcher = createFrameBatcher<number>((items) => batches.push(items), 5);
	batcher.push(1);
	batcher.push(2);
	assert.deepEqual(batches, []);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(batches, [[1, 2]]);
});

test("clear 丢弃待处理项；只把 text/thinking delta 当作可合并事件", () => {
	const batches: number[][] = [];
	const batcher = createFrameBatcher<number>((items) => batches.push(items));
	batcher.push(1);
	batcher.clear();
	batcher.flush();
	assert.deepEqual(batches, []);
	const delta = {
		type: "event",
		sessionId: "s",
		event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } },
	} as ServerEventMessage;
	assert.equal(isStreamingDeltaEvent(delta), true);
	assert.equal(isStreamingDeltaEvent({ ...delta, event: { type: "agent_start" } } as ServerEventMessage), false);
});
