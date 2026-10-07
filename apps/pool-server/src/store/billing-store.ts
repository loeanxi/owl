/**
 * BillingStore 的 SQLite 实现 + 网关计费挂钩的管理端 REST。
 * 金额一律「分」（整数）；manager BigDecimal 元口径在割接导入器换算。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	type BillingService,
	type BillingStore,
	BusinessError,
	type LedgerEntry,
	type LedgerEntryType,
	type LedgerStatus,
	type ModelRate,
	type Wallet,
} from "owl-pool";
import type { Router } from "../http/router.ts";
import type { SqliteCatalogStore } from "./gateway-stores.ts";
import {
	applyRateDraft,
	deleteRateDraft,
	listRateDrafts,
	seedRateDrafts,
	updateRateDraft,
	upsertRateDraft,
} from "./rate-drafts.ts";

export class SqliteBillingStore implements BillingStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	getWallet(memberId: string): Wallet | undefined {
		const row = this.#db.prepare("SELECT * FROM billing_member_wallets WHERE member_id = ?").get(memberId);
		return row === undefined ? undefined : { memberId, balance: Number(row.balance) };
	}

	debitWallet(memberId: string, amountCents: number): number {
		this.ensureWallet(memberId);
		this.#db
			.prepare("UPDATE billing_member_wallets SET balance = balance - ?, updated_at = ? WHERE member_id = ?")
			.run(amountCents, Date.now(), memberId);
		return this.getWallet(memberId)!.balance;
	}

	creditWallet(memberId: string, amountCents: number): number {
		this.ensureWallet(memberId);
		this.#db
			.prepare("UPDATE billing_member_wallets SET balance = balance + ?, updated_at = ? WHERE member_id = ?")
			.run(amountCents, Date.now(), memberId);
		return this.getWallet(memberId)!.balance;
	}

	/** 管理员调账入口：正数充值、负数扣减。 */
	adjust(memberId: string, amountCents: number): number {
		return amountCents >= 0 ? this.creditWallet(memberId, amountCents) : this.debitWallet(memberId, -amountCents);
	}

	saveLedger(entry: LedgerEntry): void {
		this.#db
			.prepare(`
			INSERT INTO billing_ledger_entries (id, member_id, key_id, request_id, model, amount, reserved_amount,
				balance_before, balance_after, prompt_tokens, completion_tokens, entry_type, status, remark, occurred_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				amount = excluded.amount, balance_after = excluded.balance_after,
				prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
				entry_type = excluded.entry_type, status = excluded.status, remark = excluded.remark
		`)
			.run(
				entry.id,
				entry.memberId,
				entry.keyId,
				entry.requestId,
				entry.model,
				entry.amount,
				entry.reservedAmount,
				entry.balanceBefore,
				entry.balanceAfter,
				entry.promptTokens,
				entry.completionTokens,
				entry.entryType,
				entry.status,
				entry.remark,
				entry.occurredAt,
			);
	}

	getLedger(id: string): LedgerEntry | undefined {
		const row = this.#db.prepare("SELECT * FROM billing_ledger_entries WHERE id = ?").get(id);
		return row === undefined ? undefined : rowToLedger(row);
	}

	findPendingOlderThan(cutoff: number): LedgerEntry[] {
		return this.#db
			.prepare("SELECT * FROM billing_ledger_entries WHERE status = 'PENDING' AND occurred_at < ?")
			.all(cutoff)
			.map(rowToLedger);
	}

	ledgerForMember(memberId: string, limit: number): LedgerEntry[] {
		return this.#db
			.prepare("SELECT * FROM billing_ledger_entries WHERE member_id = ? ORDER BY occurred_at DESC LIMIT ?")
			.all(memberId, limit)
			.map(rowToLedger);
	}

	findRate(model: string): ModelRate | undefined {
		const row = this.#db.prepare("SELECT * FROM billing_model_rates WHERE model = ?").get(model);
		return row === undefined ? undefined : rowToRate(row);
	}

	saveRate(rate: ModelRate): void {
		this.#db
			.prepare(`
			INSERT INTO billing_model_rates (model, prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_write_per_1m, enabled)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(model) DO UPDATE SET
				prompt_per_1m = excluded.prompt_per_1m, completion_per_1m = excluded.completion_per_1m,
				cache_read_per_1m = excluded.cache_read_per_1m, cache_write_per_1m = excluded.cache_write_per_1m,
				enabled = excluded.enabled
		`)
			.run(
				rate.model,
				rate.promptPer1m,
				rate.completionPer1m,
				rate.cacheReadPer1m,
				rate.cacheWritePer1m,
				rate.enabled ? 1 : 0,
			);
	}

	listRates(): ModelRate[] {
		return this.#db.prepare("SELECT * FROM billing_model_rates ORDER BY model").all().map(rowToRate);
	}

	listWallets(): Wallet[] {
		return this.#db
			.prepare("SELECT member_id, balance FROM billing_member_wallets ORDER BY member_id")
			.all()
			.map((row) => ({ memberId: String(row.member_id), balance: Number(row.balance) }));
	}

	recentLedger(limit: number): LedgerEntry[] {
		return this.#db
			.prepare("SELECT * FROM billing_ledger_entries ORDER BY occurred_at DESC LIMIT ?")
			.all(limit)
			.map(rowToLedger);
	}

	#ensureWalletInternal(memberId: string): void {
		this.#db
			.prepare(
				"INSERT INTO billing_member_wallets (member_id, balance, updated_at) VALUES (?, 0, ?) ON CONFLICT(member_id) DO NOTHING",
			)
			.run(memberId, Date.now());
	}

	ensureWallet(memberId: string): void {
		this.#ensureWalletInternal(memberId);
	}
}

