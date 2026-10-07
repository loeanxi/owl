/**
 * 人民币计费域核心 —— 移植自 manager `billing/BillingService`（预占/结算）与
 * `billing/ModelRate`（费率）。金额一律用「分」（整数）运算，杜绝浮点误差；
 * 与 manager BigDecimal 口径的换算在割接导入器完成（元×100）。
 *
 * 计费口径（对齐 Java）：
 * - 只有归属成员的 Key（ownerMemberId != null）参与扣费，管理员自用不扣。
 * - 预占：按 TokenEstimator 估算；输入价取 max(输入, 缓存读, 缓存写)Per1m
 *   （实际输入可能命中更贵的缓存写价）；余额不足拒绝（网关 402）。
 * - 结算：KNOWN 用量按真实 prompt/completion 分级计价并退还预占差额；
 *   UNKNOWN/无效用量 → 流水置 REVIEW 待人工；失败无产出 → 全额退还。
 * - 兜底清扫：PENDING 超时无调用记录 → 退款。
 */
import { BusinessError } from "../common/error.ts";
import { DEFAULT_OUTPUT, estimateMaxOutputTokens, estimatePromptTokens } from "../gateway/token-estimator.ts";

/** 单价单位：分 / 1M token。 */
export interface ModelRate {
	model: string;
	promptPer1m: number;
	completionPer1m: number;
	cacheReadPer1m: number;
	cacheWritePer1m: number;
	enabled: boolean;
}

export interface Wallet {
	memberId: string;
	/** 余额（分）。 */
	balance: number;
}

export type LedgerEntryType = "USAGE_CHARGE" | "ADJUSTMENT";
export type LedgerStatus = "PENDING" | "POSTED" | "REVIEW" | "VOIDED";

export interface LedgerEntry {
	id: string;
	memberId: string;
	keyId: string | null;
	requestId: string | null;
	model: string;
	/** 本条金额（分；负数为扣费）。 */
	amount: number;
	/** 预占金额（分）。 */
	reservedAmount: number;
	balanceBefore: number;
	balanceAfter: number;
	promptTokens: number | null;
	completionTokens: number | null;
	entryType: LedgerEntryType;
	status: LedgerStatus;
	remark: string | null;
	occurredAt: number;
}

export interface BillingStore {
	getWallet(memberId: string): Wallet | undefined;
	/** 行锁语义：SQLite 单写线程 + 同步事务等价。扣减余额并返回扣后余额。 */
	debitWallet(memberId: string, amountCents: number): number;
	creditWallet(memberId: string, amountCents: number): number;
	saveLedger(entry: LedgerEntry): void;
	getLedger(id: string): LedgerEntry | undefined;
	findPendingOlderThan(cutoff: number): LedgerEntry[];
	findRate(model: string): ModelRate | undefined;
	saveRate(rate: ModelRate): void;
	listRates(): ModelRate[];
}

export interface BillingServiceOptions {
	store: BillingStore;
	nowMs?(): number;
	newId?(): string;
	/** PENDING 超时退款阈值毫秒（manager: stale-pending-minutes=15）。 */
	stalePendingMs?: number;
}

export class BillingService {
	readonly #store: BillingStore;
	readonly #nowMs: () => number;
	readonly #newId: () => string;
	readonly #stalePendingMs: number;

	constructor(options: BillingServiceOptions) {
		this.#store = options.store;
		this.#nowMs = options.nowMs ?? (() => Date.now());
		this.#newId = options.newId ?? (() => crypto.randomUUID());
		this.#stalePendingMs = options.stalePendingMs ?? 15 * 60_000;
	}

	/** 是否参与扣费：仅成员 Key（对齐 Java 准入口径）。 */
	static chargeable(key: { ownerMemberId: string | null }): boolean {
		return key.ownerMemberId !== null && key.ownerMemberId.trim().length > 0;
	}

	balance(memberId: string): number {
		return this.#store.getWallet(memberId)?.balance ?? 0;
	}

