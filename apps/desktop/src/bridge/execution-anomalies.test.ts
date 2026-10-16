import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./client.ts";

class LogSocket {
	static latest: LogSocket;
	OPEN = 1;
	CONNECTING = 0;
	readyState = 1;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: string }) => void;
	sent: Array<Record<string, unknown>> = [];
	constructor() { LogSocket.latest = this; }
	send(value: string): void { this.sent.push(JSON.parse(value) as Record<string, unknown>); }
	close(): void { this.onclose?.(); }
}

let client: BridgeClient;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", LogSocket);
	client = new BridgeClient("ws://anomalies.test/ws");
	client.connect();
});
afterEach(() => {
	client.disconnect();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("execution anomaly bridge client", () => {
	it("sends filters and returns persisted evidence from the bridge", async () => {
		const response = client.listExecutionAnomalies({ query: "bash", status: "pending", limit: 40, offset: 40 });
		const request = LogSocket.latest.sent.at(-1)!;
		expect(request).toMatchObject({ type: "execution.anomalies.list", query: "bash", status: "pending", limit: 40, offset: 40 });
		LogSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: request.id, ok: true, result: { records: [], total: 0 } }) });
		await expect(response).resolves.toEqual({ type: "response", id: request.id, ok: true, result: { records: [], total: 0 } });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("refreshes subscribers for log changes and releases the listener on unmount", () => {
		const changed = vi.fn();
		const release = client.onExecutionAnomaliesChanged(changed);
		LogSocket.latest.onmessage?.({ data: JSON.stringify({ type: "execution.anomalies.changed" }) });
		expect(changed).toHaveBeenCalledOnce();
		release();
		LogSocket.latest.onmessage?.({ data: JSON.stringify({ type: "execution.anomalies.changed" }) });
		expect(changed).toHaveBeenCalledOnce();
	});

	it("keeps the anomaly ID separate from RPC identity for soft processing and restoring", async () => {
		const input = { id: "stored-anomaly", kind: "optimized" as const, note: "Correct path handling", verification: "Focused replay passed" };
		const processed = client.processExecutionAnomaly(input);
		const processRequest = LogSocket.latest.sent.at(-1)!;
		expect(processRequest).toMatchObject({ type: "execution.anomalies.process", anomalyId: input.id, kind: input.kind, note: input.note, verification: input.verification });
		expect(processRequest.id).not.toBe(input.id);
		LogSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: processRequest.id, ok: true, result: { id: input.id } }) });
		await expect(processed).resolves.toMatchObject({ ok: true, result: { id: input.id } });
		const restored = client.restoreExecutionAnomaly(input.id);
		const restoreRequest = LogSocket.latest.sent.at(-1)!;
		expect(restoreRequest).toMatchObject({ type: "execution.anomalies.restore", anomalyId: input.id });
		expect(restoreRequest.id).not.toBe(input.id);
		LogSocket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: restoreRequest.id, ok: true, result: { id: input.id } }) });
		await expect(restored).resolves.toMatchObject({ ok: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("unblocks the settings page when a connected bridge stops replying", async () => {
		const response = client.listExecutionAnomalies();
		const rejected = expect(response).rejects.toThrow("请求超时");
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});
});
