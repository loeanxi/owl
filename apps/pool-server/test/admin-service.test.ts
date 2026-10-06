import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminSecurityConfig } from "../src/security/admin-service.ts";
import { AdminAuthService } from "../src/security/admin-service.ts";
import { LoginFailureTracker } from "../src/security/lockout.ts";
import { SqliteAdminCredentialStore } from "../src/store/admin-credential-store.ts";
import { openDb } from "../src/store/db.ts";

const workdirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
	while (closers.length > 0) {
		closers.pop()?.();
	}
	const dir = workdirs.pop();
	if (dir !== undefined) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows 偶发句柄延迟；留在临时目录由系统清理
		}
	}
});

function makeService(overrides: Partial<AdminSecurityConfig> = {}, nowMs: () => number = () => 1_700_000_000_000) {
	const dir = mkdtempSync(join(tmpdir(), "owl-pool-admin-"));
	workdirs.push(dir);
	const db = openDb(join(dir, "test.db"));
	const config: AdminSecurityConfig = {
		enabled: true,
		username: "admin",
		password: "",
		setupToken: "",
		apiKey: "",
		cookieName: "owl_pool_admin",
		sessionTtlHours: 12,
		requireHttps: false,
		maxLoginFailures: 3,
		lockoutMinutes: 10,
		failureStoreFile: null,
		sessionStoreFile: null,
		...overrides,
	};
	const credentials = new SqliteAdminCredentialStore(db);
	closers.push(() => db.close());
	const service = new AdminAuthService({ config, credentials, nowMs });
	return { config, service };
}

