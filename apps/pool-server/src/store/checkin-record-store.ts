/**
 * CheckInRecordStore 的 SQLite 实现 —— 对应 manager `check_in_records` 表。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CheckInRecord, CheckInRecordStore, CheckInStatus } from "owl-pool";

export class SqliteCheckInRecordStore implements CheckInRecordStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	save(record: CheckInRecord): void {
		this.#db
			.prepare(`
			INSERT INTO check_in_records (id, account_id, account_name, platform, status, message, credits, detail, occurred_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
			.run(
				record.id,
				record.accountId,
				record.accountName,
				record.platform,
				record.status,
				record.message,
				record.credits,
				record.detail,
				record.occurredAt,
			);
	}

	recent(limit: number): CheckInRecord[] {
		return this.#db
			.prepare("SELECT * FROM check_in_records ORDER BY occurred_at DESC LIMIT ?")
			.all(limit)
			.map(rowToRecord);
	}

	findById(id: string): CheckInRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM check_in_records WHERE id = ?").get(id);
		return row === undefined ? undefined : rowToRecord(row);
	}

	delete(id: string): void {
		this.#db.prepare("DELETE FROM check_in_records WHERE id = ?").run(id);
	}

	clear(): void {
		this.#db.exec("DELETE FROM check_in_records");
	}
}

/** 兜底：调用方漏发 id 时补 UUID（对齐 Java @PrePersist）。 */
export function newRecordId(): string {
	return randomUUID();
}

function rowToRecord(row: Record<string, unknown>): CheckInRecord {
	return {
		id: String(row.id),
		accountId: String(row.account_id),
		accountName: String(row.account_name),
		platform: String(row.platform) as CheckInRecord["platform"],
		status: String(row.status) as CheckInStatus,
		message: textOrNull(row.message),
		credits: row.credits === null || row.credits === undefined ? null : Number(row.credits),
		detail: textOrNull(row.detail),
		occurredAt: Number(row.occurred_at),
	};
}

function textOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}