function ensureWalletExternal(store: SqliteBillingStore, memberId: string): void {
	store.ensureWallet(memberId);
}

function rowToLedger(row: Record<string, unknown>): LedgerEntry {
	return {
		id: String(row.id),
		memberId: String(row.member_id),
		keyId: row.key_id === null || row.key_id === undefined ? null : String(row.key_id),
		requestId: row.request_id === null || row.request_id === undefined ? null : String(row.request_id),
		model: String(row.model),
		amount: Number(row.amount),
		reservedAmount: Number(row.reserved_amount),
		balanceBefore: Number(row.balance_before),
		balanceAfter: Number(row.balance_after),
		promptTokens: row.prompt_tokens === null || row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
		completionTokens:
			row.completion_tokens === null || row.completion_tokens === undefined ? null : Number(row.completion_tokens),
		entryType: String(row.entry_type) as LedgerEntryType,
		status: String(row.status) as LedgerStatus,
		remark: row.remark === null || row.remark === undefined ? null : String(row.remark),
		occurredAt: Number(row.occurred_at),
	};
}

/** 库内金额是分；原版管理台按元的十进制字符串展示。 */
function centsToYuan(cents: number): string {
	const negative = cents < 0;
	const abs = Math.abs(Math.trunc(cents));
	const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
	return negative ? `-${text}` : text;
}

/** 管理端金额按元进、四舍五入到分；格式不对直接拒绝，不把脏值写成 0。 */
function parseYuanCents(value: unknown): number {
	const text = String(value ?? "").trim();
	if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) {
		throw BusinessError.of("billing.amountInvalid", "金额最多保留 6 位小数且不能超出金额范围");
	}
	const cents = signedCents(text);
	if (!Number.isSafeInteger(cents)) {
		throw BusinessError.of("billing.amountInvalid", "金额超出可入账范围");
	}
	return cents;
}

function signedCents(text: string): number {
	const negative = text.startsWith("-");
	const [whole, frac = ""] = text.replace("-", "").split(".");
	const digits = `${frac}000`.slice(0, 3);
	let cents = Number(whole) * 100 + Number(digits.slice(0, 2));
	if (digits[2] >= "5") cents += 1;
	return negative ? -cents : cents;
}

