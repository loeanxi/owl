import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Account, GatewayFault, type Platform, type UpstreamChatClient } from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerDiagnosticRoutes } from "../src/diagnostics.ts";
import { readJsonBody, respondErr } from "../src/http/respond.ts";
import { Router } from "../src/http/router.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { openDb } from "../src/store/db.ts";

let workdir: string;
let baseUrl: string;
let closeServer: () => Promise<void>;
let closeDb: () => void;
let accountId = "";

const fake: UpstreamChatClient = {
	platform: () => "GROK",
	async chatCompletion(_account: Account, payload: Record<string, unknown>) {
		const messages = payload.messages as Array<Record<string, unknown>>;
		const last = messages.at(-1);
		if (last?.role === "tool") {
			const receipt = String(last.content).match(/DIAG_RESULT_[a-f0-9]+/)?.[0] ?? "";
			return {
				choices: [{ message: { role: "assistant", content: receipt } }],
				usage: { prompt_tokens: 4, completion_tokens: 2 },
			};
		}
		if (payload.tool_choice === "required") {
			return {
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call-1",
									type: "function",
									function: { name: "diagnostic_add", arguments: '{"x":2,"y":3}' },
								},
							],
						},
					},
				],
				usage: { prompt_tokens: 8, completion_tokens: 3 },
			};
		}
		const marker = String(messages[0]?.content).match(/DIAG_TEXT_[a-f0-9]+/)?.[0] ?? "";
		return {
			choices: [{ message: { role: "assistant", content: marker } }],
			usage: { prompt_tokens: 5, completion_tokens: 1 },
		};
	},
	async chatCompletionStream(_account: Account, payload: Record<string, unknown>, onChunk: (frame: string) => void) {
		const messages = payload.messages as Array<Record<string, unknown>>;
		const marker = String(messages[0]?.content).match(/DIAG_STREAM_[a-f0-9]+/)?.[0] ?? "";
		onChunk(JSON.stringify({ choices: [{ delta: { content: marker } }] }));
		onChunk(
			JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 6, completion_tokens: 2 },
			}),
		);
		onChunk("[DONE]");
	},
};

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-diag-"));
	const db = openDb(join(workdir, "pool.db"));
	closeDb = () => db.close();
	const accounts = new SqliteAccountStore(db);
	accountId = accounts.create(
		{ name: "grok-test", platform: "GROK", credentials: { apiKey: "secret" }, enabled: true },
		Date.now(),
	).id;
	const upstreams = new Map<Platform, UpstreamChatClient>([["GROK", fake]]);
	const router = new Router();
	registerDiagnosticRoutes(router, { db, accounts, upstreams });
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		const readBody = <T>() => readJsonBody(request, 1024 * 1024) as Promise<T>;
		void router.handle(request, response, url, readBody).then(
			(handled) => {
				if (!handled && !response.writableEnded) respondErr(response, "common.notFound", "missing");
			},
			(error: unknown) => {
				if (response.writableEnded) return;
				if (error instanceof GatewayFault) respondErr(response, error.code, error.message);
				else respondErr(response, "common.internal", "failed");
			},
		);
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));
});

afterAll(async () => {
	await closeServer();
	closeDb();
	rmSync(workdir, { recursive: true, force: true });
});

async function call(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<{ status: number; data: Record<string, unknown>; code?: string }> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = (await response.json()) as { data?: Record<string, unknown>; code?: string };
	return { status: response.status, data: payload.data ?? {}, code: payload.code };
}

describe("model diagnostics", () => {
	it("rejects a run that does not confirm spend", async () => {
		const rejected = await call("/api/model-diagnostics/runs", "POST", {
			accountId,
			upstreamModel: "grok-4",
			cases: ["TEXT"],
			confirmSpend: false,
			timeoutSeconds: 15,
		});
		expect(rejected.status).toBe(400);
		expect(rejected.code).toBe("diagnostic_spend_confirmation");
	});

	it("runs text, stream and tool cases against the fixed account", async () => {
		const started = await call("/api/model-diagnostics/runs", "POST", {
			accountId,
			upstreamModel: "grok-4",
			cases: ["TEXT", "STREAM", "TOOLS", "TOOL_CONTINUATION"],
			confirmSpend: true,
			timeoutSeconds: 15,
		});
		expect(started.status).toBe(202);
		const id = String(started.data.id);
		let view = started.data;
		for (let attempt = 0; attempt < 20 && view.status !== "PASSED"; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			view = (await call(`/api/model-diagnostics/runs/${id}`)).data;
		}
		expect(view.status).toBe("PASSED");
		const cases = view.cases as Array<{ caseType: string; status: string }>;
		expect(cases.find((row) => row.caseType === "TEXT")?.status).toBe("PASSED");
		expect(cases.find((row) => row.caseType === "STREAM")?.status).toBe("PASSED");
		expect(cases.find((row) => row.caseType === "TOOLS")?.status).toBe("PASSED");
		expect(cases.find((row) => row.caseType === "TOOL_CONTINUATION")?.status).toBe("PASSED");
		expect(cases.find((row) => row.caseType === "IMAGE")?.status).toBe("NOT_TESTED");

		const latest = await call(`/api/model-diagnostics/latest?accountId=${accountId}&upstreamModel=grok-4`);
		expect(latest.status).toBe(200);
	});
});
