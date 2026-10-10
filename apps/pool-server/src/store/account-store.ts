/**
 * AccountStore 的 SQLite 实现 —— 行结构对应 manager `accounts` 表。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Account, AccountInput, AccountStore, CredentialStatus } from "owl-pool";
import { BusinessError, isPlatform } from "owl-pool";

/** patchState 允许写入的列白名单（内部状态字段，不包含录入字段）。 */
const STATE_COLUMNS = {
	lastCheckInAt: "last_check_in_at",
	lastCheckInStatus: "last_check_in_status",
	lastCheckInMessage: "last_check_in_message",
	credits: "credits",
	creditsLabel: "credits_label",
	creditsStatus: "credits_status",
	creditsMessage: "credits_message",
	creditsDetails: "credits_details",
	creditsUpdatedAt: "credits_updated_at",
	creditsExpiry: "credits_expiry",
	credentialExpiresAt: "credential_expires_at",
	credentialStatus: "credential_status",
	credentialCheckedAt: "credential_checked_at",
	credentialMessage: "credential_message",
	cooldownUntil: "cooldown_until",
	sessionGeneration: "session_generation",
	traeSessionHash: "trae_session_hash",
	enabled: "enabled",
} as const;

export class SqliteAccountStore implements AccountStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	list(platform?: string): Account[] {
		if (platform !== undefined) {
			const rows = this.#db
				.prepare("SELECT * FROM accounts WHERE platform = ? ORDER BY created_at DESC")
				.all(platform);
			return rows.map(rowToAccount);
		}
		return this.#db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all().map(rowToAccount);
	}

	listEnabled(): Account[] {
		return this.#db
			.prepare("SELECT * FROM accounts WHERE enabled = 1 ORDER BY created_at DESC")
			.all()
			.map(rowToAccount);
	}

	get(id: string): Account | undefined {
		const row = this.#db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
		return row === undefined ? undefined : rowToAccount(row);
	}

	require(id: string): Account {
		const account = this.get(id);
		if (!account) {
			throw BusinessError.of("account.notFound", `账号不存在: ${id}`, { id });
		}
		return account;
	}

	create(input: AccountInput, nowMs: number): Account {
		const account: Account = {
			id: randomUUID(),
			name: input.name,
			platform: input.platform,
			credentials: input.credentials,
			enabled: input.enabled ?? true,
			remark: input.remark ?? null,
			createdAt: nowMs,
			updatedAt: nowMs,
		};
		this.#db
			.prepare(`
			INSERT INTO accounts (id, name, platform, credentials, enabled, remark, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`)
			.run(
				account.id,
				account.name,
				account.platform,
				JSON.stringify(account.credentials),
				account.enabled ? 1 : 0,
				account.remark ?? null,
				account.createdAt,
				account.updatedAt,
			);
		return account;
	}

	updateFields(id: string, patch: Partial<AccountInput>, nowMs: number): Account {
		const current = this.require(id);
		const next: Account = {
			...current,
			name: patch.name ?? current.name,
			credentials: patch.credentials ?? current.credentials,
			enabled: patch.enabled ?? current.enabled,
			remark: patch.remark === undefined ? current.remark : patch.remark,
			updatedAt: nowMs,
		};
		this.#db
			.prepare("UPDATE accounts SET name = ?, credentials = ?, enabled = ?, remark = ?, updated_at = ? WHERE id = ?")
			.run(
				next.name,
				JSON.stringify(next.credentials),
				next.enabled ? 1 : 0,
				next.remark ?? null,
				next.updatedAt,
				id,
			);
		return next;
	}

	patchState(id: string, patch: Partial<Account>): Account {
		const assignments: string[] = [];
		const values: (string | number | null)[] = [];
		for (const [key, column] of Object.entries(STATE_COLUMNS)) {
			if (key in patch) {
				assignments.push(`${column} = ?`);
				const value = (patch as Record<string, unknown>)[key];
				values.push(
					typeof value === "boolean"
						? value
							? 1
							: 0
						: value === null || value === undefined
							? null
							: typeof value === "number"
								? value
								: String(value),
				);
			}
		}
		if (assignments.length === 0) {
			return this.require(id);
		}
		assignments.push("updated_at = ?");
		values.push(Date.now(), id);
		this.#db.prepare(`UPDATE accounts SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
		return this.require(id);
	}

	delete(id: string): void {
		this.#db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
	}
}

function rowToAccount(row: Record<string, unknown>): Account {
	let credentials: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(String(row.credentials ?? "{}"));
		if (parsed !== null && typeof parsed === "object") {
			credentials = parsed as Record<string, unknown>;
		}
	} catch {
		// 存量脏数据按空凭证处理
	}
	return {
		id: String(row.id),
		name: String(row.name),
		platform: parsePlatform(row.platform),
		credentials,
		sessionGeneration: numberOrNull(row.session_generation) ?? undefined,
		traeSessionHash: textOrNull(row.trae_session_hash),
		enabled: Number(row.enabled) === 1,
		remark: textOrNull(row.remark),
		lastCheckInAt: numberOrNull(row.last_check_in_at),
		lastCheckInStatus: textOrNull(row.last_check_in_status),
		lastCheckInMessage: textOrNull(row.last_check_in_message),
		credits: numberOrNull(row.credits),
		creditsLabel: textOrNull(row.credits_label),
		creditsStatus: textOrNull(row.credits_status),
		creditsMessage: textOrNull(row.credits_message),
		creditsDetails: textOrNull(row.credits_details),
		creditsUpdatedAt: numberOrNull(row.credits_updated_at),
		creditsExpiry: textOrNull(row.credits_expiry),
		credentialExpiresAt: numberOrNull(row.credential_expires_at),
		credentialStatus: (textOrNull(row.credential_status) as CredentialStatus | undefined) ?? null,
		credentialCheckedAt: numberOrNull(row.credential_checked_at),
		credentialMessage: textOrNull(row.credential_message),
		cooldownUntil: numberOrNull(row.cooldown_until),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function parsePlatform(value: unknown): Account["platform"] {
	return isPlatform(value) ? value : "WORKBUDDY";
}

function textOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = Number(value);
	return Number.isNaN(parsed) ? null : parsed;
}
