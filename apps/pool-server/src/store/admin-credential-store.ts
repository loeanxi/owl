/**
 * admin_credentials 单行表存储 —— 对齐 manager `AdminCredential` 实体
 * （id 固定 "default"，列名与 manager 一致，历史凭据可直接搬入）。
 */
import type { DatabaseSync } from "node:sqlite";

export interface AdminCredentialRecord {
	id: string;
	username: string;
	salt: string;
	passwordHash: string;
	sourceFingerprint: string;
	updatedAt: number;
}

export interface AdminCredentialStore {
	get(): AdminCredentialRecord | undefined;
	save(record: AdminCredentialRecord): void;
}

export class SqliteAdminCredentialStore implements AdminCredentialStore {
	readonly #db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.#db = db;
	}

	get(): AdminCredentialRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM admin_credentials WHERE id = 'default'").get() as
			| Record<string, unknown>
			| undefined;
		if (row === undefined) {
			return undefined;
		}
		return {
			id: String(row.id),
			username: String(row.username),
			salt: String(row.salt),
			passwordHash: String(row.password_hash),
			sourceFingerprint: String(row.source_fingerprint),
			updatedAt: Number(row.updated_at),
		};
	}

	save(record: AdminCredentialRecord): void {
		this.#db
			.prepare(`
			INSERT INTO admin_credentials (id, username, salt, password_hash, source_fingerprint, updated_at)
			VALUES ('default', ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				username = excluded.username,
				salt = excluded.salt,
				password_hash = excluded.password_hash,
				source_fingerprint = excluded.source_fingerprint,
				updated_at = excluded.updated_at
		`)
			.run(record.username, record.salt, record.passwordHash, record.sourceFingerprint, record.updatedAt);
	}
}
