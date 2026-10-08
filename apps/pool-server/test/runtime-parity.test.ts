import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiKey } from "owl-pool";
import { describe, expect, it } from "vitest";
import { parseOauthCode } from "../src/account/claude-oauth.ts";
import {
	claudeUsageBuckets,
	copilotQuota,
	cursorQuota,
	extractEntitlementUsage,
	extractResourceSummary,
	qoderQuota,
} from "../src/account/credits.ts";
import {
	CodexSession,
	type CodexTransport,
	codexCommand,
	dynamicTools,
	initialPrompt,
} from "../src/gateway/codex-client.ts";
import { ContinuationRegistry } from "../src/gateway/continuation.ts";
import { MemberConcurrencyService } from "../src/security/member-concurrency.ts";
import { BACKUP_TABLES } from "../src/store/backup.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteMemberStore } from "../src/store/member-store.ts";

const key = { id: "key-1" } as ApiKey;

describe("credit extractors", () => {
	it("sums Trae entitlement packs and treats a negative limit as unlimited", () => {
		const limited = extractEntitlementUsage({
			code: 0,
			user_entitlement_pack_list: [
				{
					entitlement_base_info: { product_type: 1, quota: { credits_limit: 100 } },
					usage: { credits_amount: 40 },
				},
				{ product_type: 3, credits_limit: 999, credits_amount: 0 },
			],
		});
		expect(limited.ok).toBe(true);
		expect(limited.credits).toBe(60);
		const unlimited = extractEntitlementUsage({
			user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: -1 } } }],
		});
		expect(unlimited.ok).toBe(true);
		expect(unlimited.credits).toBeNull();
		expect(unlimited.message).toBe("积分池不限量");
	});

	it("sums WorkBuddy package remainders and reads official quota shapes", () => {
		const summary = extractResourceSummary({
			code: 0,
			data: { Packages: [{ CycleRemainCapacity: 1.5 }, { CycleRemainCapacity: 2 }] },
		});
		expect(summary.credits).toBe(3.5);
		expect(summary.label).toBe("CycleRemainCapacity×2");
		expect(cursorQuota({ source: "CURSOR_DASHBOARD_ONLY" })).toMatchObject({
			availability: "UNAVAILABLE",
			label: "CURSOR_SESSION_REQUIRED",
			buckets: [],
		});
		expect(
			copilotQuota({ quotaSnapshots: { chat: { entitlementRequests: 10, usedRequests: 4 } } }).buckets[0]?.remaining,
		).toBe(6);
		expect(qoderQuota({ userQuota: { remaining: 3, total: 10, used: 7 } }).ok).toBe(true);
		expect(claudeUsageBuckets({ five_hour: { utilization: 0.25, resets_at: 1_700_000_000 } })[0]?.used).toBe(25);
	});
});

describe("continuation and concurrency", () => {
	it("pins a tool call to the same account and releases it after the result", () => {
		const registry = new ContinuationRegistry({ ttlSeconds: 60, maxPendingTurns: 2 });
		registry.bind(key, "demo", "account-a", ["call-1"]);
		const pin = registry.find(key, "demo", {
			messages: [
				{ role: "assistant", tool_calls: [{ id: "call-1" }] },
				{ role: "tool", tool_call_id: "call-1", content: "5" },
			],
		});
		expect(pin?.accountId).toBe("account-a");
		expect(
			registry.find(key, "demo", {
				messages: [
					{ role: "assistant", tool_calls: [{ id: "call-1" }] },
					{ role: "tool", tool_call_id: "call-1", content: "5" },
				],
			}),
		).toBeNull();
		registry.consume(key, {
			messages: [
				{ role: "assistant", tool_calls: [{ id: "call-1" }] },
				{ role: "tool", tool_call_id: "call-1", content: "5" },
			],
		});
	});

	it("rejects a third overlapping member request when the limit is 1 and nobody may wait", async () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-conc-"));
		const db = openDb(join(dir, "pool.db"));
		try {
			const members = new SqliteMemberStore(db);
			members.save({
				id: "m1",
				username: "wdl",
				displayName: "王多鱼",
				passwordSalt: "s",
				passwordHash: "h",
				enabled: true,
				maxConcurrentRequests: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			const service = new MemberConcurrencyService(members, { defaultLimit: 2, maxWaiting: 0, waitMillis: 0 });
			const first = await service.acquire("m1");
			await expect(service.acquire("m1")).rejects.toMatchObject({ code: "member_concurrency_limit" });
			first.close();
			const second = await service.acquire("m1");
			second.close();
			expect(service.view("m1").active).toBe(0);
			expect(service.update("m1", 4).effective).toBe(4);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("codex protocol", () => {
	it("builds the HTTP-only app-server command and a conversation prompt", () => {
		const command = codexCommand("D:\\data\\codex-accounts\\loean", "codex.exe");
		expect(command.slice(0, 3)).toEqual(["codex.exe", "app-server", "--stdio"]);
		expect(command).toContain("shell_tool");
		expect(command.join(" ")).toContain("supports_websockets=false");
		expect(
			dynamicTools({ tools: [{ type: "function", function: { name: "add", parameters: { type: "object" } } }] }),
		).toEqual([
			{ type: "function", name: "add", description: "Client function add", inputSchema: { type: "object" } },
		]);
		expect(
			initialPrompt({
				messages: [
					{ role: "system", content: "hidden" },
					{ role: "user", content: "hi" },
				],
			}),
		).toContain("hi");
		expect(initialPrompt({ messages: [{ role: "user", content: "hi" }] })).not.toContain("hidden");
	});

	it("turns app-server deltas into one chat completion", async () => {
		const transport = scriptedTransport([
			{ id: 1, result: { initialized: true } },
			{ method: "item/agentMessage/delta", params: { delta: "pong" } },
			{ method: "turn/completed", params: { turn: { status: "completed" } } },
		]);
		const session = new CodexSession(transport, 2000);
		await session.request("initialize", {});
		session.notify("initialized", {});
		const first = await session.next(500);
		const second = await session.next(500);
		expect(first && "method" in first ? first.method : "").toBe("item/agentMessage/delta");
		expect(second && "method" in second ? second.method : "").toBe("turn/completed");
		session.close();
	});
});

describe("oauth and backup coverage", () => {
	it("reads a Claude callback code from the fragment", () => {
		expect(parseOauthCode("https://platform.claude.com/oauth/code/callback#code=abc&state=xyz")).toEqual({
			code: "abc",
			state: "xyz",
		});
	});

	it("backs up members, budgets, drafts, snapshots and diagnostics", () => {
		expect(BACKUP_TABLES).toEqual(
			expect.arrayContaining([
				"members",
				"key_budgets",
				"billing_rate_drafts",
				"trae_account_model_snapshots",
				"workbuddy_account_model_snapshots",
				"model_diagnostic_runs",
				"model_diagnostic_results",
			]),
		);
	});
});

function scriptedTransport(messages: Array<Record<string, unknown>>): CodexTransport {
	const lines: Array<(line: string) => void> = [];
	return {
		write() {},
		onLine(listener) {
			lines.push(listener);
			queueMicrotask(() => {
				for (const message of messages.splice(0)) {
					listener(JSON.stringify(message));
				}
			});
		},
		onExit() {},
		kill() {},
	};
}
