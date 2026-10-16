import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "owl-pool";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	discoveryStatus,
	listDiscovered,
	replacePlatformSnapshot,
	saveTraeAccountFunctions,
	syncDiscovered,
	traeAccountFunction,
	workBuddyAccountAllows,
} from "../src/catalog/discovery.ts";
import { openDb } from "../src/store/db.ts";

const dir = mkdtempSync(join(tmpdir(), "owl-sync-catalog-"));
const db = openDb(join(dir, "pool.db"));
const originalFetch = globalThis.fetch;

afterAll(() => {
	globalThis.fetch = originalFetch;
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function account(id: string, name: string, token: string): Account {
	return {
		id,
		name,
		platform: "WORKBUDDY",
		credentials: { accessToken: token },
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
	};
}

function config(ids: string[]): string {
	return JSON.stringify({
		code: 0,
		data: {
			models: ids.map((id) => ({ id, name: id, supportsToolCall: true })),
			availableModels: ids,
			agents: [{ name: "cli", tags: ["default"], models: ["glm-5.3"] }],
		},
	});
}

describe("live account catalog sync", () => {
	it("keeps a successful WorkBuddy account when another account fails, and records the callable snapshot", async () => {
		globalThis.fetch = (async (_url, init) => {
			const auth = new Headers(init?.headers).get("authorization");
			if (auth === "Bearer good") {
				return new Response(config(["step-5-preview", "glm-5.3"]), { status: 200 });
			}
			return new Response("down", { status: 503 });
		}) as typeof fetch;

		await syncDiscovered(db, [account("good", "可用号", "good"), account("bad", "失效号", "bad")], {
			workbuddy: {
				baseUrl: "https://wb.test",
				userAgent: "test",
				origin: "https://wb.test",
				referer: "https://wb.test/",
			},
		});

		const ids = listDiscovered(db)
			.filter((row) => row.platform === "WORKBUDDY" && row.available === true)
			.map((row) => row.upstreamModel);
		expect(ids).toEqual(["step-5-preview", "glm-5.3"]);
		expect(workBuddyAccountAllows(db, "good", "step-5-preview")).toBe(true);
		expect(workBuddyAccountAllows(db, "bad", "step-5-preview")).toBe(false);
		expect(discoveryStatus().workbuddy?.state).toBe("ok");
		expect(discoveryStatus().workbuddy?.added).toEqual(["step-5-preview", "glm-5.3"]);
		expect(discoveryStatus().workbuddy?.accountErrors.join(" ")).toContain("失效号");

		globalThis.fetch = (async () =>
			new Response(config(["step-5-preview", "glm-5.3", "hy4-preview"]), { status: 200 })) as typeof fetch;
		await syncDiscovered(db, [account("good", "可用号", "good")], {
			workbuddy: {
				baseUrl: "https://wb.test",
				userAgent: "test",
				origin: "https://wb.test",
				referer: "https://wb.test/",
			},
		});
		expect(discoveryStatus().workbuddy?.added).toEqual(["hy4-preview"]);
	});

	it("keeps the previous Qoder list when every account runtime is down", async () => {
		replacePlatformSnapshot(db, "QODER", [
			{ upstreamModel: "qoder-kept", name: "Kept", catalogSource: "qoder_builtin_live" },
		]);
		await syncDiscovered(
			db,
			[
				{
					id: "q1",
					name: "Qoder 号",
					platform: "QODER",
					credentials: {},
					enabled: true,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			{
				sdkCatalog: async () => {
					throw new Error("模型服务暂时不可用");
				},
			},
		);
		const ids = listDiscovered(db)
			.filter((row) => row.platform === "QODER" && row.available === true)
			.map((row) => row.upstreamModel);
		expect(ids).toEqual(["qoder-kept"]);
		expect(discoveryStatus().qoder?.state).toBe("failed");
		expect(discoveryStatus().qoder?.error).toContain("模型服务暂时不可用");
	});

	it("syncs the Qoder account that returned models and reports the one that did not", async () => {
		await syncDiscovered(
			db,
			[
				{
					id: "q-ok",
					name: "活号",
					platform: "QODER",
					credentials: {},
					enabled: true,
					createdAt: 1,
					updatedAt: 1,
				},
				{
					id: "q-down",
					name: "死号",
					platform: "QODER",
					credentials: {},
					enabled: true,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			{
				sdkCatalog: async (account) => {
					if (account.id === "q-down") {
						throw new Error("模型服务暂时不可用");
					}
					return [{ id: "qoder-live", name: "Live" }];
				},
			},
		);
		const ids = listDiscovered(db)
			.filter((row) => row.platform === "QODER" && row.available === true)
			.map((row) => row.upstreamModel);
		expect(ids).toEqual(["qoder-live"]);
		expect(discoveryStatus().qoder?.state).toBe("ok");
		expect(discoveryStatus().qoder?.accountErrors.join(" ")).toContain("死号");
		expect(discoveryStatus().qoder?.accountErrors.join(" ")).toContain("模型服务暂时不可用");
	});

	it("reads the Trae function written for that account", () => {
		saveTraeAccountFunctions(db, "trae-1", [
			{
				upstreamModel: "deepseek-v3",
				name: "DeepSeek",
				contextWindow: null,
				maxOutputTokens: null,
				upstreamMultimodal: null,
				modes: ["Work"],
				functionName: "solo_work_remote",
			},
		]);
		expect(traeAccountFunction(db, "trae-1", "deepseek-v3")).toBe("solo_work_remote");
		expect(traeAccountFunction(db, "trae-1", "missing")).toBeNull();
	});
});
