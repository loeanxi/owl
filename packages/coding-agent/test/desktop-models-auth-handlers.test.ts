import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
	type AuthHandlerContext,
	createAuthLoginState,
	handleAuthRequest,
} from "../src/modes/desktop/handlers/auth.ts";
import { handleModelsRequest, type ModelsHandlerContext } from "../src/modes/desktop/handlers/models.ts";
import type { DesktopServerMessage } from "../src/modes/desktop/protocol.ts";

type Reply = { id: string; ok: boolean; result?: unknown; error?: string };

const ws = {} as WebSocket;

function collector() {
	const replies: Reply[] = [];
	return {
		replies,
		reply: (_ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => {
			replies.push({ id, ...result });
		},
	};
}

const noServices = () => Promise.reject(new Error("services unavailable"));

describe("desktop models handler", () => {
	let agentDir: string;
	let previousOffline: string | undefined;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "owl-models-handler-"));
		previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
	});

	afterEach(async () => {
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		await rm(agentDir, { recursive: true, force: true });
	});

	function context(): ModelsHandlerContext & { replies: Reply[] } {
		const { replies, reply } = collector();
		return { replies, reply, defaultAgentDir: () => agentDir, getListingServices: noServices };
	}

	it("declares a provider and models in models.json without model services", async () => {
		const ctx = context();
		await handleModelsRequest(
			ws,
			{
				type: "models.putProvider",
				id: "1",
				provider: { key: "local", baseUrl: "http://127.0.0.1:1234/v1", api: "openai-completions" },
			},
			ctx,
		);
		await handleModelsRequest(
			ws,
			{ type: "models.putModel", id: "2", providerKey: "local", model: { id: " qwen ", input: ["text", "image"] } },
			ctx,
		);

		expect(ctx.replies.map((entry) => entry.ok)).toEqual([true, true]);
		expect(ctx.replies[1].result).toEqual([
			{ id: "local", authSource: "models_json", models: [{ id: "qwen", name: "qwen", input: ["text", "image"] }] },
		]);
		const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
		expect(saved.providers.local).toMatchObject({ baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "qwen" }] });
	});

	it("rejects invalid provider declarations and unknown models", async () => {
		const ctx = context();
		await handleModelsRequest(
			ws,
			{
				type: "models.putProvider",
				id: "1",
				provider: { key: "bad key", baseUrl: "http://x", api: "openai-completions" },
			},
			ctx,
		);
		await handleModelsRequest(
			ws,
			{
				type: "models.putProvider",
				id: "2",
				provider: { key: "ok", baseUrl: "ftp://x", api: "openai-completions" },
			},
			ctx,
		);
		await handleModelsRequest(
			ws,
			{
				type: "models.putProvider",
				id: "3",
				provider: { key: "ok", baseUrl: "http://x", api: "openai-completions" },
			},
			ctx,
		);
		await handleModelsRequest(ws, { type: "models.removeModel", id: "4", providerKey: "ok", modelId: "ghost" }, ctx);

		expect(ctx.replies.filter((entry) => !entry.ok)).toEqual([
			{ id: "1", ok: false, error: "供应商 ID 只能包含字母、数字、点、下划线、连字符" },
			{ id: "2", ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" },
			{ id: "4", ok: false, error: "未知模型：ghost" },
		]);
	});

	it("removes a declared provider", async () => {
		const ctx = context();
		await handleModelsRequest(
			ws,
			{
				type: "models.putProvider",
				id: "1",
				provider: { key: "local", baseUrl: "http://127.0.0.1:1234/v1", api: "openai-completions" },
			},
			ctx,
		);
		await handleModelsRequest(ws, { type: "models.removeProvider", id: "2", providerKey: "local" }, ctx);

		expect(ctx.replies[1]).toEqual({ id: "2", ok: true, result: [] });
		const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
		expect(saved.providers).toEqual({});
	});
});

describe("desktop auth handler", () => {
	function context(): AuthHandlerContext & { replies: Reply[]; broadcasts: DesktopServerMessage[] } {
		const { replies, reply } = collector();
		const broadcasts: DesktopServerMessage[] = [];
		return {
			replies,
			broadcasts,
			reply,
			broadcast: (message) => broadcasts.push(message),
			defaultAgentDir: () => tmpdir(),
			getListingServices: noServices,
			login: createAuthLoginState(),
		};
	}

	it("answers the pending login prompt", async () => {
		const ctx = context();
		let answered: string | undefined;
		ctx.login.pendingPrompt = {
			ask: { type: "text", message: "code" },
			resolve: (value) => {
				answered = value;
			},
			reject: () => {},
		};

		await handleAuthRequest(ws, { type: "auth.prompt.respond", id: "1", answer: "42" }, ctx);

		expect(answered).toBe("42");
		expect(ctx.replies).toEqual([{ id: "1", ok: true }]);
	});

	it("reports when no login prompt is waiting", async () => {
		const ctx = context();
		await handleAuthRequest(ws, { type: "auth.prompt.respond", id: "1", answer: "42" }, ctx);
		expect(ctx.replies).toEqual([{ id: "1", ok: false, error: "当前没有等待回答的登录提问" }]);
	});

	it("cancel aborts the active login and rejects its pending prompt", async () => {
		const ctx = context();
		const controller = new AbortController();
		let rejected: Error | undefined;
		ctx.login.activeLogin = { controller };
		ctx.login.pendingPrompt = {
			ask: { type: "text", message: "code" },
			resolve: () => {},
			reject: (error) => {
				rejected = error;
			},
		};

		await handleAuthRequest(ws, { type: "auth.cancel", id: "1" }, ctx);

		expect(controller.signal.aborted).toBe(true);
		expect(rejected?.message).toBe("登录已取消");
		expect(ctx.login.pendingPrompt).toBeNull();
		expect(ctx.replies).toEqual([{ id: "1", ok: true }]);
	});
});
