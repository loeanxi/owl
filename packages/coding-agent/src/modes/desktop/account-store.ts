/**
 * owl 桌面端应用用户账号注册表（区别于 cursor-accounts 的模型厂商账号）。
 *
 * - 注册表唯一落在 ~/.owl/accounts.json（全局文件，不随账号切换而移动）。
 * - 一个账号 = 一个 agentDir：本地默认账号的 dataDir 就是桥进程启动时的
 *   OWL_CODING_AGENT_DIR（现有数据原地认领，零迁移）；新建账号用
 *   ~/.owl/users/<id>/agent。
 * - 切换账号只写 currentId；数据空间在壳（Tauri）重启桥进程（带新
 *   OWL_CODING_AGENT_DIR）时才生效——进程级切换保证 SessionManager /
 *   settings 缓存等运行时状态不串数据。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";

export interface DesktopAccount {
	id: string;
	name: string;
	/** 该账号的 agent 数据目录（会话 / 设置 / 模型凭据都在这下面）。 */
	dataDir: string;
	/** `scrypt$<salt hex>$<hash hex>`；null = 免密账号（点击即切）。 */
	passwordHash: string | null;
	createdAt: number;
}

/** 对外（协议/前端）暴露的账号形态：不含密码哈希，只暴露是否设了密码。 */
export type DesktopAccountPublic = Omit<DesktopAccount, "passwordHash"> & { hasPassword: boolean };

interface AccountRegistry {
	version: 1;
	currentId: string;
	accounts: DesktopAccount[];
}

/** 本地默认账号 id：dataDir 指向升级前的既有数据目录，保证现有数据无感保留。 */
export const LOCAL_ACCOUNT_ID = "local";

export function getAccountsPath(): string {
	return join(homedir(), CONFIG_DIR_NAME, "accounts.json");
}

// ---------- 头像（每账号一个 avatar.png，存当前账号 agentDir） ----------

/** 自定义头像文件路径：<agentDir>/avatar.png（跟随账号数据空间隔离）。 */
export function avatarPath(agentDir: string): string {
	return join(agentDir, "avatar.png");
}

/** 读当前账号头像（PNG data URL）；无头像返回 null。 */
export function readAvatar(agentDir: string): string | null {
	const path = avatarPath(agentDir);
	if (!existsSync(path)) return null;
	try {
		return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
	} catch {
		return null;
	}
}

/** 写头像：入参为 PNG data URL；校验前缀与尺寸上限，原子落盘。 */
export function writeAvatar(agentDir: string, dataUrl: string): void {
	const prefix = "data:image/png;base64,";
	if (!dataUrl.startsWith(prefix)) throw new Error("头像必须是 PNG data URL");
	const base64 = dataUrl.slice(prefix.length);
	// 256px PNG 正常远小于 1MB；超过基本是误传原图
	if (base64.length > 1_400_000) throw new Error("头像文件过大（请用 1MB 以内的图片）");
	const bytes = Buffer.from(base64, "base64");
	if (bytes.length === 0) throw new Error("头像数据为空");
	atomicWriteFileSync(avatarPath(agentDir), bytes);
}

/** 删除自定义头像（回落首字母）。 */
export function removeAvatar(agentDir: string): void {
	rmSync(avatarPath(agentDir), { force: true });
}

/** 新账号的数据目录：~/.owl/users/<id>/agent。 */
export function accountDataDirFor(accountId: string): string {
	return join(homedir(), CONFIG_DIR_NAME, "users", accountId, "agent");
}

function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 32);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
	const [scheme, saltHex, hashHex] = stored.split("$");
	if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
	const expected = Buffer.from(hashHex, "hex");
	const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
	return timingSafeEqual(expected, actual);
}

export function verifyAccountPassword(password: string | undefined, stored: string | null): boolean {
	if (stored === null) return true;
	if (!password) return false;
	return verifyPasswordHash(password, stored);
}

