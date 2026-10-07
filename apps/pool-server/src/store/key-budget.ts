/**
 * Key 人民币预算 —— 移植自 manager `KeyBudgetService` 的读写与预占校验。
 * 限额以元的十进制字符串保存（空表示不限）；用量从账本按分汇总后再换回元。
 */
import type { DatabaseSync } from "node:sqlite";
import { type ApiKey, BusinessError, GatewayFault } from "owl-pool";

export interface BudgetAmounts {
	total: string | null;
	daily: string | null;
	weekly: string | null;
}

interface BudgetRow {
	adminTotal: string | null;
	adminDaily: string | null;
	adminWeekly: string | null;
	memberTotal: string | null;
	memberDaily: string | null;
	memberWeekly: string | null;
	updatedAt: number | null;
}

const EMPTY: BudgetRow = {
	adminTotal: null,
	adminDaily: null,
	adminWeekly: null,
	memberTotal: null,
	memberDaily: null,
	memberWeekly: null,
	updatedAt: null,
};

export function memberBudgetView(
	db: DatabaseSync,
	memberId: string,
	key: ApiKey,
	root: ApiKey,
	hasWallet: boolean,
): Record<string, unknown> {
	if (!hasWallet) {
		throw BusinessError.of("billing.walletMissing", "成员钱包尚未开户，请先由管理员开通人民币钱包");
	}
	return viewOf(db, memberId, key, root, true);
}

export function adminBudgetView(db: DatabaseSync, key: ApiKey, root: ApiKey): Record<string, unknown> {
	return viewOf(db, key.ownerMemberId ?? "", key, root, false);
}

export function saveAdminBudget(
	db: DatabaseSync,
	key: ApiKey,
	root: ApiKey,
	limits: BudgetAmounts,
): Record<string, unknown> {
	validateAmounts(limits);
	const current = load(db, key.id);
	db.prepare(`
		INSERT INTO key_budgets (key_id, admin_total, admin_daily, admin_weekly, member_total, member_daily, member_weekly, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key_id) DO UPDATE SET
			admin_total = excluded.admin_total, admin_daily = excluded.admin_daily,
			admin_weekly = excluded.admin_weekly, updated_at = excluded.updated_at
	`).run(
		key.id,
		limits.total,
		limits.daily,
		limits.weekly,
		current.memberTotal,
		current.memberDaily,
		current.memberWeekly,
		Date.now(),
	);
	return adminBudgetView(db, key, root);
}

export function saveMemberBudget(
	db: DatabaseSync,
	memberId: string,
	key: ApiKey,
	root: ApiKey,
	hasWallet: boolean,
	limits: BudgetAmounts,
): Record<string, unknown> {
	if (key.parentKeyId === null) {
		throw new GatewayFault(403, "key_budget_root_read_only", "根 Key 预算由管理员设置，成员只能查看");
	}
	if (!hasWallet) {
		throw BusinessError.of("billing.walletMissing", "成员钱包尚未开户，请先由管理员开通人民币钱包");
	}
	validateAmounts(limits);
	const current = load(db, key.id);
	db.prepare(`
		INSERT INTO key_budgets (key_id, admin_total, admin_daily, admin_weekly, member_total, member_daily, member_weekly, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key_id) DO UPDATE SET
			member_total = excluded.member_total, member_daily = excluded.member_daily,
			member_weekly = excluded.member_weekly, updated_at = excluded.updated_at
	`).run(
		key.id,
		current.adminTotal,
		current.adminDaily,
		current.adminWeekly,
		limits.total,
		limits.daily,
		limits.weekly,
		Date.now(),
	);
	return viewOf(db, memberId, key, root, true);
}

/** 预占前校验。没有有限限额时直接放过。超出抛 402。 */
export function assertKeyBudgetAllows(db: DatabaseSync, key: ApiKey, addCents: number): void {
	if (key.ownerMemberId === null) {
		return;
	}
	const root = rootOf(db, key);
	const now = Date.now();
	enforce(db, key.ownerMemberId, key, key.parentKeyId === null, addCents, now);
	if (root.id !== key.id) {
		enforce(db, key.ownerMemberId, root, true, addCents, now);
	}
}

