import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { registerModelAdminRoutes } from "../src/http/gateway-admin-api.ts";
import { Router } from "../src/http/router.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteCatalogStore } from "../src/store/gateway-stores.ts";

const dir = mkdtempSync(join(tmpdir(), "owl-model-admin-"));
const db = openDb(join(dir, "pool.db"));
const catalog = new SqliteCatalogStore(db);
const router = new Router();
registerModelAdminRoutes(router, { catalog });

afterAll(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("model route edits", () => {
	it("persists a priority of 0 when an existing model is saved", async () => {
		const created = await call("POST", "/api/models", {
			publicId: "step-5-preview",
			name: "Step-5-Preview",
			published: true,
			routes: [
				{
					platform: "TRAE",
					upstreamModel: "step-5-preview",
					priority: 0,
					enabled: true,
					reasoningEfforts: ["high"],
				},
				{
					platform: "WORKBUDDY",
					upstreamModel: "step-5-preview",
					priority: 1,
					enabled: true,
					reasoningEfforts: ["high"],
				},
			],
		});
		const modelId = String(created.id);
		const routes = created.routes as Array<{ id: string; platform: string; priority: number }>;
		const saved = await call("PUT", `/api/models/${modelId}`, {
			publicId: "step-5-preview",
			name: "Step-5-Preview",
			published: true,
			routes: routes.map((route) => ({
				...route,
				priority: 0,
				upstreamModel: "step-5-preview",
				enabled: true,
				reasoningEfforts: ["high"],
			})),
		});
		expect(
			(saved.routes as Array<{ platform: string; priority: number }>).map((route) => [
				route.platform,
				route.priority,
			]),
		).toEqual([
			["TRAE", 0],
			["WORKBUDDY", 0],
		]);
		expect(catalog.routesOf(modelId).map((route) => route.priority)).toEqual([0, 0]);
	});
});

async function call(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
	let raw = "";
	const response = {
		writableEnded: false,
		writeHead() {},
		setHeader() {},
		end(chunk?: string) {
			raw = chunk ?? "";
			this.writableEnded = true;
		},
	};
	const handled = await router.handle(
		{ method } as IncomingMessage,
		response as unknown as ServerResponse,
		new URL(`http://127.0.0.1${path}`),
		async () => body,
	);
	expect(handled).toBe(true);
	const parsed = JSON.parse(raw) as { ok: boolean; data: Record<string, unknown> };
	expect(parsed.ok).toBe(true);
	return parsed.data;
}