/** Windows 路径比较忽略大小写与斜杠方向；其它平台原样比较。 */
function normalizeDir(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 正在运行的桥进程实际使用的数据目录（Rust 壳 spawn 时经 env 注入）。 */
function runningAgentDir(): string {
	return resolve(process.env.OWL_CODING_AGENT_DIR || getAgentDir());
}

function localAccount(): DesktopAccount {
	return {
		id: LOCAL_ACCOUNT_ID,
		name: "本地",
		dataDir: resolve(getAgentDir()),
		passwordHash: null,
		createdAt: Date.now(),
	};
}

/** 读注册表；缺失时 seed「本地」账号（指向既有数据目录），损坏时备份后重建。 */
function loadRegistry(): AccountRegistry {
	const path = getAccountsPath();
	if (!existsSync(path)) {
		return { version: 1, currentId: LOCAL_ACCOUNT_ID, accounts: [localAccount()] };
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as AccountRegistry;
		if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) throw new Error("empty registry");
		return raw;
	} catch (error) {
		eprintlnBackup(path, error);
		return { version: 1, currentId: LOCAL_ACCOUNT_ID, accounts: [localAccount()] };
	}
}

function eprintlnBackup(path: string, error: unknown): void {
	const backup = backupCorruptFile(path);
	console.error(`[owl] accounts.json 损坏（${String(error)}），已备份为 ${backup ?? "(备份失败)"}，重建账号注册表`);
}

function persistRegistry(registry: AccountRegistry): void {
	atomicWriteFileSync(getAccountsPath(), `${JSON.stringify(registry, null, "\t")}\n`);
}

function mutateRegistry<T>(mutate: (registry: AccountRegistry) => T): T {
	return withFileLockSync(getAccountsPath(), () => {
		const registry = loadRegistry();
		const value = mutate(registry);
		persistRegistry(registry);
		return value;
	});
}

/** 账号列表（不含密码哈希）。 */
export function listDesktopAccounts(): DesktopAccountPublic[] {
	return loadRegistry().accounts.map(stripPasswordHash);
}

export interface DesktopAccountStatus {
	account: DesktopAccountPublic | null;
	/** 注册表里记录的「下次启动」账号。正常情况下与 runningAccount 一致。 */
	nextId: string;
	/** 正在运行的桥进程实际使用的账号（按 OWL_CODING_AGENT_DIR 匹配）。 */
	runningId: string | null;
}

function stripPasswordHash(account: DesktopAccount): DesktopAccountPublic {
	const { passwordHash, ...publicAccount } = account;
	return { ...publicAccount, hasPassword: passwordHash !== null };
}

/** 当前账号状态：runningId 给「现在是谁」，nextId 给「重启后是谁」。 */
export function desktopAccountStatus(): DesktopAccountStatus {
	const registry = loadRegistry();
	const runningDir = normalizeDir(runningAgentDir());
	const running = registry.accounts.find((account) => normalizeDir(account.dataDir) === runningDir);
	const next = registry.accounts.find((account) => account.id === registry.currentId);
	return {
		account: running ? stripPasswordHash(running) : null,
		nextId: next?.id ?? registry.currentId,
		runningId: running?.id ?? null,
	};
}

export function createDesktopAccount(name: string, password?: string): DesktopAccountPublic {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("账号名不能为空");
	if (trimmed.length > 40) throw new Error("账号名过长（最多 40 字符）");
	if (password !== undefined && password !== "" && password.length < 4) {
		throw new Error("密码至少 4 位");
	}
	return mutateRegistry((registry) => {
		if (registry.accounts.some((account) => account.name === trimmed)) {
			throw new Error(`已存在同名账号「${trimmed}」`);
		}
		const id = `acc-${randomBytes(4).toString("hex")}`;
		const dataDir = accountDataDirFor(id);
		mkdirSync(dataDir, { recursive: true });
		const account: DesktopAccount = {
			id,
			name: trimmed,
			dataDir,
			passwordHash: password ? hashPassword(password) : null,
			createdAt: Date.now(),
		};
		registry.accounts.push(account);
		return stripPasswordHash(account);
	});
}

/** 切换账号：校验密码后更新 currentId。数据空间等壳重启桥进程后生效。 */
export function switchDesktopAccount(accountId: string, password?: string): DesktopAccountPublic {
	return mutateRegistry((registry) => {
		const account = registry.accounts.find((entry) => entry.id === accountId);
		if (!account) throw new Error("账号不存在");
		if (!verifyAccountPassword(password, account.passwordHash)) throw new Error("密码错误");
		registry.currentId = accountId;
		return stripPasswordHash(account);
	});
}