function viewOf(
	db: DatabaseSync,
	memberId: string,
	key: ApiKey,
	root: ApiKey,
	member: boolean,
): Record<string, unknown> {
	const policy = load(db, key.id);
	const limits = effective(policy);
	const windows = shanghaiWindows(Date.now());
	const spent = usage(db, memberId, key.id, key.parentKeyId === null, windows);
	const left = remaining(limits, spent);
	let available = left;
	let rootBudget: Record<string, unknown> | null = null;
	if (root.id !== key.id) {
		const rootPolicy = effective(load(db, root.id));
		const rootSpent = usage(db, memberId, root.id, true, windows);
		const rootLeft = remaining(rootPolicy, rootSpent);
		rootBudget = {
			keyId: root.id,
			limits: rootPolicy,
			usage: rootSpent,
			remaining: rootLeft,
		};
		available = minAmounts(left, rootLeft);
	}
	return {
		keyId: key.id,
		parentKeyId: key.parentKeyId,
		rootKeyId: root.id,
		currency: "CNY",
		scope: key.parentKeyId === null ? "ROOT_POOL" : "KEY",
		editable: !member || key.parentKeyId !== null,
		adminLimits: { total: policy.adminTotal, daily: policy.adminDaily, weekly: policy.adminWeekly },
		memberLimits: { total: policy.memberTotal, daily: policy.memberDaily, weekly: policy.memberWeekly },
		effectiveLimits: limits,
		usage: spent,
		remaining: left,
		available,
		rootBudget,
		zoneId: "Asia/Shanghai",
		dailyResetAt: new Date(windows.dayEnd).toISOString(),
		weeklyResetAt: new Date(windows.weekEnd).toISOString(),
		updatedAt: policy.updatedAt === null ? null : new Date(policy.updatedAt).toISOString(),
	};
}

function enforce(
	db: DatabaseSync,
	memberId: string,
	key: ApiKey,
	children: boolean,
	addCents: number,
	now: number,
): void {
	const limits = effective(load(db, key.id));
	if (limits.total === null && limits.daily === null && limits.weekly === null) {
		return;
	}
	const spent = usage(db, memberId, key.id, children, shanghaiWindows(now));
	if (
		exceeds(limits.total, spent.total, addCents) ||
		exceeds(limits.daily, spent.daily, addCents) ||
		exceeds(limits.weekly, spent.weekly, addCents)
	) {
		throw new GatewayFault(402, "key_budget_exceeded", "此 Key 的人民币预算不足以完成本次预占");
	}
}

function exceeds(limit: string | null, used: string | null, addCents: number): boolean {
	if (limit === null) {
		return false;
	}
	return yuanToCents(used ?? "0") + addCents > yuanToCents(limit);
}

function load(db: DatabaseSync, keyId: string): BudgetRow {
	const row = db.prepare("SELECT * FROM key_budgets WHERE key_id = ?").get(keyId) as
		| Record<string, unknown>
		| undefined;
	if (row === undefined) {
		return EMPTY;
	}
	return {
		adminTotal: textOrNull(row.admin_total),
		adminDaily: textOrNull(row.admin_daily),
		adminWeekly: textOrNull(row.admin_weekly),
		memberTotal: textOrNull(row.member_total),
		memberDaily: textOrNull(row.member_daily),
		memberWeekly: textOrNull(row.member_weekly),
		updatedAt: Number(row.updated_at),
	};
}

function rootOf(db: DatabaseSync, key: ApiKey): ApiKey {
	if (key.parentKeyId === null) {
		return key;
	}
	const row = db
		.prepare("SELECT id, parent_key_id, owner_member_id FROM api_keys WHERE id = ?")
		.get(key.parentKeyId) as Record<string, unknown> | undefined;
	if (row === undefined || row.parent_key_id !== null || String(row.owner_member_id ?? "") !== key.ownerMemberId) {
		throw new GatewayFault(401, "invalid_api_key", "API Key 或其根 Key 已停用、过期或变更");
	}
	return { ...key, id: String(row.id), parentKeyId: null };
}

