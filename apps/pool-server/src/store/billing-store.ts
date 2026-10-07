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
	deps: { billing: BillingService; store: SqliteBillingStore },
): void {
	router.get("/api/billing/rates", async () => deps.store.listRates());

	router.post("/api/billing/rates", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const rate: ModelRate = {
			model: String(body.model ?? "").trim(),
			promptPer1m: Number(body.promptPer1m ?? 0),
			completionPer1m: Number(body.completionPer1m ?? 0),
			cacheReadPer1m: Number(body.cacheReadPer1m ?? 0),
			cacheWritePer1m: Number(body.cacheWritePer1m ?? 0),
			enabled: body.enabled === undefined ? true : body.enabled === true,
		};
		if (rate.model.length === 0) {
			throw BusinessError.of("billing.modelRequired", "模型名不能为空");
		}
		deps.store.saveRate(rate);
		return rate;
	});

	router.get("/api/billing/ledger", async (ctx) => {
		const memberId = ctx.query.get("memberId");
		const limit = Number.parseInt(ctx.query.get("limit") ?? "50", 10);
		if (memberId !== null) {
			return deps.store.ledgerForMember(memberId, Number.isNaN(limit) ? 50 : limit);
		}
		return deps.store.ledgerForMember("*", Number.isNaN(limit) ? 50 : limit);
	});

	router.post("/api/billing/wallets/:memberId/adjust", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const amount = Number(body.amount);
		if (!Number.isInteger(amount)) {
			throw BusinessError.of("billing.badAmount", "调账金额必须是整数（分）");
		}
		const balance = deps.store.adjust(ctx.params.memberId!, amount);
		return { memberId: ctx.params.memberId, balance };
	});

	router.get("/api/billing/wallets/:memberId", async (ctx) => {
		const wallet = deps.store.getWallet(ctx.params.memberId!);
		return { memberId: ctx.params.memberId, balance: wallet?.balance ?? 0 };
	});

	void randomUUID;
}

// ensureWallet 外部便捷入口（保持私有方法封闭）
export function ensureBillingWallet(store: SqliteBillingStore, memberId: string): void {
	ensureWalletExternal(store, memberId);
}
