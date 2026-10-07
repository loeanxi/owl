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

CREATE TABLE IF NOT EXISTS admin_credentials (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	salt TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	source_fingerprint TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	key_prefix TEXT NOT NULL,
	key_suffix TEXT,
	key_hash TEXT NOT NULL UNIQUE,
	owner_member_id TEXT,
	parent_key_id TEXT,
	revoked_at INTEGER,
	bound_platform TEXT,
	allowed_models TEXT,
	effort_policy TEXT,
	allowed_ips TEXT,
	rate_limit_per_minute INTEGER,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS published_models (
	id TEXT PRIMARY KEY,
	public_id TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	description TEXT,
	model_version TEXT,
	context_window INTEGER,
	default_context_window INTEGER,
	default_reasoning_effort TEXT,
	max_output_tokens INTEGER,
	supports_images INTEGER NOT NULL DEFAULT 0,
	supports_tools INTEGER NOT NULL DEFAULT 0,
	reasoning_efforts TEXT NOT NULL DEFAULT '[]',
	published INTEGER NOT NULL DEFAULT 0,
	sort_order INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS published_model_routes (
	id TEXT PRIMARY KEY,
	model_id TEXT NOT NULL,
	platform TEXT NOT NULL,
	upstream_model TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 0,
	enabled INTEGER NOT NULL DEFAULT 1,
	supports_images INTEGER NOT NULL DEFAULT 0,
	supports_tools INTEGER NOT NULL DEFAULT 0,
	reasoning_efforts TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS discovered_models (
	platform TEXT NOT NULL,
	upstream_model TEXT NOT NULL,
	available INTEGER NOT NULL DEFAULT 1,
	context_window INTEGER,
	max_output_tokens INTEGER,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (platform, upstream_model)
);

CREATE TABLE IF NOT EXISTS gateway_call_logs (
	id TEXT PRIMARY KEY,
	key_id TEXT,
	account_id TEXT,
	platform TEXT,
	model TEXT,
	effective_model TEXT,
	prompt_tokens INTEGER,
	completion_tokens INTEGER,
	total_tokens INTEGER,
	cache_read_tokens INTEGER,
	cache_write_tokens INTEGER,
	latency_ms INTEGER,
	status TEXT NOT NULL,
	message TEXT,
	client_ip TEXT,
	request_id TEXT,
	usage_source TEXT,
	error_category TEXT,
	occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_call_logs_occurred ON gateway_call_logs (occurred_at DESC);

CREATE TABLE IF NOT EXISTS billing_member_wallets (
	member_id TEXT PRIMARY KEY,
	balance INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_ledger_entries (
	id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL,
	key_id TEXT,
	request_id TEXT,
	model TEXT NOT NULL,
	amount INTEGER NOT NULL,
	reserved_amount INTEGER NOT NULL,
	balance_before INTEGER NOT NULL,
	balance_after INTEGER NOT NULL,
	prompt_tokens INTEGER,
	completion_tokens INTEGER,
	entry_type TEXT NOT NULL,
	status TEXT NOT NULL,
	remark TEXT,
	occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_member_occurred ON billing_ledger_entries (member_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS billing_model_rates (
	model TEXT PRIMARY KEY,
	prompt_per_1m INTEGER NOT NULL,
	completion_per_1m INTEGER NOT NULL,
	cache_read_per_1m INTEGER NOT NULL,
	cache_write_per_1m INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1
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
