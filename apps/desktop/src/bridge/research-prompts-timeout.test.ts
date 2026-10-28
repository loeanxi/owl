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
	constructor() {
		SilentSocket.latest = this;
	}
	send(value: string): void {
		this.sent.push(JSON.parse(value) as { id: string; type: string });
	}
	close(): void {
		this.onclose?.();
	}
}

let client: BridgeClient;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", SilentSocket);
	client = new BridgeClient("ws://example.test/ws");
	client.connect();
});
afterEach(() => {
	client.disconnect();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const requests: DesktopClientRequestWithoutId[] = [
	{ type: "research.prompts.get" },
	{ type: "research.prompts.save", settings: { version: 1, enabled: false, activePresetId: null, presets: [] } },
	{ type: "research.prompts.apply", presetId: "evidence-first" },
	{ type: "research.prompts.restore" },
	{ type: "research.prompts.export", settings: { version: 1, enabled: false, activePresetId: null, presets: [] } },
];

describe("research prompt settings bridge timeout", () => {
	it.each(requests)("allows retry after a silent bridge leaves $type unanswered", async (request) => {
		const pending = client.request(request);
		const rejected = expect(pending).rejects.toThrow("提示词设置请求超时");
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
		const retried = client.request(request);
		const retry = SilentSocket.latest.sent.at(-1);
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: retry?.id, ok: true }) });
		await expect(retried).resolves.toMatchObject({ ok: true });
	});

	it("clears the timeout when the bridge responds", async () => {
		const pending = client.request({ type: "research.prompts.get" });
		const request = SilentSocket.latest.sent.at(-1);
		SilentSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: request?.id, ok: true }) });
		await expect(pending).resolves.toMatchObject({ ok: true });
		expect(vi.getTimerCount()).toBe(0);
	});
});
