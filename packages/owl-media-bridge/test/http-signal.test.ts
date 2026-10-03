import { describe, expect, it } from "vitest";
import { registerBridgeHttpApi } from "../src/http.ts";

function setup(runtime: Record<string, unknown>) {
	let handler!: (request: any, response: any) => void | Promise<void>;
	registerBridgeHttpApi(
		{
			register: (route) => {
				handler = route.handler;
				return () => undefined;
			},
		},
		runtime as never,
	);
	const call = async (url: string, body = "{}") => {
		const response = {
			statusCode: 0,
			writeHead: () => undefined,
			end: (out = "") => {
				response.body = out;
			},
		} as unknown as { statusCode: number; body: string };
		const request = {
			method: "POST",
			url,
			headers: { host: "127.0.0.1:3080" },
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			async *[Symbol.asyncIterator]() {
				yield body;
			},
		};
		await handler(request, response);
		return response;
	};
	return { call };
}

describe("/media-bridge/api/signal", () => {
	it("serves the browser-only waveform view through the standard envelope", async () => {
		const signalView = { playerId: "qq-music", reason: "capturing", source: "process", frames: [] };
		const { call } = setup({ signalForUi: async () => signalView });
		const response = await call("/media-bridge/api/signal");
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ ok: true, value: signalView });
	});

	it("maps handler failures onto the error envelope", async () => {
		const { call } = setup({
			signalForUi: async () => {
				throw new Error("status read failed");
			},
		});
		const response = await call("/media-bridge/api/signal");
		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: "status read failed" });
	});

	it("rejects requests from other origins like every other route", async () => {
		let handler!: (request: any, response: any) => void | Promise<void>;
		registerBridgeHttpApi(
			{
				register: (route) => {
					handler = route.handler;
					return () => undefined;
				},
			},
			{} as never,
		);
		const response = { statusCode: 0, writeHead: () => undefined, end: () => undefined };
		await handler(
			{
				method: "POST",
				url: "/media-bridge/api/signal",
				headers: { host: "127.0.0.1:3080", origin: "http://evil.example" },
				async *[Symbol.asyncIterator]() {
					yield "{}";
				},
			},
			response,
		);
		expect(response.statusCode).toBe(403);
	});
});
