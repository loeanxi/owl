/**
 * 签到服务 —— 移植自 manager `checkin/CheckInService`。
 * 单号签到 / 全量签到 / 登录补签判定 / 记录与账号状态落库。
 * Java 版的 @Transactional 在这里按「先签到后持久化」的顺序语义保留：
 * 任一步抛错向上冒泡，由 HTTP 层渲染统一错误。
 */

import type { AccountStore } from "../account/store.ts";
import type { Account } from "../account/types.ts";
import { todayRange } from "../common/business-time.ts";
import { BusinessError } from "../common/error.ts";
import { describeUpstreamError } from "../common/upstream.ts";
import type { Platform } from "../platform.ts";
import type { CheckInProvider } from "./provider.ts";
import type { CheckInRecordStore } from "./record-store.ts";
import { type CheckInRecord, type CheckInResult, checkInFailed, checkInRecordOf } from "./types.ts";

/** 凭证健康联动（manager CredentialHealthService 的钩子位）；阶段 2 完整实现。 */
export interface CredentialHealthHooks {
	markAuthFailure(account: Account, message: string | null): void;
	markAuthSuccess(account: Account): void;
}

export interface AccountCheckInOutcome {
	accountId: string;
	accountName: string;
	platform: Platform;
	result: CheckInResult;
}

export interface BatchCheckInOutcome {
	total: number;
	success: number;
	already: number;
	failed: number;
	items: AccountCheckInOutcome[];
}

export interface CheckInCapability {
	supported: boolean;
	configured: boolean;
}

export interface SelectedCheckInOutcome extends BatchCheckInOutcome {
	requested: number;
	skipped: number;
	skippedItems: Array<{ accountId: string; reason: "DISABLED" | "NOT_SUPPORTED" | "NOT_CONFIGURED" }>;
}

export interface CheckInServiceOptions {
	accounts: AccountStore;
	records: CheckInRecordStore;
	providers: CheckInProvider[];
	credentialHealth?: CredentialHealthHooks;
	newId?(): string;
	nowMs?(): number;
}

export class CheckInService {
	readonly #accounts: AccountStore;
	readonly #records: CheckInRecordStore;
	readonly #providers: Map<Platform, CheckInProvider>;
	readonly #credentialHealth?: CredentialHealthHooks;
	readonly #newId: () => string;
	readonly #nowMs: () => number;

	constructor(options: CheckInServiceOptions) {
		this.#accounts = options.accounts;
		this.#records = options.records;
		this.#credentialHealth = options.credentialHealth;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
		this.#nowMs = options.nowMs ?? (() => Date.now());
		this.#providers = new Map(options.providers.map((provider) => [provider.supports(), provider]));
	}

	/** 能力与凭证配置分别判断；停用或凭证失效不改变平台的签到分类。 */
	capability(account: Account): CheckInCapability {
		const provider = this.#providers.get(account.platform);
		return {
			supported: provider !== undefined,
			configured: provider !== undefined && (provider.isConfigured?.(account) ?? true),
		};
	}

	/** 签到单个账号（平台不支持/凭证未配置直接抛业务错误，对齐 Java 版）。 */
	async checkInOne(accountId: string): Promise<AccountCheckInOutcome> {
		const account = this.#accounts.require(accountId);
		const provider = this.#providers.get(account.platform);
		if (!provider) {
			throw BusinessError.of("checkin.notSupported", "该订阅账号没有签到操作");
		}
		if (provider.isConfigured !== undefined && !provider.isConfigured(account)) {
			throw BusinessError.of("checkin.notConfigured", "该账号尚未配置签到所需凭证");
		}
		const result = await this.attempt(account, provider);
		this.persist(account, result);
		return { accountId: account.id, accountName: account.name, platform: account.platform, result };
	}

	/** 一键全量签到（onlyEnabled=false 时包含停用账号，但停用账号会得到「已停用」失败结果）。 */
	async checkInAll(onlyEnabled = true): Promise<BatchCheckInOutcome> {
		const accounts = (onlyEnabled ? this.#accounts.listEnabled() : this.#accounts.list()).filter((account) =>
			this.canCheckIn(account),
		);
		if (accounts.length === 0) {
			throw BusinessError.of("checkin.noAccounts", "没有可签到的账号");
		}
		return this.runBatch(accounts);
	}

