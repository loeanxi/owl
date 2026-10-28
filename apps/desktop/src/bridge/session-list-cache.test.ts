import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./client.ts";

type SendRequest = (request: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

function clientWithStubbedTransport(reply: { ok: boolean; result?: unknown; error?: string }): {
	client: BridgeClient;
	send: ReturnType<typeof vi.fn>;
} {
	const client = new BridgeClient("ws://127.0.0.1:1/ws");
	const send = vi.fn(async () => reply);
	(client as unknown as { sendRequest: SendRequest }).sendRequest = send as unknown as SendRequest;
	return { client, send };
}

describe("session.list coalescing", () => {
	it("sends one request for concurrent identical list calls and reuses it right after", async () => {
		const { client, send } = clientWithStubbedTransport({ ok: true, result: [{ id: "a" }] });
		const [first, second] = await Promise.all([
			client.request<Array<{ id: string }>>({ type: "session.list" }),
			client.request<Array<{ id: string }>>({ type: "session.list" }),
		]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(first.result).toEqual([{ id: "a" }]);
		expect(second.result).toEqual([{ id: "a" }]);
		// 紧接着再来一次：复用上一次结果，不再发请求。
		const third = await client.request<Array<{ id: string }>>({ type: "session.list" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(third.result).toEqual([{ id: "a" }]);
	});

	it("keeps different scopes apart", async () => {
		const { client, send } = clientWithStubbedTransport({ ok: true, result: [] });
		await Promise.all([
			client.request({ type: "session.list" }),
			client.request({ type: "session.list", scope: "chat" }),
			client.request({ type: "session.list", scope: "research" }),
		]);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("drops the cached list after a session mutation", async () => {
		const { client, send } = clientWithStubbedTransport({ ok: true, result: [] });
		await client.request({ type: "session.list" });
		expect(send).toHaveBeenCalledTimes(1);
		await client.request({ type: "session.rename", sessionId: "a", name: "x" });
		await client.request({ type: "session.list" });
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("does not let an in-flight list repopulate the cache after a mutation", async () => {
		const client = new BridgeClient("ws://127.0.0.1:1/ws");
		const pending = Promise.withResolvers<{ ok: boolean; result?: unknown }>();
		const send = vi.fn(async (request: unknown) =>
			(request as { type?: string }).type === "session.list" ? pending.promise : { ok: true },
		);
		(client as unknown as { sendRequest: SendRequest }).sendRequest = send as unknown as SendRequest;
		const inflight = client.request({ type: "session.list" });
		await client.request({ type: "session.rename", sessionId: "a", name: "x" });
		pending.resolve({ ok: true, result: [{ id: "stale" }] });
		await inflight;
		await client.request({ type: "session.list" });
		// 旧应答没有回填缓存：这一次是真的重新发了请求。
		expect(send.mock.calls.filter((call) => (call[0] as { type?: string }).type === "session.list")).toHaveLength(2);
	});
});