function iso(ms: unknown): string | null {
	const value = Number(ms);
	return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function withTx<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = run();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

interface MemberRow {
	id: string;
	username: string;
	display_name: string;
	enabled: number;
}

function requireMember(db: DatabaseSync, memberId: string): MemberRow {
	const member = db.prepare("SELECT id, username, display_name, enabled FROM members WHERE id = ?").get(memberId) as
		| MemberRow
		| undefined;
	if (member === undefined) {
		throw BusinessError.of("billing.memberNotFound", "成员不存在");
	}
	return member;
}

function walletAdminRow(member: MemberRow, wallet: Record<string, unknown> | undefined): Record<string, unknown> {
	const currency = wallet?.currency === null || wallet?.currency === undefined ? "CNY" : String(wallet.currency);
	return {
		memberId: member.id,
		username: member.username,
		displayName: member.display_name,
		memberEnabled: Number(member.enabled) === 1,
		walletId: wallet?.id ?? null,
		balance: wallet === undefined ? null : centsToYuan(Number(wallet.balance)),
		currency,
		migrationRequired: wallet !== undefined && currency !== "CNY",
		hasWallet: wallet !== undefined,
		updatedAt: wallet === undefined ? null : iso(wallet.updated_at),
	};
}

function ledgerAdminRow(row: Record<string, unknown>): Record<string, unknown> {
	const currency =
		row.currency === null || row.currency === undefined || row.currency === "" ? "CNY" : String(row.currency);
	return {
		id: String(row.id),
		memberId: String(row.member_id),
		keyId: row.key_id ?? null,
		budgetRootKeyId: row.budget_root_key_id ?? null,
		callLogId: row.call_log_id ?? null,
		requestId: row.request_id ?? null,
		model: row.model ?? "",
		entryType: String(row.entry_type),
		status: String(row.status),
		currency,
		historical: Number(row.historical) === 1 || currency !== "CNY",
		amount: centsToYuan(Number(row.amount ?? 0)),
		reservedAmount:
			row.reserved_amount === null || row.reserved_amount === undefined
				? null
				: centsToYuan(Number(row.reserved_amount)),
		balanceBefore: centsToYuan(Number(row.balance_before ?? 0)),
		balanceAfter: centsToYuan(Number(row.balance_after ?? 0)),
		promptTokens: row.prompt_tokens ?? null,
		completionTokens: row.completion_tokens ?? null,
		cacheReadTokens: row.cache_read_tokens ?? null,
		cacheWriteTokens: row.cache_write_tokens ?? null,
		promptPer1m:
			row.prompt_per_1m === null || row.prompt_per_1m === undefined ? null : centsToYuan(Number(row.prompt_per_1m)),
		completionPer1m:
			row.completion_per_1m === null || row.completion_per_1m === undefined
				? null
				: centsToYuan(Number(row.completion_per_1m)),
		cacheReadPer1m:
			row.cache_read_per_1m === null || row.cache_read_per_1m === undefined
				? null
				: centsToYuan(Number(row.cache_read_per_1m)),
		cacheWritePer1m:
			row.cache_write_per_1m === null || row.cache_write_per_1m === undefined
				? null
				: centsToYuan(Number(row.cache_write_per_1m)),
		remark: row.remark ?? null,
		occurredAt: iso(row.occurred_at),
	};
}

function rateAdminRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		id: row.id ?? null,
		model: String(row.model),
		promptPer1m: centsToYuan(Number(row.prompt_per_1m)),
		completionPer1m: centsToYuan(Number(row.completion_per_1m)),
		cacheReadPer1m: centsToYuan(Number(row.cache_read_per_1m)),
		cacheWritePer1m: centsToYuan(Number(row.cache_write_per_1m)),
		currency: "CNY",
		enabled: Number(row.enabled) === 1,
		remark: row.remark ?? null,
		updatedAt: iso(row.updated_at),
	};
}

