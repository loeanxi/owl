import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./client.ts";
import type { DesktopClientRequestWithoutId } from "./protocol.ts";

class SilentSocket {
	static latest: SilentSocket;
	OPEN = 1;
	CONNECTING = 0;
	readyState = 1;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: string }) => void;
	sent: Array<{ id: string; type: string }> = [];
	constructor() { SilentSocket.latest = this; }
	send(value: string): void { this.sent.push(JSON.parse(value) as { id: string; type: string }); }
	close(): void { this.onclose?.(); }
}

let client: BridgeClient;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", SilentSocket);
	client = new BridgeClient("ws://control.test/ws");
	client.connect();
});
afterEach(() => {
	client.disconnect();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const controls: DesktopClientRequestWithoutId[] = [
	{ type: "session.setModel", sessionId: "chat", provider: "test", model: "next" },
	{ type: "session.setThinkingLevel", sessionId: "chat", level: "high" },
	{ type: "permission.response", requestId: "approval", approved: true },
	{ type: "question.response", requestId: "question", answers: [{ index: 0, customText: "retained answer" }] },
];
const materialControls: DesktopClientRequestWithoutId[] = [
	{ type: "fs.stat", cwd: "D:/project", path: "requirements.md" },
	{ type: "session.queue.get", sessionId: "chat", messageId: "input-a" },
	{ type: "session.queue.take", sessionId: "chat", messageId: "input-a", operationId: "stable-take-id" },
	{ type: "session.queue.remove", sessionId: "chat", messageId: "input-a", lane: "followUp" },
	{ type: "session.queue.promote", sessionId: "chat", messageId: "input-a" },
	{ type: "session.queue.returned.list" },
	{ type: "session.queue.returned.get", receiptId: "stable-take-id" },
	{ type: "session.queue.returned.remove", receiptId: "stable-take-id" },
];

describe("acknowledged controls with a silent bridge", () => {
	it.each(materialControls)("releases material control $type after 30 seconds and preserves retry identity", async (request) => {
		const pending = client.request(request);
		const rejected = expect(pending).rejects.toThrow("请求超时");
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
		const retry = client.request(request);
		const sent = SilentSocket.latest.sent.at(-1)!;
		expect(sent).toMatchObject(request);
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: sent.id, ok: true }) });
		await expect(retry).resolves.toMatchObject({ ok: true });
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each(controls)("releases $type so its owner can retain input and retry", async (request) => {
		const pending = client.request(request);
		const rejected = expect(pending).rejects.toThrow("请求超时");
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
		const retry = client.request(request);
		const sent = SilentSocket.latest.sent.at(-1)!;
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: sent.id, ok: true }) });
		await expect(retry).resolves.toMatchObject({ ok: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not let a delayed old acknowledgement settle a new attempt", async () => {
		const pending = client.respondPermission("approval", true);
		const original = SilentSocket.latest.sent.at(-1)!;
		const rejected = expect(pending).rejects.toThrow("请求超时");
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
		const retry = client.respondPermission("approval", true);
		const retried = SilentSocket.latest.sent.at(-1)!;
		let settled = false;
		void retry.then(() => { settled = true; });
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: original.id, ok: true }) });
		await Promise.resolve();
		expect(settled).toBe(false);
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: retried.id, ok: false, error: "request already ended" }) });
		await expect(retry).resolves.toMatchObject({ ok: false, error: "request already ended" });
	});

	it("retains business rejection results and clears all acknowledgement timers on disconnect", async () => {
		const rejected = client.respondQuestion("question", [], true);
		const sent = SilentSocket.latest.sent.at(-1)!;
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: sent.id, ok: false, error: "answer not accepted" }) });
		await expect(rejected).resolves.toMatchObject({ ok: false, error: "answer not accepted" });
		const pending = client.request(controls[0]);
		const disconnected = expect(pending).rejects.toThrow("bridge disconnected");
		client.disconnect();
		await disconnected;
		expect(vi.getTimerCount()).toBe(0);
	});
});
