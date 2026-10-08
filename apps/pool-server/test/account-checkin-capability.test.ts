import type { AddressInfo } from "node:net";
import {
	type Account,
	type CheckInProvider,
	CheckInService,
	checkInSuccess,
	InMemoryAccountStore,
	InMemoryCheckInRecordStore,
} from "owl-pool";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPoolServer } from "../src/server.ts";

let accounts: InMemoryAccountStore;
let records: InMemoryCheckInRecordStore;
let server: ReturnType<typeof createPoolServer>;
let baseUrl: string;
let called: string[];

interface ApiBody {
	ok: boolean;
	data: unknown;
	code?: string;
}

beforeEach(async () => {
	accounts = new InMemoryAccountStore();
	records = new InMemoryCheckInRecordStore();
	called = [];
	const provider: CheckInProvider = {
		supports: () => "WORKBUDDY",
		isConfigured: (account) =>
			typeof account.credentials.accessToken === "string" && account.credentials.accessToken.trim().length > 0,
		checkIn: async (account) => {
			called.push(account.id);
			return checkInSuccess("签到成功", 7);
		},
	};
	const checkin = new CheckInService({ accounts, records, providers: [provider] });
	server = createPoolServer({ accounts, records, checkin, dbPath: "test-memory-only", isDbAlive: () => true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function api(method: string, path: string, body?: unknown) {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as ApiBody };
}

function create(
	name: string,
	platform: Account["platform"] = "WORKBUDDY",
	credentials: Record<string, unknown> = { accessToken: "test-token" },
	enabled = true,
) {
	return accounts.create({ name, platform, credentials, enabled }, 0);
}

describe("account check-in capability API", () => {
	it("所有账号视图返回真实未脱敏配置判定，支持签到且未配置账号留在支持分类", async () => {
		const created = await api("POST", "/api/accounts", { name: "账号", platform: "WORKBUDDY", credentials: {} });
		expect(created.body.data).toMatchObject({ checkInSupported: true, checkInConfigured: false });
		const id = (created.body.data as Account).id;
		const updated = await api("PUT", `/api/accounts/${id}`, {
			name: "账号",
			credentials: { accessToken: "test-token" },
		});
		expect(updated.body.data).toMatchObject({
			checkInSupported: true,
			checkInConfigured: true,
			credentials: { accessToken: "***" },
		});
		expect((await api("PATCH", `/api/accounts/${id}/enabled?enabled=false`)).body.data).toMatchObject({
			checkInSupported: true,
			checkInConfigured: true,
			enabled: false,
		});
		expect((await api("GET", `/api/accounts/${id}`)).body.data).toMatchObject({
			checkInSupported: true,
			checkInConfigured: true,
		});
		expect((await api("POST", `/api/accounts/${id}/credits/refresh`)).body.data).toMatchObject({
			checkInSupported: true,
			checkInConfigured: true,
		});
		create("不支持", "CODEX", {});
		const list = (await api("GET", "/api/accounts")).body.data as Array<Record<string, unknown>>;
		expect(list.find((account) => account.platform === "CODEX")).toMatchObject({
			checkInSupported: false,
			checkInConfigured: false,
		});
	});

	it("按当前账号 ID 批量签到，重复 ID 不重复执行，不支持/停用/缺配置跳过", async () => {
		const selected = create("选中");
		create("范围外");
		const disabled = create("停用", "WORKBUDDY", { accessToken: "test-token" }, false);
		const unconfigured = create("待配置", "WORKBUDDY", {});
		const unsupported = create("无签到", "CODEX", {});
		const result = await api("POST", "/api/checkin/all?onlyEnabled=false", {
			accountIds: [selected.id, selected.id, disabled.id, unconfigured.id, unsupported.id],
		});
		expect(result.status).toBe(200);
		expect(result.body.data).toMatchObject({ requested: 4, total: 1, success: 1, skipped: 3 });
		expect(called).toEqual([selected.id]);
		expect(records.recent(10)).toHaveLength(1);
	});

	it("非法或不存在 ID 返回错误且不会执行前面合法账号；空筛选不会回退全签", async () => {
		const selected = create("账号");
		for (const accountIds of [null, "bad", [1], [selected.id, " "]]) {
			const result = await api("POST", "/api/checkin/all", { accountIds });
			expect(result.status).toBe(400);
			expect(result.body.code).toBe("checkin.badAccountIds");
		}
		expect((await api("POST", "/api/checkin/all", { accountIds: [selected.id, "missing"] })).status).toBe(404);
		expect((await api("POST", "/api/checkin/all", { accountIds: [] })).body.data).toMatchObject({
			total: 0,
			requested: 0,
			skipped: 0,
		});
		expect(called).toEqual([]);
	});

	it("省略 accountIds 保留既有全量签到请求", async () => {
		const selected = create("账号");
		expect((await api("POST", "/api/checkin/all")).body.data).toMatchObject({ total: 1, success: 1 });
		expect(called).toEqual([selected.id]);
	});
});