function openWallet(db: DatabaseSync, memberId: string): Record<string, unknown> {
	const existing = db.prepare("SELECT * FROM billing_member_wallets WHERE member_id = ?").get(memberId) as
		| Record<string, unknown>
		| undefined;
	if (existing !== undefined) return existing;
	const now = Date.now();
	db.prepare(
		`INSERT INTO billing_member_wallets (member_id, balance, updated_at, id, currency, created_at, version)
		 VALUES (?, 0, ?, ?, 'CNY', ?, 0)`,
	).run(memberId, now, randomUUID(), now);
	return db.prepare("SELECT * FROM billing_member_wallets WHERE member_id = ?").get(memberId) as Record<
		string,
		unknown
	>;
}

function assertCnyWallet(wallet: Record<string, unknown>): void {
	const currency =
		wallet.currency === null || wallet.currency === undefined || wallet.currency === ""
			? "CNY"
			: String(wallet.currency);
	if (currency !== "CNY") {
		throw BusinessError.of("billing.walletCurrencyMismatch", "旧币种钱包尚未迁移，不能进行人民币充值或扣费");
	}
}

function creditMember(
	db: DatabaseSync,
	memberId: string,
	deltaCents: number,
	entryType: string,
	remark: unknown,
): Record<string, unknown> {
	return withTx(db, () => {
		const member = requireMember(db, memberId);
		const wallet = openWallet(db, memberId);
		assertCnyWallet(wallet);
		const before = Number(wallet.balance);
		const after = before + deltaCents;
		if (deltaCents < 0 && after < 0) {
			throw BusinessError.of(
				"billing.insufficientBalance",
				`余额不足，当前 ${centsToYuan(before)}，调账后将为 ${centsToYuan(after)}`,
			);
		}
		const now = Date.now();
		db.prepare(
			"UPDATE billing_member_wallets SET balance = ?, updated_at = ?, version = COALESCE(version, 0) + 1 WHERE member_id = ?",
		).run(after, now, memberId);
		const note =
			remark === null || remark === undefined || String(remark).trim() === "" ? null : String(remark).trim();
		const entryId = randomUUID();
		db.prepare(
			`INSERT INTO billing_ledger_entries (id, member_id, key_id, request_id, model, amount, reserved_amount,
				balance_before, balance_after, entry_type, status, remark, occurred_at, currency, historical)
			 VALUES (?, ?, NULL, NULL, '', ?, 0, ?, ?, ?, 'POSTED', ?, ?, 'CNY', 0)`,
		).run(entryId, memberId, Math.abs(deltaCents), before, after, entryType, note, now);
		const saved = db.prepare("SELECT * FROM billing_member_wallets WHERE member_id = ?").get(memberId) as Record<
			string,
			unknown
		>;
		const entry = db.prepare("SELECT * FROM billing_ledger_entries WHERE id = ?").get(entryId) as Record<
			string,
			unknown
		>;
		return { ...walletAdminRow(member, saved), ledger: ledgerAdminRow(entry) };
	});
}

function rateYuanView(rate: ModelRate): Record<string, unknown> {
	return {
		model: rate.model,
		promptPer1m: centsToYuan(rate.promptPer1m),
		completionPer1m: centsToYuan(rate.completionPer1m),
		cacheReadPer1m: centsToYuan(rate.cacheReadPer1m),
		cacheWritePer1m: centsToYuan(rate.cacheWritePer1m),
		enabled: rate.enabled,
	};
}

function rowToRate(row: Record<string, unknown>): ModelRate {
	return {
		model: String(row.model),
		promptPer1m: Number(row.prompt_per_1m),
		completionPer1m: Number(row.completion_per_1m),
		cacheReadPer1m: Number(row.cache_read_per_1m),
		cacheWritePer1m: Number(row.cache_write_per_1m),
		enabled: Number(row.enabled) === 1,
	};
}