function usage(
	db: DatabaseSync,
	memberId: string,
	keyId: string,
	children: boolean,
	windows: { dayStart: number; dayEnd: number; weekStart: number; weekEnd: number },
): BudgetAmounts {
	const childClause = children ? "OR key_id IN (SELECT id FROM api_keys WHERE parent_key_id = ?)" : "";
	const params = children ? [memberId, keyId, keyId] : [memberId, keyId];
	const total = sum(db, `${baseWhere(childClause)} AND status = 'POSTED'`, params);
	const daily = sum(
		db,
		`${baseWhere(childClause)} AND status IN ('PENDING','REVIEW','POSTED') AND occurred_at >= ? AND occurred_at < ?`,
		[...params, windows.dayStart, windows.dayEnd],
	);
	const weekly = sum(
		db,
		`${baseWhere(childClause)} AND status IN ('PENDING','REVIEW','POSTED') AND occurred_at >= ? AND occurred_at < ?`,
		[...params, windows.weekStart, windows.weekEnd],
	);
	return { total: centsToYuan(total), daily: centsToYuan(daily), weekly: centsToYuan(weekly) };
}

function baseWhere(childClause: string): string {
	return `member_id = ? AND entry_type = 'USAGE_CHARGE' AND amount < 0 AND (key_id = ? ${childClause})`;
}

function sum(db: DatabaseSync, where: string, params: Array<string | number>): number {
	const row = db
		.prepare(`SELECT COALESCE(SUM(-amount), 0) AS spent FROM billing_ledger_entries WHERE ${where}`)
		.get(...params) as { spent: number } | undefined;
	return Number(row?.spent ?? 0);
}

function effective(row: BudgetRow): BudgetAmounts {
	return {
		total: minText(row.adminTotal, row.memberTotal),
		daily: minText(row.adminDaily, row.memberDaily),
		weekly: minText(row.adminWeekly, row.memberWeekly),
	};
}

function remaining(limit: BudgetAmounts, used: BudgetAmounts): BudgetAmounts {
	return {
		total: left(limit.total, used.total),
		daily: left(limit.daily, used.daily),
		weekly: left(limit.weekly, used.weekly),
	};
}

function left(limit: string | null, used: string | null): string | null {
	if (limit === null) {
		return null;
	}
	return centsToYuan(Math.max(0, yuanToCents(limit) - yuanToCents(used ?? "0")));
}

function minAmounts(first: BudgetAmounts, second: BudgetAmounts): BudgetAmounts {
	return {
		total: minText(first.total, second.total),
		daily: minText(first.daily, second.daily),
		weekly: minText(first.weekly, second.weekly),
	};
}

function minText(first: string | null, second: string | null): string | null {
	if (first === null) {
		return second;
	}
	if (second === null) {
		return first;
	}
	return yuanToCents(first) <= yuanToCents(second) ? first : second;
}

function validateAmounts(limits: BudgetAmounts): void {
	for (const value of [limits.total, limits.daily, limits.weekly]) {
		if (value !== null && !/^\d+(?:\.\d{1,6})?$/.test(value)) {
			throw BusinessError.of("billing.budgetInvalid", "预算不能为负，最多保留 6 位小数且不能超出金额范围");
		}
	}
}

function shanghaiWindows(now: number): { dayStart: number; dayEnd: number; weekStart: number; weekEnd: number } {
	const day = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(now));
	const dayStart = Date.parse(`${day}T00:00:00+08:00`);
	const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(
		new Date(now),
	);
	const offset = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 }[weekday] ?? 0;
	const weekStart = dayStart - offset * 86_400_000;
	return { dayStart, dayEnd: dayStart + 86_400_000, weekStart, weekEnd: weekStart + 7 * 86_400_000 };
}

function centsToYuan(cents: number): string {
	const abs = Math.abs(Math.trunc(cents));
	const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
	return cents < 0 ? `-${text}` : text;
}

function yuanToCents(value: string): number {
	const [whole, frac = ""] = value.split(".");
	return Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
}

function textOrNull(value: unknown): string | null {
	return value === null || value === undefined || value === "" ? null : String(value);
}
