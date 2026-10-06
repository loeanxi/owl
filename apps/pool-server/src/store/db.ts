/**
 * SQLite 打开与建表 —— node:sqlite（仓库唯一 DB 先例）。
 * 表名/列名沿用 manager 的 schema（驼峰→snake_case），时间列用 epoch 毫秒，
 * 布尔用 0/1，割接时从 manager 备份 zip（每表 JSONL）一次性导入（见迁移文档 §7）。
 */
import { DatabaseSync } from "node:sqlite";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function openDb(dbPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(SCHEMA);
	return db;
}

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS accounts (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	platform TEXT NOT NULL,
	credentials TEXT NOT NULL,
	session_generation INTEGER,
	trae_session_hash TEXT UNIQUE,
	enabled INTEGER NOT NULL DEFAULT 1,
	remark TEXT,
	last_check_in_at INTEGER,
	last_check_in_status TEXT,
	last_check_in_message TEXT,
	credits REAL,
	credits_label TEXT,
	credits_status TEXT,
	credits_message TEXT,
	credits_details TEXT,
	credits_updated_at INTEGER,
	credential_expires_at INTEGER,
	credential_status TEXT,
	credential_checked_at INTEGER,
	credential_message TEXT,
	cooldown_until INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS check_in_records (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	account_name TEXT NOT NULL,
	platform TEXT NOT NULL,
	status TEXT NOT NULL,
	message TEXT,
	credits INTEGER,
	detail TEXT,
	occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_in_records_occurred ON check_in_records (occurred_at DESC);
`;

/** healthz 用：SELECT 1 探活。 */
export function dbAlive(db: DatabaseSync): boolean {
	try {
		db.prepare("SELECT 1").get();
		return true;
	} catch {
		return false;
	}
}