/** 计费管理端 REST：费率 CRUD、钱包调账、账本查询。 */
export function registerBillingRoutes(
	router: Router,
	deps: { billing: BillingService; store: SqliteBillingStore; db?: DatabaseSync; catalog?: SqliteCatalogStore },
): void {
	router.get("/api/billing/status", async () => {
		const db = deps.db;
		const rateCount =
			db === undefined
				? deps.store.listRates().length
				: Number(db.prepare("SELECT COUNT(*) AS c FROM billing_model_rates").get()?.c ?? 0);
		const walletCount =
			db === undefined
				? deps.store.listWallets().length
				: Number(
						db
							.prepare(
								`SELECT COUNT(*) AS c FROM billing_member_wallets w
				 WHERE EXISTS (SELECT 1 FROM members m WHERE m.id = w.member_id)`,
							)
							.get()?.c ?? 0,
					);
		return {
			enabled: true,
			currency: "CNY",
			rateUnit: "PER_1M_TOKENS",
			defaultWalletBalance: "0",
			fallbackPromptPer1m: "0",
			fallbackCompletionPer1m: "0",
			allowNegativeBalance: false,
			rateCount,
			walletCount,
		};
	});

	router.get("/api/billing/rates", async () => {
		if (deps.db === undefined) return deps.store.listRates().map(rateYuanView);
		return (
			deps.db.prepare("SELECT * FROM billing_model_rates ORDER BY model").all() as Array<Record<string, unknown>>
		).map(rateAdminRow);
	});

	router.put("/api/billing/rates/:id", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const body = (await ctx.readBody<Record<string, unknown>>()) ?? {};
		const current = db.prepare("SELECT * FROM billing_model_rates WHERE id = ?").get(ctx.params.id ?? "") as
			| Record<string, unknown>
			| undefined;
		if (current === undefined) throw BusinessError.of("billing.rateNotFound", "单价不存在");
		const next = ratePatch(current, body, false);
		db.prepare(
			`UPDATE billing_model_rates SET prompt_per_1m = ?, completion_per_1m = ?, cache_read_per_1m = ?,
				cache_write_per_1m = ?, enabled = ?, remark = ?, updated_at = ? WHERE id = ?`,
		).run(
			next.prompt,
			next.completion,
			next.cacheRead,
			next.cacheWrite,
			next.enabled,
			next.remark,
			Date.now(),
			String(current.id),
		);
		return rateAdminRow(
			db.prepare("SELECT * FROM billing_model_rates WHERE id = ?").get(String(current.id)) as Record<
				string,
				unknown
			>,
		);
	});

	router.delete("/api/billing/rates/:id", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const deleted = db.prepare("DELETE FROM billing_model_rates WHERE id = ?").run(ctx.params.id ?? "");
		if (Number(deleted.changes) === 0) throw BusinessError.of("billing.rateNotFound", "单价不存在");
		return { deleted: true };
	});

	router.get("/api/billing/wallets", async () => {
		if (deps.db === undefined) {
			return deps.store.listWallets().map((wallet) => ({
				memberId: wallet.memberId,
				balance: centsToYuan(wallet.balance),
				hasWallet: true,
				currency: "CNY",
			}));
		}
		const rows = deps.db
			.prepare(
				`SELECT m.id, m.username, m.display_name, m.enabled,
				w.id AS wallet_id, w.balance, w.currency, w.updated_at AS wallet_updated_at
			 FROM members m
			 LEFT JOIN billing_member_wallets w ON w.member_id = m.id
			 ORDER BY m.created_at DESC`,
			)
			.all() as Array<Record<string, unknown>>;
		return rows.map((row) =>
			walletAdminRow(
				{
					id: String(row.id),
					username: String(row.username),
					display_name: String(row.display_name),
					enabled: Number(row.enabled),
				},
				row.wallet_id === null || row.wallet_id === undefined
					? undefined
					: { id: row.wallet_id, balance: row.balance, currency: row.currency, updated_at: row.wallet_updated_at },
			),
		);
	});

	router.get("/api/billing/rate-drafts", async (ctx) => {
		if (deps.db === undefined) {
			return { drafts: [], platforms: [], totalCount: 0 };
		}
		return listRateDrafts(deps.db, ctx.query.get("platform"));
	});

	router.post("/api/billing/rate-drafts/seed-from-catalog", async () => {
		if (deps.db === undefined || deps.catalog === undefined) {
			throw BusinessError.of("billing.draft.catalogUnavailable", "模型目录未启用，不能从目录生成单价草稿");
		}
		return seedRateDrafts(deps.db, deps.catalog);
	});

	router.post("/api/billing/rate-drafts", async (ctx) => {
		if (deps.db === undefined) {
			throw BusinessError.of("billing.draft.unavailable", "单价草稿存储未启用");
		}
		return upsertRateDraft(deps.db, (await ctx.readBody<Record<string, unknown>>()) ?? {});
	});

	router.put("/api/billing/rate-drafts/:id", async (ctx) => {
		if (deps.db === undefined) {
			throw BusinessError.of("billing.draft.unavailable", "单价草稿存储未启用");
		}
		return updateRateDraft(deps.db, ctx.params.id ?? "", (await ctx.readBody<Record<string, unknown>>()) ?? {});
	});

	router.post("/api/billing/rate-drafts/:id/apply", async (ctx) => {
		if (deps.db === undefined) {
			throw BusinessError.of("billing.draft.unavailable", "单价草稿存储未启用");
		}
		return applyRateDraft(deps.db, deps.store, ctx.params.id ?? "");
	});

	router.delete("/api/billing/rate-drafts/:id", async (ctx) => {
		if (deps.db === undefined) {
			throw BusinessError.of("billing.draft.unavailable", "单价草稿存储未启用");
		}
		deleteRateDraft(deps.db, ctx.params.id ?? "");
		return { deleted: true };
	});

	router.post("/api/billing/rates", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const body = (await ctx.readBody<Record<string, unknown>>()) ?? {};
		const model = String(body.model ?? "")
			.trim()
			.toLowerCase();
		if (model.length === 0) throw BusinessError.of("billing.modelNameRequired", "模型名不能为空");
		const current = db.prepare("SELECT * FROM billing_model_rates WHERE model = ?").get(model) as
			| Record<string, unknown>
			| undefined;
		const next = ratePatch(
			current ?? { enabled: 1, prompt_per_1m: 0, completion_per_1m: 0, cache_read_per_1m: 0, cache_write_per_1m: 0 },
			body,
			current === undefined,
		);
		const now = Date.now();
		if (current === undefined) {
			const id = randomUUID();
			db.prepare(
				`INSERT INTO billing_model_rates (model, prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_write_per_1m,
					enabled, id, remark, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				model,
				next.prompt,
				next.completion,
				next.cacheRead,
				next.cacheWrite,
				next.enabled,
				id,
				next.remark,
				now,
				now,
			);
		} else {
			db.prepare(
				`UPDATE billing_model_rates SET prompt_per_1m = ?, completion_per_1m = ?, cache_read_per_1m = ?,
					cache_write_per_1m = ?, enabled = ?, remark = ?, updated_at = ? WHERE model = ?`,
			).run(next.prompt, next.completion, next.cacheRead, next.cacheWrite, next.enabled, next.remark, now, model);
		}
		return rateAdminRow(
			db.prepare("SELECT * FROM billing_model_rates WHERE model = ?").get(model) as Record<string, unknown>,
		);
	});

	router.get("/api/billing/ledger", async (ctx) => {
		const memberId = ctx.query.get("memberId");
		const limit = Number.parseInt(ctx.query.get("limit") ?? "80", 10);
		const size = Number.isNaN(limit) ? 80 : Math.max(1, Math.min(limit, 200));
		if (deps.db === undefined) {
			const rows = memberId !== null ? deps.store.ledgerForMember(memberId, size) : deps.store.recentLedger(size);
			return rows.map((entry) => ({ ...entry, amount: centsToYuan(entry.amount), currency: "CNY" }));
		}
		const rows = (
			memberId === null
				? deps.db.prepare("SELECT * FROM billing_ledger_entries ORDER BY occurred_at DESC LIMIT ?").all(size)
				: deps.db
						.prepare("SELECT * FROM billing_ledger_entries WHERE member_id = ? ORDER BY occurred_at DESC LIMIT ?")
						.all(memberId, size)
		) as Array<Record<string, unknown>>;
		return rows.map(ledgerAdminRow);
	});

	router.post("/api/billing/ledger/:id/resolve", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const body = (await ctx.readBody<Record<string, unknown>>()) ?? {};
		const action = String(body.action ?? "").toUpperCase();
		return withTx(db, () => {
			const entry = db.prepare("SELECT * FROM billing_ledger_entries WHERE id = ?").get(ctx.params.id ?? "") as
				| Record<string, unknown>
				| undefined;
			if (entry === undefined) throw BusinessError.of("billing.ledgerNotFound", "计费流水不存在");
			if (String(entry.entry_type) !== "USAGE_CHARGE" || String(entry.status) !== "REVIEW") {
				throw BusinessError.of("billing.notReviewable", "只有待核对的调用流水可人工处理");
			}
			const currency =
				entry.currency === null || entry.currency === undefined || entry.currency === ""
					? "CNY"
					: String(entry.currency);
			if (currency !== "CNY" || Number(entry.historical) === 1) {
				throw BusinessError.of("billing.ledgerCurrencyMismatch", "历史流水不能参与人民币钱包结算");
			}
			const wallet = db
				.prepare("SELECT * FROM billing_member_wallets WHERE member_id = ?")
				.get(String(entry.member_id)) as Record<string, unknown> | undefined;
			if (wallet === undefined) throw BusinessError.of("billing.walletMissing", "成员钱包不存在");
			assertCnyWallet(wallet);
			const balance = Number(wallet.balance);
			const reserved = Number(entry.reserved_amount ?? 0);
			const now = Date.now();
			if (action === "REFUND") {
				const after = balance + reserved;
				db.prepare("UPDATE billing_member_wallets SET balance = ?, updated_at = ? WHERE member_id = ?").run(
					after,
					now,
					String(entry.member_id),
				);
				db.prepare(
					"UPDATE billing_ledger_entries SET amount = 0, balance_after = ?, status = 'VOIDED' WHERE id = ?",
				).run(after, String(entry.id));
			} else if (action === "CHARGE") {
				const charge = parseYuanCents(body.amount);
				if (charge < 0) throw BusinessError.of("billing.amountInvalid", "金额不能为负");
				const beforeCharge = balance + reserved;
				const after = beforeCharge - charge;
				db.prepare("UPDATE billing_member_wallets SET balance = ?, updated_at = ? WHERE member_id = ?").run(
					after,
					now,
					String(entry.member_id),
				);
				db.prepare(
					`UPDATE billing_ledger_entries SET balance_before = ?, amount = ?, balance_after = ?, status = 'POSTED',
						remark = ? WHERE id = ?`,
				).run(beforeCharge, charge, after, "未知用量，由管理员人工确认金额", String(entry.id));
			} else {
				throw BusinessError.of("billing.resolveActionInvalid", "处理方式必须是 CHARGE 或 REFUND");
			}
			return ledgerAdminRow(
				db.prepare("SELECT * FROM billing_ledger_entries WHERE id = ?").get(String(entry.id)) as Record<
					string,
					unknown
				>,
			);
		});
	});

	router.post("/api/billing/wallets/:memberId/ensure", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const memberId = ctx.params.memberId ?? "";
		return withTx(db, () => walletAdminRow(requireMember(db, memberId), openWallet(db, memberId)));
	});

	router.post("/api/billing/wallets/:memberId/top-up", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const body = (await ctx.readBody<Record<string, unknown>>()) ?? {};
		const amount = parseYuanCents(body.amount);
		if (amount <= 0) throw BusinessError.of("billing.topUpAmountInvalid", "充值金额必须大于 0");
		return creditMember(db, ctx.params.memberId ?? "", amount, "TOP_UP", body.remark);
	});

	router.post("/api/billing/wallets/:memberId/adjust", async (ctx) => {
		const db = requireBillingDb(deps.db);
		const body = (await ctx.readBody<Record<string, unknown>>()) ?? {};
		const amount = parseYuanCents(body.amount);
		if (amount === 0) throw BusinessError.of("billing.adjustAmountZero", "调账金额不能为 0");
		return creditMember(db, ctx.params.memberId ?? "", amount, "ADJUSTMENT", body.remark);
	});

	router.get("/api/billing/wallets/:memberId", async (ctx) => {
		const memberId = ctx.params.memberId ?? "";
		if (deps.db === undefined) {
			const wallet = deps.store.getWallet(memberId);
			return {
				memberId,
				hasWallet: wallet !== undefined,
				balance: wallet === undefined ? null : centsToYuan(wallet.balance),
				currency: "CNY",
			};
		}
		const wallet = deps.db.prepare("SELECT * FROM billing_member_wallets WHERE member_id = ?").get(memberId) as
			| Record<string, unknown>
			| undefined;
		const currency = wallet?.currency === null || wallet?.currency === undefined ? "CNY" : String(wallet.currency);
		return {
			memberId,
			hasWallet: wallet !== undefined,
			balance: wallet === undefined ? null : centsToYuan(Number(wallet.balance)),
			currency,
			migrationRequired: wallet !== undefined && currency !== "CNY",
			billingEnabled: true,
		};
	});

	void randomUUID;
}

function requireBillingDb(db: DatabaseSync | undefined): DatabaseSync {
	if (db === undefined) throw BusinessError.of("billing.unavailable", "计费存储未启用");
	return db;
}

function optionalYuan(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const cents = parseYuanCents(value);
	if (cents < 0)
		throw BusinessError.of("billing.rateInvalid", "模型单价不能为负，最多保留 6 位小数且不能超出金额范围");
	return cents;
}

function ratePatch(
	current: Record<string, unknown>,
	body: Record<string, unknown>,
	creating: boolean,
): {
	prompt: number;
	completion: number;
	cacheRead: number;
	cacheWrite: number;
	enabled: number;
	remark: string | null;
} {
	const prompt = body.promptPer1m === undefined ? Number(current.prompt_per_1m) : optionalYuan(body.promptPer1m);
	const completion =
		body.completionPer1m === undefined ? Number(current.completion_per_1m) : optionalYuan(body.completionPer1m);
	if (prompt === undefined || completion === undefined) {
		throw BusinessError.of("billing.rateInvalid", "模型单价不能为空");
	}
	let cacheRead = Number(current.cache_read_per_1m ?? 0);
	let cacheWrite = Number(current.cache_write_per_1m ?? 0);
	if (body.clearCacheReadPrice === true) {
		if (body.cacheReadPer1m !== null && body.cacheReadPer1m !== undefined && body.cacheReadPer1m !== "") {
			throw BusinessError.of("billing.cacheRateInvalid", "缓存读取单价不能同时设置和清空");
		}
		cacheRead = 0;
	} else if (body.cacheReadPer1m !== undefined && body.cacheReadPer1m !== null) {
		cacheRead = optionalYuan(body.cacheReadPer1m) ?? 0;
	}
	if (body.clearCacheWritePrice === true) {
		if (body.cacheWritePer1m !== null && body.cacheWritePer1m !== undefined && body.cacheWritePer1m !== "") {
			throw BusinessError.of("billing.cacheRateInvalid", "缓存写入单价不能同时设置和清空");
		}
		cacheWrite = 0;
	} else if (body.cacheWritePer1m !== undefined && body.cacheWritePer1m !== null) {
		cacheWrite = optionalYuan(body.cacheWritePer1m) ?? 0;
	}
	const enabled =
		body.enabled === undefined
			? creating
				? 1
				: Number(current.enabled) === 1
					? 1
					: 0
			: body.enabled === true
				? 1
				: 0;
	const remark =
		body.remark === undefined
			? current.remark === null || current.remark === undefined
				? null
				: String(current.remark)
			: body.remark === null || String(body.remark).trim() === ""
				? null
				: String(body.remark).trim();
	return { prompt, completion, cacheRead, cacheWrite, enabled, remark };
}

// ensureWallet 外部便捷入口（保持私有方法封闭）
export function ensureBillingWallet(store: SqliteBillingStore, memberId: string): void {
	ensureWalletExternal(store, memberId);
}
