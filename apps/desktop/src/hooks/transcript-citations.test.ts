import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { applyEvent, type ChatEntry } from "./transcript.ts";

function event(entries: ChatEntry[], payload: Record<string, unknown>): ChatEntry[] {
	return applyEvent(entries, { type: "event", sessionId: "session", event: payload } as unknown as ServerEventMessage);
}

function current(entries: ChatEntry[]): Extract<ChatEntry, { kind: "assistant" }> {
	const found = entries.findLast((entry) => entry.kind === "assistant");
	assert.ok(found?.kind === "assistant");
	return found;
}

const citation = { title: "Example Domain", url: "https://example.com/page", source: "url_citation" };

test("a citation event lands on the text segment it belongs to", () => {
	let entries = event([{ kind: "user", text: "查资料" }], {
		type: "message_start",
		message: { role: "assistant", content: [] },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "结论在这里。" },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_citation", contentIndex: 0, citation },
	});

	const segments = current(entries).segments;
	assert.equal(segments.length, 1);
	assert.deepEqual(segments[0], { kind: "text", text: "结论在这里。", citations: [citation] });
});

test("several citations collect on the same segment", () => {
	let entries = event([{ kind: "user", text: "查资料" }], {
		type: "message_start",
		message: { role: "assistant", content: [] },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "两处都有依据。" },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_citation", contentIndex: 0, citation },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_citation",
			contentIndex: 0,
			citation: { title: "Second", url: "https://example.org/" },
		},
	});

	const segment = current(entries).segments[0]!;
	assert.equal(segment.kind, "text");
	assert.equal(segment.citations?.length, 2);
});

test("the authoritative message_end keeps the citations", () => {
	let entries = event([{ kind: "user", text: "查资料" }], {
		type: "message_start",
		message: { role: "assistant", content: [] },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "结论在这里。" },
	});
	entries = event(entries, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "结论在这里。", citations: [citation] }],
			stopReason: "stop",
		},
	});

	assert.deepEqual(current(entries).segments[0], { kind: "text", text: "结论在这里。", citations: [citation] });
});

test("a citation without a title or a url is dropped", () => {
	let entries = event([{ kind: "user", text: "查资料" }], {
		type: "message_start",
		message: { role: "assistant", content: [] },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "没有来源。" },
	});
	entries = event(entries, {
		type: "message_update",
		assistantMessageEvent: { type: "text_citation", contentIndex: 0, citation: { source: "char_location" } },
	});

	const segment = current(entries).segments[0]!;
	assert.equal(segment.kind, "text");
	assert.equal(segment.citations, undefined);
});
