/**
 * account-store 单测：桌面端应用用户账号注册表。
 *
 * 关键契约：
 * - 首次访问 seed「本地」账号，dataDir = OWL_CODING_AGENT_DIR（现有数据原地认领，零迁移）；
 * - 一个账号一个 agentDir，新建账号落 ~/.owl/users/<id>/agent；
 * - 切换只改注册表 currentId（数据空间等壳重启桥进程才生效）；
 * - 密码 scrypt 哈希，校验失败不落盘；注册表损坏时备份并重建，不抛错。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	avatarPath,
	createDesktopAccount,
	desktopAccountStatus,
	getAccountsPath,
	listDesktopAccounts,
	readAvatar,
	removeAvatar,
	switchDesktopAccount,
	writeAvatar,
} from "../../src/modes/desktop/account-store.ts";

describe("desktop account store", () => {
	const tempDirs: string[] = [];
	const savedEnv: Record<string, string | undefined> = {};

	function useTempHome(agentDir?: string): string {
		const dir = mkdtempSync(join(tmpdir(), "owl-accounts-test-"));
		tempDirs.push(dir);
		// os.homedir() 每次动态读环境变量：Windows 用 USERPROFILE，POSIX 用 HOME
		process.env.USERPROFILE = dir;
		process.env.HOME = dir;
		process.env.OWL_CODING_AGENT_DIR = agentDir ?? join(dir, "existing-agent-data");
		return dir;
	}

	beforeEach(() => {
		for (const key of ["USERPROFILE", "HOME", "OWL_CODING_AGENT_DIR"]) {
			savedEnv[key] = process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("seeds a local account pointing at the running agent dir (zero-migration)", () => {
		const dir = useTempHome();
		const status = desktopAccountStatus();
		expect(status.runningId).toBe("local");
		expect(status.nextId).toBe("local");
		expect(status.account?.dataDir).toBe(join(dir, "existing-agent-data"));
		expect(status.account?.hasPassword).toBe(false);
		expect(listDesktopAccounts()).toHaveLength(1);
	});

	it("creates an account in its own data dir and enforces name/password rules", () => {
		useTempHome();
		const account = createDesktopAccount("工作号", "secret1");
		expect(account.id).toMatch(/^acc-/);
		expect(account.dataDir).toContain(join("users", account.id, "agent"));
		expect(account.hasPassword).toBe(true);
		expect(listDesktopAccounts().map((entry) => entry.name)).toEqual(["本地", "工作号"]);

		expect(() => createDesktopAccount("  ")).toThrow("账号名不能为空");
		expect(() => createDesktopAccount("工作号")).toThrow("已存在同名账号");
		expect(() => createDesktopAccount("另一号", "abc")).toThrow("密码至少 4 位");
		const free = createDesktopAccount("免密号");
		expect(free.hasPassword).toBe(false);
	});

	it("switches password-free accounts directly and guarded accounts only with the right password", () => {
		useTempHome();
		const guarded = createDesktopAccount("加密号", "hunter2");
		const free = createDesktopAccount("免密号");

		const switchedFree = switchDesktopAccount(free.id);
		expect(switchedFree.id).toBe(free.id);
		expect(desktopAccountStatus().nextId).toBe(free.id);

		expect(() => switchDesktopAccount(guarded.id)).toThrow("密码错误");
		expect(() => switchDesktopAccount(guarded.id, "wrong-pass")).toThrow("密码错误");
		expect(desktopAccountStatus().nextId).toBe(free.id);

		const switchedGuarded = switchDesktopAccount(guarded.id, "hunter2");
		expect(switchedGuarded.id).toBe(guarded.id);
		expect(desktopAccountStatus().nextId).toBe(guarded.id);

		expect(() => switchDesktopAccount("acc-nonexist")).toThrow("账号不存在");
	});

	it("rebuilds the registry from the local account when the file is corrupt", () => {
		useTempHome();
		createDesktopAccount("临时号");
		writeFileSync(getAccountsPath(), "{not json", "utf-8");

		const status = desktopAccountStatus();
		expect(status.runningId).toBe("local");
		expect(listDesktopAccounts().map((entry) => entry.name)).toEqual(["本地"]);
	});

	it("stores the avatar per agent dir and validates its payload", () => {
		const dir = useTempHome();
		const agentDir = join(dir, "existing-agent-data");
		const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;

		expect(readAvatar(agentDir)).toBeNull();
		writeAvatar(agentDir, png);
		expect(readAvatar(agentDir)).toBe(png);
		expect(avatarPath(agentDir)).toBe(join(agentDir, "avatar.png"));

		expect(() => writeAvatar(agentDir, "data:image/jpeg;base64,AAAA")).toThrow("PNG");
		expect(() => writeAvatar(agentDir, "data:image/png;base64,")).toThrow("为空");

		removeAvatar(agentDir);
		expect(readAvatar(agentDir)).toBeNull();
		// 幂等：已不存在时删除不报错
		removeAvatar(agentDir);
	});
});
