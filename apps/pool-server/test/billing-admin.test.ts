import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillingService, BusinessError } from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonBody, respondErr } from "../src/http/respond.ts";
import { Router } from "../src/http/router.ts";
import { registerBillingRoutes, SqliteBillingStore } from "../src/store/billing-store.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteMemberStore } from "../src/store/member-store.ts";

let workdir: string;
let baseUrl: string;
let closeServer: () => Promise<void>;
let closeDb: () => void;

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-billing-"));
	const db = openDb(join(workdir, "pool.db"));
	closeDb = () => db.close();
	new SqliteMemberStore(db).save({
		id: "member-wdl",
		username: "wdl",
		displayName: "王多鱼",
		passwordSalt: "salt",
		passwordHash: "hash",
		enabled: true,
		maxConcurrentRequests: null,
		createdAt: 1,
		updatedAt: 1,
	});
	const store = new SqliteBillingStore(db);
	const router = new Router();
	registerBillingRoutes(router, { billing: new BillingService({ store }), store, db });
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		const readBody = <T>() => readJsonBody(request, 1024 * 1024) as Promise<T>;
		void router.handle(request, response, url, readBody).then(
			(handled) => {
				if (!handled && !response.writableEnded) respondErr(response, "common.notFound", "missing");
			},
			(error: unknown) => {
				if (response.writableEnded) return;
				if (error instanceof BusinessError) respondErr(response, error.code, error.message);
				else respondErr(response, "common.internal", "failed");
			},
		);
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
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
): Promise<{ status: number; data: Record<string, unknown> }> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = (await response.json()) as { data?: Record<string, unknown>; code?: string };
	return { status: response.status, data: payload.data ?? { code: payload.code } };
}

describe("billing admin", () => {
	it("opens a wallet, tops up in yuan, and rejects an overdraft adjustment", async () => {
		const opened = await call("/api/billing/wallets/member-wdl/ensure", "POST");
		expect(opened.status).toBe(200);
		expect(opened.data.balance).toBe("0.00");
		expect(opened.data.username).toBe("wdl");

		const topped = await call("/api/billing/wallets/member-wdl/top-up", "POST", { amount: 10.5, remark: "充值" });
		expect(topped.status).toBe(200);
		expect(topped.data.balance).toBe("10.50");

		const adjusted = await call("/api/billing/wallets/member-wdl/adjust", "POST", { amount: -0.5 });
		expect(adjusted.status).toBe(200);
		expect(adjusted.data.balance).toBe("10.00");

		const rejected = await call("/api/billing/wallets/member-wdl/adjust", "POST", { amount: -100 });
		expect(rejected.status).toBe(400);
		expect(rejected.data.code).toBe("billing.insufficientBalance");

		const wallets = await call("/api/billing/wallets");
		expect(wallets.status).toBe(200);
		const rows = wallets.data as unknown as Array<{ username: string; balance: string }>;
		expect(rows[0]?.username).toBe("wdl");
		expect(rows[0]?.balance).toBe("10.00");
	});

	it("updates and deletes a rate by id", async () => {
		const created = await call("/api/billing/rates", "POST", {
			model: "Demo-Model",
			promptPer1m: 1.25,
			completionPer1m: 2,
			cacheReadPer1m: null,
			clearCacheReadPrice: true,
			cacheWritePer1m: null,
			clearCacheWritePrice: true,
			enabled: true,
			remark: "测试",
		});
		expect(created.status).toBe(200);
		expect(created.data.model).toBe("demo-model");
		expect(created.data.promptPer1m).toBe("1.25");
		const id = String(created.data.id);

		const updated = await call(`/api/billing/rates/${id}`, "PUT", { promptPer1m: 3, enabled: false });
		expect(updated.status).toBe(200);
		expect(updated.data.promptPer1m).toBe("3.00");
		expect(updated.data.enabled).toBe(false);

		const removed = await call(`/api/billing/rates/${id}`, "DELETE");
		expect(removed.status).toBe(200);
	});
});
