/**
 * 账号存储 SPI + 内存实现 —— 对齐 manager `AccountRepository` 的查询面。
 * SQLite 实现在 apps/pool-server，领域层只依赖本接口。
 */
import { BusinessError } from "../common/error.ts";
import type { Platform } from "../platform.ts";
import type { Account, AccountInput } from "./types.ts";

export interface AccountStore {
	list(platform?: Platform): Account[];
	listEnabled(): Account[];
	get(id: string): Account | undefined;
	/** 不存在即抛 account.notFound（对齐 manager AccountService.require）。 */
	require(id: string): Account;
	create(input: AccountInput, nowMs: number): Account;
	/** 更新录入字段（name/credentials/enabled/remark）。 */
	updateFields(id: string, patch: Partial<AccountInput>, nowMs: number): Account;
	/** 写内部状态（签到结果/积分快照/冷却等），不触碰 updatedAt 语义之外的录入字段。 */
	patchState(id: string, patch: Partial<Account>): Account;
	delete(id: string): void;
}

export class InMemoryAccountStore implements AccountStore {
	readonly #accounts = new Map<string, Account>();

	list(platform?: Platform): Account[] {
		return [...this.#accounts.values()].filter((account) => platform === undefined || account.platform === platform);
	}

	listEnabled(): Account[] {
		return [...this.#accounts.values()].filter((account) => account.enabled);
	}

	get(id: string): Account | undefined {
		return this.#accounts.get(id);
	}

	require(id: string): Account {
		const account = this.#accounts.get(id);
		if (!account) {
			throw BusinessError.of("account.notFound", `账号不存在: ${id}`, { id });
		}
		// 返回副本，避免调用方绕过 store 直接改内部状态
		return { ...account };
	}

	create(input: AccountInput, nowMs: number): Account {
		const account: Account = {
			id: crypto.randomUUID(),
			name: input.name,
			platform: input.platform,
			credentials: input.credentials,
			enabled: input.enabled ?? true,
			remark: input.remark ?? null,
			createdAt: nowMs,
			updatedAt: nowMs,
		};
		this.#accounts.set(account.id, account);
		return { ...account };
	}

	updateFields(id: string, patch: Partial<AccountInput>, nowMs: number): Account {
		const account = this.require(id);
		const next: Account = {
			...account,
			name: patch.name ?? account.name,
			credentials: patch.credentials ?? account.credentials,
			enabled: patch.enabled ?? account.enabled,
			remark: patch.remark === undefined ? account.remark : patch.remark,
			updatedAt: nowMs,
		};
		this.#accounts.set(id, next);
		return { ...next };
	}

	patchState(id: string, patch: Partial<Account>): Account {
		const account = this.require(id);
		const next: Account = { ...account, ...patch, updatedAt: Date.now() };
		this.#accounts.set(id, next);
		return { ...next };
	}

	delete(id: string): void {
		this.#accounts.delete(id);
	}
}
