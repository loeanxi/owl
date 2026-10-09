import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { DesktopEventFanout } from "../src/modes/desktop/event-fanout.ts";
import type { ServerEventMessage } from "../src/modes/desktop/protocol.ts";

afterEach(() => {
	vi.useRealTimers();
});

function fakeSocket(): WebSocket & { sent: string[] } {
	const sent: string[] = [];
	return { readyState: 1, OPEN: 1, sent } as unknown as WebSocket & { sent: string[] };
}

function delta(
	sessionId: string,
	text: string,
	kind: "text_delta" | "thinking_delta" = "text_delta",
): ServerEventMessage {
	return {
		type: "event",
		sessionId,
		event: { type: "message_update", assistantMessageEvent: { type: kind, contentIndex: 0, delta: text } },
	};
}

it("coalesces consecutive text deltas and flushes before lifecycle events", async () => {
	vi.useFakeTimers();
	const socket = fakeSocket();
	const fanout = new DesktopEventFanout({
		clients: () => [socket],
		send: (client, payload) => (client as unknown as { sent: string[] }).sent.push(payload),
		coalesceMs: 20,
	});
	fanout.publishEvent(delta("s1", "Hel"));
	fanout.publishEvent(delta("s1", "lo"));
	expect(socket.sent).toHaveLength(0);
	fanout.publishEvent({ type: "event", sessionId: "s1", event: { type: "agent_settled" } });
	expect(socket.sent).toHaveLength(2);
	const merged = JSON.parse(socket.sent[0]!) as ServerEventMessage;
	expect((merged.event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta).toBe("Hello");
	expect((JSON.parse(socket.sent[1]!) as ServerEventMessage).event).toMatchObject({ type: "agent_settled" });
});

it("subscribed connections receive deltas only for watched sessions but still get lifecycle events", () => {
	const watched = fakeSocket();
	const other = fakeSocket();
	const fanout = new DesktopEventFanout({
		clients: () => [watched, other],
		send: (client, payload) => (client as unknown as { sent: string[] }).sent.push(payload),
		coalesceMs: 0,
	});
	fanout.subscribe(watched, ["main"]);
	fanout.subscribe(other, ["side"]);
	fanout.publishEvent(delta("main", "x"));
	fanout.publishEvent({ type: "event", sessionId: "main", event: { type: "agent_start" } });
	expect(watched.sent).toHaveLength(2);
	expect(other.sent).toHaveLength(1);
	expect((JSON.parse(other.sent[0]!) as ServerEventMessage).event).toMatchObject({ type: "agent_start" });
});