describe("AdminAuthService", () => {
	it("首次设置：一次性入口，之后 setup 拒绝；成功即登录", () => {
		const { service } = makeService();
		expect(service.isSetupRequired()).toBe(true);

		const issued = service.setup("boss", "passw0rd!", "127.0.0.1");
		expect(issued).not.toBeNull();
		expect(issued?.session.username).toBe("boss");
		expect(service.authenticate(issued?.token)).not.toBeNull();

		expect(service.isSetupRequired()).toBe(false);
		expect(service.setup("other", "passw0rd!", "127.0.0.1")).toBeNull();
	});

	it("用户名归一与口令强度校验", () => {
		const { service } = makeService();
		// 非法字符（空格）的用户名被归一拒绝，且不消耗一次性设置机会
		expect(service.setup("有 空 格", "passw0rd!", "127.0.0.1")).toBeNull();
		expect(service.isSetupRequired()).toBe(true);

		expect(service.setup("boss", "passw0rd!", "127.0.0.1")).not.toBeNull();
		expect(service.setup("other", "passw0rd!", "127.0.0.1")).toBeNull();

		// 强度规则
		expect(service.validatePassword("short1a", "boss")).toBe("口令至少 8 位");
		expect(service.validatePassword("12345678", "boss")).toBe("口令需同时包含字母与数字/符号");
		expect(service.validatePassword("abcdefgh", "boss")).toBe("口令需同时包含字母与数字/符号");
		expect(service.validatePassword("Passw0rd", "boss")).toBeNull();
		expect(service.validatePassword("boss1234", "boss")).toBeNull();
		// 口令与用户名完全相同（长度达标时）才拦
		expect(service.validatePassword("longusername", "longusername")).toBe("口令不能与用户名相同");
		expect(service.validatePassword("1234567a", "boss")).toBeNull();
	});

	it("登录成功/失败；失败计入锁定（IP 维度阈值 = maxLoginFailures）", () => {
		const { service } = makeService({ maxLoginFailures: 3 });
		service.setup("boss", "passw0rd!", "10.0.0.1");

		const ok = service.login("boss", "passw0rd!", "10.0.0.1");
		expect(ok).not.toBeNull();
		expect(service.login("boss", "wrong-pass", "10.0.0.1")).toBeNull();
		expect(service.login("boss", "wrong-pass", "10.0.0.1")).toBeNull();

		// 第 3 次失败：IP 锁定，随后即使口令正确也拒绝
		expect(service.login("boss", "wrong-pass", "10.0.0.1")).toBeNull();
		expect(service.isLocked("10.0.0.1", "boss")).toBe(true);
		expect(service.login("boss", "passw0rd!", "10.0.0.1")).toBeNull();

		// 其他 IP 不受该 IP 锁定影响
		expect(service.login("boss", "passw0rd!", "10.0.0.2")).not.toBeNull();
	});

	it("用户名维度跨 IP 聚合（阈值 5 倍）：轮换 IP 也锁得住", () => {
		const { service } = makeService({ maxLoginFailures: 2 });
		service.setup("boss", "passw0rd!", "10.0.0.1");

		// 5 个不同 IP 各失败 2 次 = 用户名维度 10 次 ≥ 2*5 → 锁定
		for (let i = 0; i < 5; i++) {
			for (let j = 0; j < 2; j++) {
				expect(service.login("boss", "bad", `10.1.0.${i}`)).toBeNull();
			}
		}
		// 新 IP 也被用户名维度锁住
		expect(service.login("boss", "passw0rd!", "10.9.9.9")).toBeNull();
	});

	it("锁定窗口过期后自动解锁（注入时钟）", () => {
		let now = 1_700_000_000_000;
		const { service } = makeService({ maxLoginFailures: 1, lockoutMinutes: 10 }, () => now);
		service.setup("boss", "passw0rd!", "10.0.0.1");

		expect(service.login("boss", "bad", "10.0.0.1")).toBeNull();
		expect(service.isLocked("10.0.0.1", "boss")).toBe(true);

		now += 10 * 60_000 + 1;
		expect(service.isLocked("10.0.0.1", "boss")).toBe(false);
		expect(service.login("boss", "passw0rd!", "10.0.0.1")).not.toBeNull();
	});

	it("改密：旧口令失效、旧会话全部失效、新会话可用", () => {
		const { service } = makeService();
		const first = service.setup("boss", "passw0rd!", "127.0.0.1");
		const second = service.login("boss", "passw0rd!", "127.0.0.2");

		const changed = service.changePassword("passw0rd!", "newpass99", "127.0.0.1");
		expect(changed).not.toBeNull();

		// 旧会话全部失效
		expect(service.authenticate(first?.token)).toBeNull();
		expect(service.authenticate(second?.token)).toBeNull();
		expect(service.authenticate(changed?.token)).not.toBeNull();
		// 旧口令不能再登录；新口令可登录
		expect(service.login("boss", "passw0rd!", "127.0.0.1")).toBeNull();
		expect(service.login("boss", "newpass99", "127.0.0.1")).not.toBeNull();
	});

	it("配置态口令：指纹一致沿用、换口令即重建凭据", () => {
		const shared = makeService({ password: "config-pass1" });
		expect(shared.service.isSetupRequired()).toBe(false);
		expect(shared.service.login("admin", "config-pass1", "127.0.0.1")).not.toBeNull();

		// 同一口令重复 sync 不重建（会话不清空）
		const token = shared.service.login("admin", "config-pass1", "127.0.0.1")?.token ?? "";
		shared.service.syncCredential();
		expect(shared.service.authenticate(token)).not.toBeNull();

		// 换配置口令 → 凭据重建、旧口令失效
		const rotated = makeService({ password: "config-pass2" });
		expect(rotated.service.login("admin", "config-pass2", "127.0.0.1")).not.toBeNull();
		expect(rotated.service.login("admin", "config-pass1", "127.0.0.1")).toBeNull();
	});

	it("会话持久化：重启（新实例）后未过期会话恢复；TTL 过期被丢弃", () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-pool-admin-"));
		workdirs.push(dir);
		const db = openDb(join(dir, "test.db"));
		let now = 1_700_000_000_000;
		const config: AdminSecurityConfig = {
			enabled: true,
			username: "admin",
			password: "",
			setupToken: "",
			apiKey: "",
			cookieName: "owl_pool_admin",
			sessionTtlHours: 1,
			requireHttps: false,
			maxLoginFailures: 10,
			lockoutMinutes: 10,
			failureStoreFile: join(dir, "admin-login-failures.json"),
			sessionStoreFile: join(dir, "admin-sessions.json"),
		};
		const credentials = new SqliteAdminCredentialStore(db);
		closers.push(() => db.close());
		const make = () => new AdminAuthService({ config, credentials, nowMs: () => now });

		const first = make();
		const issued = first.setup("boss", "passw0rd!", "127.0.0.1");

		// 模拟重启：新实例从快照恢复
		const second = make();
		expect(second.authenticate(issued?.token)).not.toBeNull();

		// 推进 1 小时 + 1ms → 会话过期
		now += 3_600_000 + 1;
		expect(second.authenticate(issued?.token)).toBeNull();
		expect(first.authenticate(issued?.token)).toBeNull();
	});

	it("登录失败计数快照：重启后锁定进度继续累计", () => {
		const dir = mkdtempSync(join(tmpdir(), "owl-pool-admin-"));
		workdirs.push(dir);
		const db = openDb(join(dir, "test.db"));
		const config: AdminSecurityConfig = {
			enabled: true,
			username: "admin",
			password: "",
			setupToken: "",
			apiKey: "",
			cookieName: "owl_pool_admin",
			sessionTtlHours: 12,
			requireHttps: false,
			maxLoginFailures: 3,
			lockoutMinutes: 10,
			failureStoreFile: join(dir, "admin-login-failures.json"),
			sessionStoreFile: null,
		};
		const credentials = new SqliteAdminCredentialStore(db);
		closers.push(() => db.close());
		const make = () => new AdminAuthService({ config, credentials });

		const first = make();
		first.setup("boss", "passw0rd!", "10.0.0.1");
		first.login("boss", "bad", "10.0.0.1");
		first.login("boss", "bad", "10.0.0.1");

		// 重启后第 3 次失败即触发锁定（前 2 次已从快照恢复）
		const second = make();
		expect(second.login("boss", "bad", "10.0.0.1")).toBeNull();
		expect(second.isLocked("10.0.0.1", "boss")).toBe(true);
	});

	it("登出使 token 立即失效", () => {
		const { service } = makeService();
		const issued = service.setup("boss", "passw0rd!", "127.0.0.1");
		expect(service.logout(issued?.token)).toBe(true);
		expect(service.authenticate(issued?.token)).toBeNull();
		expect(service.logout("no-such-token")).toBe(false);
	});

	it("LoginFailureTracker：纯内存模式与窗口过期", () => {
		let now = 1_700_000_000_000;
		const tracker = new LoginFailureTracker({ file: null, maxFailures: 2, lockoutMinutes: 10, nowMs: () => now });
		tracker.recordFailure("10.0.0.1", "boss");
		tracker.recordFailure("10.0.0.1", "boss");
		expect(tracker.isLocked("10.0.0.1", "boss")).toBe(true);

		now += 10 * 60_000 + 1;
		expect(tracker.isLocked("10.0.0.1", "boss")).toBe(false);
	});
});
