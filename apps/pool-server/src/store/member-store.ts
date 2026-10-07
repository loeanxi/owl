/**
 * members 表 —— 对齐 manager `Member` 实体。
 * 口令只存 salt + PBKDF2 派生值，和 admin_credentials 同一套算法，可从 Postgres 直搬。
 */
import type { DatabaseSync } from "node:sqlite";

export interface MemberRecord {
	id: string;
	username: string;
	displayName: string;
	passwordSalt: string;
	passwordHash: string;
	enabled: boolean;
	maxConcurrentRequests: number | null;
	createdAt: number;
	updatedAt: number;
}

export class SqliteMemberStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	findById(id: string): MemberRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row === undefined ? undefined : rowToMember(row);
	}

	findByUsername(username: string): MemberRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM members WHERE username = ?").get(username) as
			| Record<string, unknown>
			| undefined;
		return row === undefined ? undefined : rowToMember(row);
	}

	list(): MemberRecord[] {
		return this.#db
			.prepare("SELECT * FROM members ORDER BY username")
			.all()
			.map((row) => rowToMember(row as Record<string, unknown>));
	}

	delete(id: string): void {
		this.#db.prepare("DELETE FROM members WHERE id = ?").run(id);
	}

	save(member: MemberRecord): void {
		this.#db
			.prepare(`
			INSERT INTO members (id, username, display_name, password_salt, password_hash, enabled,
				max_concurrent_requests, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				username = excluded.username, display_name = excluded.display_name,
				password_salt = excluded.password_salt, password_hash = excluded.password_hash,
				enabled = excluded.enabled, max_concurrent_requests = excluded.max_concurrent_requests,
				updated_at = excluded.updated_at
		`)
			.run(
				member.id,
				member.username,
				member.displayName,
				member.passwordSalt,
				member.passwordHash,
				member.enabled ? 1 : 0,
				member.maxConcurrentRequests,
				member.createdAt,
				member.updatedAt,
			);
	}
}

function rowToMember(row: Record<string, unknown>): MemberRecord {
	return {
		id: String(row.id),
		username: String(row.username),
		displayName: String(row.display_name),
		passwordSalt: String(row.password_salt),
		passwordHash: String(row.password_hash),
		enabled: Number(row.enabled) === 1,
		maxConcurrentRequests:
			row.max_concurrent_requests === null || row.max_concurrent_requests === undefined
				? null
				: Number(row.max_concurrent_requests),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