	/**
	 * 预占：估算输入+输出上限 → 按输入侧最贵单价折算 → 行锁扣减。
	 * 余额不足抛 billing.usageInsufficientBalance（网关渲染 402）。
	 * 返回流水 id 与预占额。
	 */
	reserve(
		memberId: string,
		keyId: string,
		model: string,
		payload: Record<string, unknown>,
	): { entryId: string; reserved: number } {
		const rate = this.#store.findRate(model);
		if (rate === undefined || !rate.enabled) {
			// 未配置费率的模型不预占（结算时按 REVIEW 人工处理，对齐 UNKNOWN 语义）
			return { entryId: "", reserved: 0 };
		}
		const inputTokens = estimatePromptTokens(payload);
		const outputTokens = Math.min(estimateMaxOutputTokens(payload), DEFAULT_OUTPUT * 16);
		const per1m = Math.max(rate.promptPer1m, rate.cacheReadPer1m, rate.cacheWritePer1m);
		const estimated = Math.ceil(((inputTokens + outputTokens) * per1m) / 1_000_000);
		const wallet = this.#store.getWallet(memberId);
		const balance = wallet?.balance ?? 0;
		if (balance < estimated) {
			throw BusinessError.of(
				"billing.usageInsufficientBalance",
				`余额不足：预估 ${estimated} 分，可用 ${balance} 分`,
			);
		}
		const balanceAfter = this.#store.debitWallet(memberId, estimated);
		const entry: LedgerEntry = {
			id: this.#newId(),
			memberId,
			keyId,
			requestId: null,
			model,
			amount: -estimated,
			reservedAmount: estimated,
			balanceBefore: balance,
			balanceAfter,
			promptTokens: null,
			completionTokens: null,
			entryType: "USAGE_CHARGE",
			status: "PENDING",
			remark: null,
			occurredAt: this.#nowMs(),
		};
		this.#store.saveLedger(entry);
		return { entryId: entry.id, reserved: estimated };
	}

	/**
	 * 结算：KNOWN 用量按真实 token 分级计价 → 流水 POSTED（正数表示退还差额）；
	 * 未知/无效用量 → REVIEW 待人工；在 PENDING 无对应调用时由清扫退款。
	 */
	settle(
		entryId: string,
		usage: { promptTokens: number; completionTokens: number } | null,
		effectiveModel: string | null,
	): void {
		const entry = this.#store.getLedger(entryId);
		if (entry === undefined || entry.status !== "PENDING") {
			return;
		}
		if (usage === null || usage.promptTokens < 0 || usage.completionTokens < 0) {
			this.#store.saveLedger({ ...entry, status: "REVIEW", remark: "用量未知，待人工核对" });
			return;
		}
		const rate = this.#store.findRate(effectiveModel ?? entry.model) ?? this.#store.findRate(entry.model);
		if (rate === undefined || !rate.enabled) {
			this.#store.saveLedger({ ...entry, status: "REVIEW", remark: "缺少费率，待人工核对" });
			return;
		}
		const inputCost = Math.ceil(
			(usage.promptTokens * Math.max(rate.promptPer1m, rate.cacheReadPer1m, rate.cacheWritePer1m)) / 1_000_000,
		);
		const outputCost = Math.ceil((usage.completionTokens * rate.completionPer1m) / 1_000_000);
		const actual = inputCost + outputCost;
		// 实际费用从预占中结算：退还差额（预占 100、实际 30 → 流水改 -30 并退 70）
		const refund = entry.reservedAmount - actual;
		let balance = this.balance(entry.memberId);
		if (refund > 0) {
			balance = this.#store.creditWallet(entry.memberId, refund);
		} else if (refund < 0) {
			// 实际超预占：记欠费（allow-negative 语义，对齐 Java 超预占记欠）
			balance = this.#store.debitWallet(entry.memberId, -refund);
		}
		this.#store.saveLedger({
			...entry,
			amount: -actual,
			balanceAfter: balance,
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			status: "POSTED",
			remark: `实际 ${actual} 分 / 预占 ${entry.reservedAmount} 分`,
		});
	}

	/** 失败：全额退还预占，流水 VOIDED。 */
	voidPending(entryId: string): void {
		const entry = this.#store.getLedger(entryId);
		if (entry === undefined || entry.status !== "PENDING") {
			return;
		}
		const balance = this.#store.creditWallet(entry.memberId, entry.reservedAmount);
		this.#store.saveLedger({
			...entry,
			amount: 0,
			balanceAfter: balance,
			status: "VOIDED",
			remark: "调用失败，预占退还",
		});
	}

	/** 兜底清扫：PENDING 超时无结算 → 退款（manager BillingReservationJanitor 语义）。 */
	sweepStale(): number {
		const cutoff = this.#nowMs() - this.#stalePendingMs;
		let swept = 0;
		for (const entry of this.#store.findPendingOlderThan(cutoff)) {
			const balance = this.#store.creditWallet(entry.memberId, entry.reservedAmount);
			this.#store.saveLedger({
				...entry,
				amount: 0,
				balanceAfter: balance,
				status: "VOIDED",
				remark: "超时未结算，自动退款",
			});
			swept++;
		}
		return swept;
	}

	listRates(): ModelRate[] {
		return this.#store.listRates();
	}

	saveRate(rate: ModelRate): void {
		this.#store.saveRate({ ...rate, model: rate.model });
	}
}
