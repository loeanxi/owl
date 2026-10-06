import { describe, expect, it } from "vitest";
import { InMemoryAccountStore } from "../src/account/store.ts";
import type { Account } from "../src/account/types.ts";
import type { CheckInProvider } from "../src/checkin/provider.ts";
import { InMemoryCheckInRecordStore } from "../src/checkin/record-store.ts";
import { CheckInService, signedToday } from "../src/checkin/service.ts";
import { type CheckInResult, checkInAlready, checkInAuthError, checkInSuccess } from "../src/checkin/types.ts";
import { businessDayString, todayRange } from "../src/common/business-time.ts";
import { BusinessError } from "../src/common/error.ts";

/** 固定「现在」：2026-10-07T22:00:00Z = 上海时间 2026-10-08 06:00，业务日 2026-10-08。 */
const NOW = Date.parse("2026-10-07T22:00:00.000Z");

function makeAccount(store: InMemoryAccountStore, platform: Account["platform"], enabled = true): Account {
	return store.create({ name: `${platform} 号`, platform, credentials: {}, enabled }, NOW);
}

function stubProvider(
	platform: Account["platform"],
	script: (account: Account) => CheckInResult,
	configured = true,
): CheckInProvider {
	return {
		supports: () => platform,
		isConfigured: configured ? undefined : () => false,
		checkIn: async (account) => script(account),
	};
}

function buildService(accounts: InMemoryAccountStore, providers: CheckInProvider[]) {
	const records = new InMemoryCheckInRecordStore();
	const service = new CheckInService({
		accounts,
		records,
		providers,
		nowMs: () => NOW,
		newId: (() => {
			let n = 0;
			return () => `rec-${++n}`;
		})(),
	});
	return { records, service };
}

