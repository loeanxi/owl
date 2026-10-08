import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckInProvider, type CheckInResult, CheckInService, checkInSuccess } from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createPoolServer } from "../src/server.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { newRecordId, SqliteCheckInRecordStore } from "../src/store/checkin-record-store.ts";
import { dbAlive, openDb } from "../src/store/db.ts";

let workdir: string;
let server: ReturnType<typeof createPoolServer>;
let baseUrl: string;
const providerResults: CheckInResult[] = [];

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-pool-server-"));
	const db = openDb(join(workdir, "pool.db"));
	const accounts = new SqliteAccountStore(db);
	const records = new SqliteCheckInRecordStore(db);
	const stubWorkBuddy: CheckInProvider = {
		supports: () => "WORKBUDDY",
		checkIn: async () => providerResults.shift() ?? checkInSuccess("签到成功", 7, Date.now()),
	};
	const checkin = new CheckInService({ accounts, records, providers: [stubWorkBuddy], newId: newRecordId });
	server = createPoolServer({
		accounts,
		records,
		checkin,
		dbPath: join(workdir, "pool.db"),
		isDbAlive: () => dbAlive(db),
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server.close();
	setTimeout(() => {
		try {
			rmSync(workdir, { recursive: true, force: true });
		} catch {
			// Windows 偶发句柄延迟；留在临时目录由系统清理
		}
	}, 200);
});

interface ApiBody {
	ok: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: ApiBody }> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: response.status, json: (await response.json()) as ApiBody };
}

describe("pool-server REST（阶段 0+1 冒烟）", () => {
	it("GET / 是 manager 首页，/admin 是管理台，/member 是成员端", async () => {
		const home = await fetch(`${baseUrl}/`);
		const admin = await fetch(`${baseUrl}/admin`);
		const member = await fetch(`${baseUrl}/member`);
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("home-body");
		expect(admin.status).toBe(200);
		expect(await admin.text()).toContain('data-view="overview"');
		expect(member.status).toBe(200);
		expect(await member.text()).toContain("member-login-page");
	});

	it("GET /healthz：manager 形状，db 探活", async () => {
		const { status, json } = await api("GET", "/healthz");
		expect(status).toBe(200);
		expect(json).toMatchObject({ status: "UP", db: "UP" });
		expect((json as unknown as Record<string, unknown>).uptimeSeconds).toBeTypeOf("number");
	});

	it("账号 CRUD 全流程", async () => {
		const created = await api("POST", "/api/accounts", {
			name: "主力号",
			platform: "WORKBUDDY",
			credentials: { accessToken: "secret-token" },
			remark: "测试",
		});
		expect(created.status).toBe(200);
		expect(created.json.ok).toBe(true);
		const account = created.json.data as Record<string, unknown>;
		const id = String(account.id);
		expect(account.platform).toBe("WORKBUDDY");
		// 凭证脱敏
		expect((account.credentials as Record<string, unknown>).accessToken).toBe("***");

		const list = await api("GET", "/api/accounts?platform=WORKBUDDY");
		expect((list.json.data as unknown[]).length).toBeGreaterThanOrEqual(1);

		const badPlatform = await api("GET", "/api/accounts?platform=NOPE");
		expect(badPlatform.status).toBe(400);

		const updated = await api("PUT", `/api/accounts/${id}`, { name: "改名号", credentials: { accessToken: "***" } });
		expect((updated.json.data as Record<string, unknown>).name).toBe("改名号");

		const enabled = await api("PATCH", `/api/accounts/${id}/enabled?enabled=false`);
		expect((enabled.json.data as Record<string, unknown>).enabled).toBe(false);

		const missing = await api("GET", "/api/accounts/no-such-id");
		expect(missing.status).toBe(404);
		expect(missing.json.code).toBe("account.notFound");

		const removed = await api("DELETE", `/api/accounts/${id}`);
		expect(removed.json.ok).toBe(true);
	});

	it("签到流程：单号 → 记录可查；不存在的账号 404", async () => {
		const created = await api("POST", "/api/accounts", {
			name: "签到号",
			platform: "WORKBUDDY",
			credentials: { accessToken: "tok" },
		});
		const id = String((created.json.data as Record<string, unknown>).id);

		providerResults.push(checkInSuccess("签到成功", 3, Date.now()));
		const checkin = await api("POST", `/api/checkin/accounts/${id}`);
		expect(checkin.json.ok).toBe(true);
		expect((checkin.json.data as Record<string, unknown>).platform).toBe("WORKBUDDY");

		const records = await api("GET", "/api/checkin/records");
		const recordList = records.json.data as Array<Record<string, unknown>>;
		expect(recordList.length).toBeGreaterThanOrEqual(1);
		expect(recordList[0]?.status).toBe("SUCCESS");

		const missing = await api("POST", "/api/checkin/accounts/no-such-id");
		expect(missing.status).toBe(404);
	});

	it("一键全签：无账号时 409", async () => {
		// 测试进程的临时库此时有启用账号吗——签到号还在，先清掉所有账号确保空库分支
		const list = await api("GET", "/api/accounts");
		for (const item of list.json.data as Array<Record<string, unknown>>) {
			await api("DELETE", `/api/accounts/${String(item.id)}`);
		}
		const empty = await api("POST", "/api/checkin/all");
		expect(empty.status).toBe(409);
		expect(empty.json.code).toBe("checkin.noAccounts");
	});

	it("未知路径 404（ApiResponse 形状）", async () => {
		const { status, json } = await api("GET", "/api/nope");
		expect(status).toBe(404);
		expect(json.ok).toBe(false);
		expect(json.code).toBe("common.notFound");
	});

	it("config：env 覆盖与默认值", () => {
		const config = loadConfig({ OWL_POOL_PORT: "9999", OWL_POOL_DB: "x.db" } as NodeJS.ProcessEnv);
		expect(config.port).toBe(9999);
		expect(config.dbPath).toBe("x.db");
		expect(config.host).toBe("127.0.0.1");
		const defaults = loadConfig({} as NodeJS.ProcessEnv);
		expect(defaults.port).toBe(8790);
		expect(defaults.checkInHour).toBe(0);
		expect(defaults.checkInStaggerMs).toBe(3000);
	});

	it("config：成员并发租约默认参数可由 env 覆盖", () => {
		const defaults = loadConfig({} as NodeJS.ProcessEnv);
		expect(defaults.memberConcurrency).toEqual({ defaultLimit: 2, maxWaiting: 8, waitMillis: 2000 });
		const overridden = loadConfig({
			OWL_POOL_MEMBER_CONCURRENCY_DEFAULT: "12",
			OWL_POOL_MEMBER_CONCURRENCY_MAX_WAITING: "32",
			OWL_POOL_MEMBER_CONCURRENCY_WAIT_MS: "30000",
		} as NodeJS.ProcessEnv);
		expect(overridden.memberConcurrency).toEqual({ defaultLimit: 12, maxWaiting: 32, waitMillis: 30000 });
	});
});
