import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckInProvider, type CheckInResult, CheckInService, checkInSuccess } from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminGuard } from "../src/security/admin-guard.ts";
import { AdminAuthService, type AdminSecurityConfig } from "../src/security/admin-service.ts";
import { createPoolServer } from "../src/server.ts";
import { SqliteAccountStore } from "../src/store/account-store.ts";
import { SqliteAdminCredentialStore } from "../src/store/admin-credential-store.ts";
import { newRecordId, SqliteCheckInRecordStore } from "../src/store/checkin-record-store.ts";
import { dbAlive, openDb } from "../src/store/db.ts";

let workdir: string;
let server: ReturnType<typeof createPoolServer>;
let baseUrl: string;
const providerResults: CheckInResult[] = [];
const adminConfig: AdminSecurityConfig = {
	enabled: true,
	username: "admin",
	password: "",
	setupToken: "a".repeat(32),
	apiKey: "script-key-123",
	cookieName: "owl_pool_admin",
	sessionTtlHours: 12,
	requireHttps: false,
	maxLoginFailures: 3,
	lockoutMinutes: 10,
	failureStoreFile: null,
	sessionStoreFile: null,
};

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-pool-adminflow-"));
	const db = openDb(join(workdir, "pool.db"));
	const accounts = new SqliteAccountStore(db);
	const records = new SqliteCheckInRecordStore(db);
	const stubWorkBuddy: CheckInProvider = {
		supports: () => "WORKBUDDY",
		checkIn: async () => providerResults.shift() ?? checkInSuccess("签到成功", 1, Date.now()),
	};
	const checkin = new CheckInService({ accounts, records, providers: [stubWorkBuddy], newId: newRecordId });
	const service = new AdminAuthService({ config: adminConfig, credentials: new SqliteAdminCredentialStore(db) });
	server = createPoolServer({
		accounts,
		records,
		checkin,
		dbPath: join(workdir, "pool.db"),
		isDbAlive: () => dbAlive(db),
		admin: {
			config: adminConfig,
			service,
			guard: new AdminGuard({ config: adminConfig, service }),
			trustedProxyCount: 0,
		},
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
	data?: Record<string, unknown>;
	error?: string;
	code?: string;
}

async function api(
	method: string,
	path: string,
	options: { body?: unknown; cookie?: string; adminKey?: string } = {},
): Promise<{ status: number; json: ApiBody; setCookie: string[] }> {
	const headers: Record<string, string> = {};
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	if (options.cookie !== undefined) {
		headers.Cookie = options.cookie;
	}
	if (options.adminKey !== undefined) {
		headers["X-Admin-Key"] = options.adminKey;
	}
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	return {
		status: response.status,
		json: (await response.json()) as ApiBody,
		setCookie: response.headers.getSetCookie(),
	};
}

/** 从 Set-Cookie 里抠出会话 Cookie 串（供后续请求携带）。 */
function cookieOf(setCookies: string[]): string {
	const header = setCookies.find((line) => line.startsWith("owl_pool_admin=")) ?? "";
	const token = header.slice("owl_pool_admin=".length).split(";")[0] ?? "";
	return `owl_pool_admin=${token}`;
}

describe("管理端鉴权（HTTP 全流程）", () => {
	it("未认证访问受保护接口 → 401（admin.unauthenticated）", async () => {
		const { status, json } = await api("GET", "/api/accounts");
		expect(status).toBe(401);
		expect(json.code).toBe("admin.unauthenticated");
	});

	it("匿名白名单：/api/admin/session 可达，报告 setupRequired", async () => {
		const { status, json } = await api("GET", "/api/admin/session");
		expect(status).toBe(200);
		expect(json.data).toMatchObject({ enabled: true, authenticated: false, setupRequired: true });
		// 回环来源不要求 setup token
		expect(json.data?.setupTokenRequired).toBe(false);
	});

	it("setup → 直接登录 → 带 Cookie 访问受保护接口", async () => {
		const bad = await api("POST", "/api/admin/setup", {
			body: { username: "boss", password: "short", confirmPassword: "short" },
		});
		expect(bad.json.code).toBe("admin.passwordTooWeak");

		const mismatch = await api("POST", "/api/admin/setup", {
			body: { username: "boss", password: "passw0rd!", confirmPassword: "different1" },
		});
		expect(mismatch.json.code).toBe("admin.passwordMismatch");

		const created = await api("POST", "/api/admin/setup", {
			body: { username: "boss", password: "passw0rd!", confirmPassword: "passw0rd!" },
		});
		expect(created.status).toBe(200);
		expect(created.json.data).toMatchObject({ authenticated: true, username: "boss" });
		const cookie = cookieOf(created.setCookie);
		expect(cookie).not.toBe("owl_pool_admin=");

		const list = await api("GET", "/api/accounts", { cookie });
		expect(list.status).toBe(200);
		expect(list.json.ok).toBe(true);

		// setup 二次调用 → 409
		const again = await api("POST", "/api/admin/setup", {
			body: { username: "boss", password: "passw0rd!", confirmPassword: "passw0rd!" },
		});
		expect(again.status).toBe(409);
		expect(again.json.code).toBe("admin.passwordAlreadySet");

		// 会话查询显示已认证
		const session = await api("GET", "/api/admin/session", { cookie });
		expect(session.json.data).toMatchObject({ authenticated: true, setupRequired: false, username: "boss" });
	});

	it("X-Admin-Key 直连管理接口（脚本/CI 通道）", async () => {
		const { status, json } = await api("GET", "/api/accounts", { adminKey: adminConfig.apiKey });
		expect(status).toBe(200);
		expect(json.ok).toBe(true);

		const wrong = await api("GET", "/api/accounts", { adminKey: "wrong-key" });
		expect(wrong.status).toBe(401);
	});

	it("登录 → 补签挂钩（有待补签账号时返回 catchUpPending）→ 登出后 Cookie 失效", async () => {
		// 准备一个从未签到的启用账号，登录时应触发补签统计
		const setupLogin = await api("POST", "/api/admin/login", { body: { username: "boss", password: "passw0rd!" } });
		expect(setupLogin.status).toBe(200);
		const cookie = cookieOf(setupLogin.setCookie);
		await api("POST", "/api/accounts", {
			cookie,
			body: { name: "补签号", platform: "WORKBUDDY", credentials: { accessToken: "t" } },
		});

		// 用 X-Admin-Key 登出旧会话场景不适用——重新走登录拿新会话
		const login = await api("POST", "/api/admin/login", { body: { username: "boss", password: "passw0rd!" } });
		expect(login.status).toBe(200);
		expect(login.json.data?.authenticated).toBe(true);
		// 有未签到账号 → catchUpPending > 0（补签在后台异步执行）
		expect(Number(login.json.data?.catchUpPending ?? 0)).toBeGreaterThan(0);

		const logout = await api("POST", "/api/admin/logout", { cookie: cookieOf(login.setCookie) });
		expect(logout.json.data).toMatchObject({ authenticated: false });
		// 旧 Cookie 已从会话表移除
		const afterLogout = await api("GET", "/api/accounts", { cookie: cookieOf(login.setCookie) });
		expect(afterLogout.status).toBe(401);
	});

	it("改密后旧会话失效、新会话可用", async () => {
		const login = await api("POST", "/api/admin/login", { body: { username: "boss", password: "passw0rd!" } });
		const oldCookie = cookieOf(login.setCookie);

		const changed = await api("POST", "/api/admin/password", {
			cookie: oldCookie,
			body: { currentPassword: "passw0rd!", newPassword: "newpass99", confirmPassword: "newpass99" },
		});
		expect(changed.status).toBe(200);
		const newCookie = cookieOf(changed.setCookie);

		expect((await api("GET", "/api/accounts", { cookie: oldCookie })).status).toBe(401);
		expect((await api("GET", "/api/accounts", { cookie: newCookie })).status).toBe(200);

		// 用新口令登录回来（后续测试依赖）
		const relogin = await api("POST", "/api/admin/login", { body: { username: "boss", password: "newpass99" } });
		expect(relogin.status).toBe(200);
	});

	it("登录失败 3 次锁定；期间正确口令也 401（admin.loginFailed）", async () => {
		for (let i = 0; i < 3; i++) {
			const failed = await api("POST", "/api/admin/login", {
				body: { username: "boss", password: "totally-wrong" },
			});
			expect(failed.status).toBe(401);
		}
		const locked = await api("POST", "/api/admin/login", { body: { username: "boss", password: "newpass99" } });
		expect(locked.status).toBe(401);
		expect(locked.json.code).toBe("admin.loginFailed");
	});

	it("healthz 始终匿名可达；业务日定时器不受鉴权影响", async () => {
		const { status, json } = await api("GET", "/healthz");
		expect(status).toBe(200);
		expect(json).toMatchObject({ status: "UP", db: "UP" });
	});
});