describe("CheckInService", () => {
	it("按平台路由：支持的 Provider 正常签到并落记录、更新账号状态", async () => {
		const accounts = new InMemoryAccountStore();
		const account = makeAccount(accounts, "WORKBUDDY");
		makeAccount(accounts, "TRAE");
		const { records, service } = buildService(accounts, [
			stubProvider("WORKBUDDY", () => checkInSuccess("签到成功", 20, NOW)),
			stubProvider("TRAE", () => checkInAlready("今日已签到", null, NOW)),
		]);

		const outcome = await service.checkInOne(account.id);
		expect(outcome.result.status).toBe("SUCCESS");
		expect(outcome.platform).toBe("WORKBUDDY");

		const after = accounts.require(account.id);
		expect(after.lastCheckInStatus).toBe("SUCCESS");
		expect(after.lastCheckInAt).toBe(NOW);

		const batch = await service.checkInAll();
		expect(batch).toMatchObject({ total: 2, success: 1, already: 1, failed: 0 });
		expect(records.recent(10)).toHaveLength(3);
	});

	it("不支持的平台（CODEX 无签到概念）→ checkin.notSupported", async () => {
		const accounts = new InMemoryAccountStore();
		const account = makeAccount(accounts, "CODEX");
		const { service } = buildService(accounts, []);

		await expect(service.checkInOne(account.id)).rejects.toMatchObject({
			code: "checkin.notSupported",
		});
		await expect(service.checkInAll()).rejects.toMatchObject({ code: "checkin.noAccounts" });
	});

	it("Provider 声明凭证未配置 → checkin.notConfigured；且不参与全量签到", async () => {
		const accounts = new InMemoryAccountStore();
		const account = makeAccount(accounts, "WORKBUDDY");
		const { service } = buildService(accounts, [
			stubProvider("WORKBUDDY", () => checkInSuccess("ok", null, NOW), false),
		]);

		await expect(service.checkInOne(account.id)).rejects.toMatchObject({
			code: "checkin.notConfigured",
		});
		await expect(service.checkInAll()).rejects.toMatchObject({ code: "checkin.noAccounts" });
	});

	it("Provider 抛异常折成 FAILED，不冒泡", async () => {
		const accounts = new InMemoryAccountStore();
		makeAccount(accounts, "WORKBUDDY");
		const { records, service } = buildService(accounts, [
			stubProvider("WORKBUDDY", () => {
				throw new Error("https://upstream.example.com/v2/xxx?token=secret 爆了");
			}),
		]);

		const batch = await service.checkInAll();
		expect(batch.failed).toBe(1);
		const [record] = records.recent(1);
		expect(record?.status).toBe("FAILED");
		// 上游消息脱敏：URL 只留 host
		expect(record?.message).not.toContain("token=secret");
		expect(record?.message).toContain("upstream.example.com");
	});

	it("AUTH_ERROR 触发凭证健康钩子；SUCCESS/ALREADY 触发成功钩子", async () => {
		const accounts = new InMemoryAccountStore();
		const failing = makeAccount(accounts, "WORKBUDDY");
		const ok = makeAccount(accounts, "TRAE");
		const failures: string[] = [];
		const successes: string[] = [];
		const records = new InMemoryCheckInRecordStore();
		const service = new CheckInService({
			accounts,
			records,
			providers: [
				stubProvider("WORKBUDDY", () => checkInAuthError("会话过期", NOW)),
				stubProvider("TRAE", () => checkInAlready("今日已签到", null, NOW)),
			],
			credentialHealth: {
				markAuthFailure: (account, message) => failures.push(`${account.id}:${message}`),
				markAuthSuccess: (account) => successes.push(account.id),
			},
			nowMs: () => NOW,
		});

		await service.checkInAll();
		expect(failures).toEqual([`${failing.id}:会话过期`]);
		expect(successes).toEqual([ok.id]);
	});

	it("补签：只签今天业务日未成功的启用账号", async () => {
		const accounts = new InMemoryAccountStore();
		const today = todayRange(NOW);
		const signed = makeAccount(accounts, "WORKBUDDY");
		accounts.patchState(signed.id, { lastCheckInAt: today.from + 1000, lastCheckInStatus: "SUCCESS" });
		const failedEarlier = makeAccount(accounts, "WORKBUDDY");
		accounts.patchState(failedEarlier.id, { lastCheckInAt: today.from + 1000, lastCheckInStatus: "FAILED" });
		const fresh = makeAccount(accounts, "WORKBUDDY"); // 从未签过
		makeAccount(accounts, "WORKBUDDY", false); // 停用账号不参与补签
		const { service } = buildService(accounts, [stubProvider("WORKBUDDY", () => checkInSuccess("补签成功", 1, NOW))]);

		expect(service.countUnsigned()).toBe(2);
		const batch = await service.catchUpUnsigned();
		expect(batch).not.toBeNull();
		expect(batch?.total).toBe(2);
		expect(batch?.success).toBe(2);
		expect(batch?.items.map((item) => item.accountId).sort()).toEqual([failedEarlier.id, fresh.id].sort());

		// 补签后全员已签 → 返回 null（对齐 Java 版）
		expect(service.countUnsigned()).toBe(0);
		expect(await service.catchUpUnsigned()).toBeNull();
	});

	it("signedToday 判定：昨天/边界外不算，OK 状态算", () => {
		const accounts = new InMemoryAccountStore();
		const account = makeAccount(accounts, "WORKBUDDY");
		const today = todayRange(NOW);

		expect(signedToday(account, NOW)).toBe(false);
		// 昨天签的不算
		expect(signedToday({ ...account, lastCheckInAt: today.from - 1, lastCheckInStatus: "SUCCESS" }, NOW)).toBe(false);
		// 今天区间终点不算（左闭右开）
		expect(signedToday({ ...account, lastCheckInAt: today.to, lastCheckInStatus: "SUCCESS" }, NOW)).toBe(false);
		// OK 是历史遗留的成功状态
		expect(signedToday({ ...account, lastCheckInAt: today.from + 1, lastCheckInStatus: "OK" }, NOW)).toBe(true);
		// 业务日确实是上海时区的今天
		expect(businessDayString(NOW)).toBe("2026-10-08");
	});

	it("记录管理：recent 倒序、delete/clear、不存在的记录报错", async () => {
		const accounts = new InMemoryAccountStore();
		const account = makeAccount(accounts, "WORKBUDDY");
		const { records, service } = buildService(accounts, [
			stubProvider("WORKBUDDY", () => checkInSuccess("ok", null, NOW)),
		]);

		await service.checkInOne(account.id);
		await service.checkInOne(account.id);
		expect(records.recent(10)).toHaveLength(2);

		service.deleteRecord("rec-1");
		expect(records.recent(10)).toHaveLength(1);
		expect(() => service.deleteRecord("rec-1")).toThrow(BusinessError);

		service.clearRecords();
		expect(records.recent(10)).toHaveLength(0);
	});
});