	/** 当前筛选批量：先校验全部 ID，再去重，跳过执行时不满足条件的账号。 */
	async checkInSelected(accountIds: string[]): Promise<SelectedCheckInOutcome> {
		if (accountIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
			throw BusinessError.of("checkin.badAccountIds", "accountIds 必须是非空账号 ID 的数组");
		}
		const selected = [...new Set(accountIds)].map((id) => this.#accounts.require(id));
		const accounts: Account[] = [];
		const skippedItems: SelectedCheckInOutcome["skippedItems"] = [];
		for (const account of selected) {
			const capability = this.capability(account);
			const reason = !account.enabled
				? "DISABLED"
				: !capability.supported
					? "NOT_SUPPORTED"
					: !capability.configured
						? "NOT_CONFIGURED"
						: null;
			if (reason !== null) {
				skippedItems.push({ accountId: account.id, reason });
			} else {
				accounts.push(account);
			}
		}
		return {
			...(await this.runBatch(accounts)),
			requested: selected.length,
			skipped: skippedItems.length,
			skippedItems,
		};
	}

	/**
	 * 登录补签：只签今天业务日内还没有成功签到的启用账号。
	 * 没有需要补签的账号时返回 null（对齐 Java 版）。
	 */
	async catchUpUnsigned(): Promise<BatchCheckInOutcome | null> {
		const accounts = this.#accounts
			.listEnabled()
			.filter((account) => this.canCheckIn(account) && !signedToday(account, this.#nowMs()));
		if (accounts.length === 0) {
			return null;
		}
		return this.runBatch(accounts);
	}

	/** 需要补签的账号数。 */
	countUnsigned(): number {
		return this.#accounts
			.listEnabled()
			.filter((account) => this.canCheckIn(account) && !signedToday(account, this.#nowMs())).length;
	}

	/** 可签到的启用账号（定时器用：有 Provider 且凭证已配置）。 */
	listCheckable(): Account[] {
		return this.#accounts.listEnabled().filter((account) => this.canCheckIn(account));
	}

	recentRecords(limit = 50): CheckInRecord[] {
		return this.#records.recent(limit);
	}

	deleteRecord(id: string): void {
		if (!this.#records.findById(id)) {
			throw BusinessError.of("checkin.recordNotFound", `记录不存在: ${id}`, { id });
		}
		this.#records.delete(id);
	}

	clearRecords(): void {
		this.#records.clear();
	}

	/** 平台可签（有 Provider 且凭证已配置）。 */
	private canCheckIn(account: Account): boolean {
		return this.capability(account).configured;
	}

	private async runBatch(accounts: Account[]): Promise<BatchCheckInOutcome> {
		const items: AccountCheckInOutcome[] = [];
		let success = 0;
		let already = 0;
		let failed = 0;
		for (const account of accounts) {
			const provider = this.#providers.get(account.platform);
			const result = provider
				? await this.attempt(account, provider)
				: checkInFailed(`未注册的平台 Provider: ${account.platform}`, null, this.#nowMs());
			this.persist(account, result);
			items.push({ accountId: account.id, accountName: account.name, platform: account.platform, result });
			if (result.status === "SUCCESS") {
				success++;
			} else if (result.status === "ALREADY") {
				already++;
			} else {
				failed++;
			}
		}
		return { total: accounts.length, success, already, failed, items };
	}

	/** Provider 异常不冒泡，折成 FAILED 结果（对齐 Java doCheckIn 的 try/catch）。 */
	private async attempt(account: Account, provider: CheckInProvider): Promise<CheckInResult> {
		if (!account.enabled) {
			return checkInFailed("账号已停用，跳过", null, this.#nowMs());
		}
		try {
			return await provider.checkIn(account);
		} catch (error) {
			return checkInFailed(`签到异常: ${describeUpstreamError(error)}`, null, this.#nowMs());
		}
	}

	private persist(account: Account, result: CheckInResult): void {
		this.#records.save(checkInRecordOf(account, result, this.#newId()));
		this.#accounts.patchState(account.id, {
			lastCheckInAt: result.occurredAt,
			lastCheckInStatus: result.status,
			lastCheckInMessage: result.message,
		});
		if (result.status === "AUTH_ERROR") {
			this.#credentialHealth?.markAuthFailure(account, result.message);
		} else if (result.status === "SUCCESS" || result.status === "ALREADY") {
			this.#credentialHealth?.markAuthSuccess(account);
		}
	}
}

/**
 * 今天业务日内已成功签到（SUCCESS/ALREADY/OK）视为已签；
 * 失败记录或更早的记录都参与补签（移植 manager 静态方法 signedToday）。
 */
export function signedToday(account: Account, nowMs: number): boolean {
	if (!account.lastCheckInAt) {
		return false;
	}
	const today = todayRange(nowMs);
	const at = account.lastCheckInAt;
	if (at < today.from || at >= today.to) {
		return false;
	}
	const status = account.lastCheckInStatus;
	return status === "SUCCESS" || status === "ALREADY" || status === "OK";
}
