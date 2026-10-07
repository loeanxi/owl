/**
 * 从正在跑的 manager Postgres 整表迁入 owl SQLite。
 * 只打印行数和账号摘要（名称、平台、是否启用、凭证长度），不打印凭证、盐、哈希。
 * 用法：node scripts/import-live-from-postgres.mjs [pool.db]
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? "D:/owl/owl-re-v1/owl-mono/apps/pool-server/data/pool.db";

function dump(sql) {
	const result = spawnSync(
		"docker",
		["exec", "manager-postgres-1", "psql", "-U", "manager", "-d", "manager", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
		{ encoding: "utf8", maxBuffer: 128 * 1024 * 1024, windowsHide: true },
	);
	if (result.status !== 0) {
		const detail = String(result.stderr ?? "").slice(0, 240).replace(/\s+/g, " ");
		throw new Error(`psql exit ${result.status}: ${detail}`);
	}
	const rows = [];
	for (const line of String(result.stdout).split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		rows.push(JSON.parse(line));
	}
	return rows;
}

function toMs(value) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return value;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function bit(value) {
	return value === true || value === 1 || value === "true" || value === "t" ? 1 : 0;
}

function text(value) {
	if (value === null || value === undefined) return null;
	return typeof value === "string" ? value : JSON.stringify(value);
}

function yuanToCents(value) {
	if (value === null || value === undefined || value === "") return null;
	const raw = String(value).trim();
	if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error("金额格式无法换算成分");
	const negative = raw.startsWith("-");
	const [whole, fraction = ""] = raw.slice(negative ? 1 : 0).split(".");
	const digits = `${fraction}000`.slice(0, 3);
	let cents = BigInt(whole || "0") * 100n + BigInt(digits.slice(0, 2));
	if (digits[2] >= "5") cents += 1n;
	const signed = negative ? -cents : cents;
	const number = Number(signed);
	if (!Number.isSafeInteger(number)) throw new Error("金额超出安全整数");
	return number;
}

function addColumn(db, table, name, type) {
	const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
	if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = OFF");
db.exec(`
CREATE TABLE IF NOT EXISTS trae_account_model_snapshots (
	account_id TEXT PRIMARY KEY,
	model_functions TEXT NOT NULL,
	model_context_windows TEXT,
	model_max_output_tokens TEXT,
	synced_at INTEGER
);
CREATE TABLE IF NOT EXISTS workbuddy_account_model_snapshots (
	account_id TEXT PRIMARY KEY,
	model_ids TEXT NOT NULL,
	context_windows TEXT,
	max_output_tokens TEXT,
	reasoning_efforts TEXT,
	synced_at INTEGER
)`);
for (const [table, name, type] of [
	["published_models", "revision", "INTEGER"],
	["discovered_models", "id", "TEXT"],
	["discovered_models", "name", "TEXT"],
	["discovered_models", "catalog_source", "TEXT"],
	["discovered_models", "model_version", "TEXT"],
	["discovered_models", "display_order", "INTEGER"],
	["discovered_models", "supports_images", "INTEGER"],
	["discovered_models", "upstream_multimodal", "INTEGER"],
	["discovered_models", "supports_tools", "INTEGER"],
	["discovered_models", "reasoning_efforts", "TEXT"],
	["discovered_models", "available_context_windows", "TEXT"],
	["discovered_models", "available_modes", "TEXT"],
	["discovered_models", "default_reasoning_effort", "TEXT"],
	["discovered_models", "supports_disabled_reasoning", "INTEGER"],
	["discovered_models", "last_seen_at", "INTEGER"],
	["discovered_models", "verified_model_version", "TEXT"],
	["discovered_models", "verified_supports_images", "INTEGER"],
	["discovered_models", "verified_supports_tools", "INTEGER"],
	["discovered_models", "verified_reasoning_efforts", "TEXT"],
	["discovered_models", "verified_at", "INTEGER"],
	["discovered_models", "verification_source", "TEXT"],
	["discovered_models", "verification_status", "TEXT"],
	["discovered_models", "verification_invalidated_at", "INTEGER"],
	["discovered_models", "revision", "INTEGER"],
	["billing_member_wallets", "id", "TEXT"],
	["billing_member_wallets", "currency", "TEXT"],
	["billing_member_wallets", "created_at", "INTEGER"],
	["billing_member_wallets", "version", "INTEGER"],
	["billing_ledger_entries", "cache_read_tokens", "INTEGER"],
	["billing_ledger_entries", "cache_write_tokens", "INTEGER"],
	["billing_ledger_entries", "cache_read_per_1m", "INTEGER"],
	["billing_ledger_entries", "cache_write_per_1m", "INTEGER"],
	["billing_ledger_entries", "completion_per_1m", "INTEGER"],
	["billing_ledger_entries", "prompt_per_1m", "INTEGER"],
	["billing_ledger_entries", "call_log_id", "TEXT"],
	["billing_ledger_entries", "currency", "TEXT"],
	["billing_ledger_entries", "effort", "TEXT"],
	["billing_ledger_entries", "effort_multiplier", "TEXT"],
	["billing_ledger_entries", "historical", "INTEGER"],
	["billing_ledger_entries", "budget_root_key_id", "TEXT"],
	["billing_model_rates", "id", "TEXT"],
	["billing_model_rates", "effort_multipliers", "TEXT"],
	["billing_model_rates", "remark", "TEXT"],
	["billing_model_rates", "created_at", "INTEGER"],
	["billing_model_rates", "updated_at", "INTEGER"],
	["billing_rate_drafts", "created_at", "INTEGER"],
	["gateway_call_logs", "capability_decision", "TEXT"],
	["gateway_call_logs", "credit_cost", "TEXT"],
	["gateway_call_logs", "credits_after", "TEXT"],
	["gateway_call_logs", "credits_before", "TEXT"],
	["gateway_call_logs", "route_attempts", "TEXT"],
]) addColumn(db, table, name, type);

const summary = {};

function load(label, rows, statement) {
	const insert = db.prepare(statement);
	db.exec("BEGIN");
	try {
		for (const row of rows) insert.run(...row);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw new Error(`${label} 写入失败: ${error instanceof Error ? error.message : "unknown"}`);
	}
	summary[label] = rows.length;
}

const accounts = dump("SELECT row_to_json(t) FROM accounts t");
load(
	"accounts",
	accounts.map((row) => [
		row.id, row.name, row.platform, text(row.credentials), row.session_generation ?? null, text(row.trae_session_hash),
		bit(row.enabled), text(row.remark), toMs(row.last_check_in_at), text(row.last_check_in_status), text(row.last_check_in_message),
		row.credits === null || row.credits === undefined ? null : Number(row.credits),
		text(row.credits_label), text(row.credits_status), text(row.credits_message), text(row.credits_details), toMs(row.credits_updated_at),
		toMs(row.credential_expires_at), text(row.credential_status), toMs(row.credential_checked_at), text(row.credential_message),
		toMs(row.cooldown_until), toMs(row.created_at) ?? 0, toMs(row.updated_at) ?? 0,
	]),
	`INSERT INTO accounts (id, name, platform, credentials, session_generation, trae_session_hash,
		enabled, remark, last_check_in_at, last_check_in_status, last_check_in_message,
		credits, credits_label, credits_status, credits_message, credits_details, credits_updated_at,
		credential_expires_at, credential_status, credential_checked_at, credential_message,
		cooldown_until, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name = excluded.name, platform = excluded.platform, credentials = excluded.credentials,
		session_generation = excluded.session_generation, trae_session_hash = excluded.trae_session_hash,
		enabled = excluded.enabled, remark = excluded.remark,
		last_check_in_at = excluded.last_check_in_at, last_check_in_status = excluded.last_check_in_status,
		last_check_in_message = excluded.last_check_in_message,
		credits = excluded.credits, credits_label = excluded.credits_label, credits_status = excluded.credits_status,
		credits_message = excluded.credits_message, credits_details = excluded.credits_details,
		credits_updated_at = excluded.credits_updated_at,
		credential_expires_at = excluded.credential_expires_at, credential_status = excluded.credential_status,
		credential_checked_at = excluded.credential_checked_at, credential_message = excluded.credential_message,
		cooldown_until = excluded.cooldown_until, updated_at = excluded.updated_at`,
);

const keys = dump("SELECT row_to_json(t) FROM api_keys t");
load(
	"api_keys",
	keys.map((row) => [
		row.id, row.name, text(row.key_prefix), text(row.key_suffix), row.key_hash,
		text(row.owner_member_id), text(row.parent_key_id), toMs(row.revoked_at),
		text(row.bound_platform), text(row.allowed_models), text(row.effort_policy),
		text(row.allowed_ips), row.rate_limit_per_minute ?? null, bit(row.enabled),
		toMs(row.created_at) ?? 0, toMs(row.expires_at),
	]),
	`INSERT INTO api_keys (id, name, key_prefix, key_suffix, key_hash, owner_member_id, parent_key_id,
		revoked_at, bound_platform, allowed_models, effort_policy, allowed_ips, rate_limit_per_minute,
		enabled, created_at, expires_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name = excluded.name, key_prefix = excluded.key_prefix, key_suffix = excluded.key_suffix,
		key_hash = excluded.key_hash, owner_member_id = excluded.owner_member_id, parent_key_id = excluded.parent_key_id,
		revoked_at = excluded.revoked_at, bound_platform = excluded.bound_platform,
		allowed_models = excluded.allowed_models, effort_policy = excluded.effort_policy,
		allowed_ips = excluded.allowed_ips, rate_limit_per_minute = excluded.rate_limit_per_minute,
		enabled = excluded.enabled, expires_at = excluded.expires_at`,
);

const members = dump("SELECT row_to_json(t) FROM members t");
load(
	"members",
	members.map((row) => [
		row.id, String(row.username ?? "").trim().toLowerCase(), row.display_name,
		row.password_salt, row.password_hash, bit(row.enabled), row.max_concurrent_requests ?? null,
		toMs(row.created_at) ?? 0, toMs(row.updated_at) ?? 0,
	]),
	`INSERT INTO members (id, username, display_name, password_salt, password_hash, enabled,
		max_concurrent_requests, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		username = excluded.username, display_name = excluded.display_name,
		password_salt = excluded.password_salt, password_hash = excluded.password_hash,
		enabled = excluded.enabled, max_concurrent_requests = excluded.max_concurrent_requests,
		updated_at = excluded.updated_at`,
);

const admins = dump("SELECT row_to_json(t) FROM admin_credentials t");
load(
	"admin_credentials",
	admins.map((row) => [row.id ?? "default", row.username, row.salt, row.password_hash, text(row.source_fingerprint) ?? "", toMs(row.updated_at) ?? Date.now()]),
	`INSERT INTO admin_credentials (id, username, salt, password_hash, source_fingerprint, updated_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		username = excluded.username, salt = excluded.salt, password_hash = excluded.password_hash,
		source_fingerprint = excluded.source_fingerprint, updated_at = excluded.updated_at`,
);

const models = dump("SELECT row_to_json(t) FROM published_models t");
load(
	"published_models",
	models.map((row) => [
		row.id, row.public_id, row.name, text(row.description), text(row.model_version),
		row.context_window ?? null, row.default_context_window ?? null, text(row.default_reasoning_effort),
		row.max_output_tokens ?? null, bit(row.supports_images), bit(row.supports_tools),
		text(row.reasoning_efforts) ?? "[]", bit(row.published), row.sort_order ?? 0, toMs(row.updated_at) ?? 0,
		row.revision ?? null,
	]),
	`INSERT INTO published_models (id, public_id, name, description, model_version, context_window,
		default_context_window, default_reasoning_effort, max_output_tokens, supports_images,
		supports_tools, reasoning_efforts, published, sort_order, updated_at, revision)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		public_id = excluded.public_id, name = excluded.name, description = excluded.description,
		model_version = excluded.model_version, context_window = excluded.context_window,
		default_context_window = excluded.default_context_window, default_reasoning_effort = excluded.default_reasoning_effort,
		max_output_tokens = excluded.max_output_tokens, supports_images = excluded.supports_images,
		supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts,
		published = excluded.published, sort_order = excluded.sort_order, updated_at = excluded.updated_at,
		revision = excluded.revision`,
);

const routes = dump("SELECT row_to_json(t) FROM published_model_routes t");
load(
	"published_model_routes",
	routes.map((row) => [
		row.id, row.published_model_id, row.platform, row.upstream_model, row.priority ?? 0, bit(row.enabled),
		bit(row.supports_images), bit(row.supports_tools), text(row.reasoning_efforts) ?? "[]",
	]),
	`INSERT INTO published_model_routes (id, model_id, platform, upstream_model, priority, enabled,
		supports_images, supports_tools, reasoning_efforts)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		model_id = excluded.model_id, platform = excluded.platform, upstream_model = excluded.upstream_model,
		priority = excluded.priority, enabled = excluded.enabled, supports_images = excluded.supports_images,
		supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts`,
);

const discovered = dump("SELECT row_to_json(t) FROM discovered_models t");
load(
	"discovered_models",
	discovered.map((row) => [
		row.platform, row.upstream_model, bit(row.available), row.context_window ?? null, row.max_output_tokens ?? null,
		toMs(row.last_seen_at) ?? Date.now(), text(row.id), text(row.name), text(row.catalog_source), text(row.model_version),
		row.display_order ?? null, row.supports_images === null || row.supports_images === undefined ? null : bit(row.supports_images),
		row.upstream_multimodal === null || row.upstream_multimodal === undefined ? null : bit(row.upstream_multimodal),
		row.supports_tools === null || row.supports_tools === undefined ? null : bit(row.supports_tools),
		text(row.reasoning_efforts), text(row.available_context_windows), text(row.available_modes),
		text(row.default_reasoning_effort),
		row.supports_disabled_reasoning === null || row.supports_disabled_reasoning === undefined ? null : bit(row.supports_disabled_reasoning),
		toMs(row.last_seen_at), text(row.verified_model_version),
		row.verified_supports_images === null || row.verified_supports_images === undefined ? null : bit(row.verified_supports_images),
		row.verified_supports_tools === null || row.verified_supports_tools === undefined ? null : bit(row.verified_supports_tools),
		text(row.verified_reasoning_efforts), toMs(row.verified_at), text(row.verification_source), text(row.verification_status),
		toMs(row.verification_invalidated_at), row.revision ?? null,
	]),
	`INSERT INTO discovered_models (platform, upstream_model, available, context_window, max_output_tokens, updated_at,
		id, name, catalog_source, model_version, display_order, supports_images, upstream_multimodal, supports_tools,
		reasoning_efforts, available_context_windows, available_modes, default_reasoning_effort, supports_disabled_reasoning,
		last_seen_at, verified_model_version, verified_supports_images, verified_supports_tools, verified_reasoning_efforts,
		verified_at, verification_source, verification_status, verification_invalidated_at, revision)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(platform, upstream_model) DO UPDATE SET
		available = excluded.available, context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
		updated_at = excluded.updated_at, id = excluded.id, name = excluded.name, catalog_source = excluded.catalog_source,
		model_version = excluded.model_version, display_order = excluded.display_order, supports_images = excluded.supports_images,
		upstream_multimodal = excluded.upstream_multimodal, supports_tools = excluded.supports_tools,
		reasoning_efforts = excluded.reasoning_efforts, available_context_windows = excluded.available_context_windows,
		available_modes = excluded.available_modes, default_reasoning_effort = excluded.default_reasoning_effort,
		supports_disabled_reasoning = excluded.supports_disabled_reasoning, last_seen_at = excluded.last_seen_at,
		verified_model_version = excluded.verified_model_version, verified_supports_images = excluded.verified_supports_images,
		verified_supports_tools = excluded.verified_supports_tools, verified_reasoning_efforts = excluded.verified_reasoning_efforts,
		verified_at = excluded.verified_at, verification_source = excluded.verification_source,
		verification_status = excluded.verification_status, verification_invalidated_at = excluded.verification_invalidated_at,
		revision = excluded.revision`,
);

const rates = dump(`SELECT row_to_json(x) FROM (
	SELECT id, model, prompt_per1m::text AS prompt_per1m, completion_per1m::text AS completion_per1m,
		cache_read_per1m::text AS cache_read_per1m, cache_write_per1m::text AS cache_write_per1m,
		enabled, effort_multipliers, remark, created_at, updated_at
	FROM billing_model_rates) x`);
load(
	"billing_model_rates",
	rates.map((row) => [
		row.model, yuanToCents(row.prompt_per1m) ?? 0, yuanToCents(row.completion_per1m) ?? 0,
		yuanToCents(row.cache_read_per1m) ?? 0, yuanToCents(row.cache_write_per1m) ?? 0, bit(row.enabled),
		text(row.id), text(row.effort_multipliers), text(row.remark), toMs(row.created_at), toMs(row.updated_at),
	]),
	`INSERT INTO billing_model_rates (model, prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_write_per_1m,
		enabled, id, effort_multipliers, remark, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(model) DO UPDATE SET
		prompt_per_1m = excluded.prompt_per_1m, completion_per_1m = excluded.completion_per_1m,
		cache_read_per_1m = excluded.cache_read_per_1m, cache_write_per_1m = excluded.cache_write_per_1m,
		enabled = excluded.enabled, id = excluded.id, effort_multipliers = excluded.effort_multipliers,
		remark = excluded.remark, created_at = excluded.created_at, updated_at = excluded.updated_at`,
);

const drafts = dump(`SELECT row_to_json(x) FROM (
	SELECT id, model, platform, prompt_per1m::text AS prompt_per1m, completion_per1m::text AS completion_per1m,
		cache_read_per1m::text AS cache_read_per1m, cache_write_per1m::text AS cache_write_per1m,
		currency, source_url, checked_date, status, applied_rate_id, remark, created_at, updated_at
	FROM billing_model_rate_drafts) x`);
load(
	"billing_rate_drafts",
	drafts.map((row) => [
		row.id, String(row.model ?? "").toLowerCase(), text(row.platform), text(row.prompt_per1m), text(row.completion_per1m),
		text(row.cache_read_per1m), text(row.cache_write_per1m), text(row.currency) ?? "CNY", text(row.source_url),
		text(row.checked_date), text(row.status) ?? "DRAFT", text(row.applied_rate_id), text(row.remark),
		toMs(row.updated_at) ?? Date.now(), toMs(row.created_at),
	]),
	`INSERT INTO billing_rate_drafts (id, model, platform, prompt_per_1m, completion_per_1m, cache_read_per_1m,
		cache_write_per_1m, currency, source_url, checked_date, status, applied_rate_id, remark, updated_at, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		model = excluded.model, platform = excluded.platform, prompt_per_1m = excluded.prompt_per_1m,
		completion_per_1m = excluded.completion_per_1m, cache_read_per_1m = excluded.cache_read_per_1m,
		cache_write_per_1m = excluded.cache_write_per_1m, currency = excluded.currency, source_url = excluded.source_url,
		checked_date = excluded.checked_date, status = excluded.status, applied_rate_id = excluded.applied_rate_id,
		remark = excluded.remark, updated_at = excluded.updated_at, created_at = excluded.created_at`,
);

const wallets = dump(`SELECT row_to_json(x) FROM (
	SELECT id, member_id, balance::text AS balance, currency, version, created_at, updated_at
	FROM billing_member_wallets) x`);
load(
	"billing_member_wallets",
	wallets.map((row) => [
		row.member_id, yuanToCents(row.balance) ?? 0, toMs(row.updated_at) ?? Date.now(),
		text(row.id), text(row.currency), toMs(row.created_at), row.version ?? null,
	]),
	`INSERT INTO billing_member_wallets (member_id, balance, updated_at, id, currency, created_at, version)
	VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(member_id) DO UPDATE SET
		balance = excluded.balance, updated_at = excluded.updated_at, id = excluded.id,
		currency = excluded.currency, created_at = excluded.created_at, version = excluded.version`,
);

const ledger = dump(`SELECT row_to_json(x) FROM (
	SELECT id, member_id, key_id, request_id, model, amount::text AS amount, reserved_amount::text AS reserved_amount,
		balance_before::text AS balance_before, balance_after::text AS balance_after,
		prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
		prompt_per1m::text AS prompt_per1m, completion_per1m::text AS completion_per1m,
		cache_read_per1m::text AS cache_read_per1m, cache_write_per1m::text AS cache_write_per1m,
		entry_type, status, remark, occurred_at, call_log_id, currency, effort, effort_multiplier::text AS effort_multiplier,
		historical, budget_root_key_id
	FROM billing_ledger_entries) x`);
load(
	"billing_ledger_entries",
	ledger.map((row) => [
		row.id, row.member_id, text(row.key_id), text(row.request_id), row.model ?? "",
		yuanToCents(row.amount) ?? 0, yuanToCents(row.reserved_amount) ?? 0,
		yuanToCents(row.balance_before) ?? 0, yuanToCents(row.balance_after) ?? 0,
		row.prompt_tokens ?? null, row.completion_tokens ?? null, row.cache_read_tokens ?? null, row.cache_write_tokens ?? null,
		yuanToCents(row.prompt_per1m), yuanToCents(row.completion_per1m), yuanToCents(row.cache_read_per1m), yuanToCents(row.cache_write_per1m),
		row.entry_type, row.status, text(row.remark), toMs(row.occurred_at) ?? 0,
		text(row.call_log_id), text(row.currency), text(row.effort), text(row.effort_multiplier),
		row.historical === null || row.historical === undefined ? null : bit(row.historical), text(row.budget_root_key_id),
	]),
	`INSERT INTO billing_ledger_entries (id, member_id, key_id, request_id, model, amount, reserved_amount,
		balance_before, balance_after, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
		prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_write_per_1m, entry_type, status, remark, occurred_at,
		call_log_id, currency, effort, effort_multiplier, historical, budget_root_key_id)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		amount = excluded.amount, reserved_amount = excluded.reserved_amount,
		balance_before = excluded.balance_before, balance_after = excluded.balance_after,
		prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
		cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
		entry_type = excluded.entry_type, status = excluded.status, remark = excluded.remark`,
);

const budgets = dump(`SELECT row_to_json(x) FROM (
	SELECT key_id, admin_total::text AS admin_total, admin_daily::text AS admin_daily, admin_weekly::text AS admin_weekly,
		member_total::text AS member_total, member_daily::text AS member_daily, member_weekly::text AS member_weekly, updated_at
	FROM billing_key_budgets) x`);
load(
	"key_budgets",
	budgets.map((row) => [
		row.key_id, text(row.admin_total), text(row.admin_daily), text(row.admin_weekly),
		text(row.member_total), text(row.member_daily), text(row.member_weekly), toMs(row.updated_at) ?? Date.now(),
	]),
	`INSERT INTO key_budgets (key_id, admin_total, admin_daily, admin_weekly, member_total, member_daily, member_weekly, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(key_id) DO UPDATE SET
		admin_total = excluded.admin_total, admin_daily = excluded.admin_daily, admin_weekly = excluded.admin_weekly,
		member_total = excluded.member_total, member_daily = excluded.member_daily, member_weekly = excluded.member_weekly,
		updated_at = excluded.updated_at`,
);

const checkins = dump("SELECT row_to_json(t) FROM check_in_records t");
load(
	"check_in_records",
	checkins.map((row) => [
		row.id, row.account_id, row.account_name, row.platform, row.status, text(row.message),
		row.credits ?? null, text(row.detail), toMs(row.occurred_at) ?? 0,
	]),
	`INSERT INTO check_in_records (id, account_id, account_name, platform, status, message, credits, detail, occurred_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		account_id = excluded.account_id, account_name = excluded.account_name, platform = excluded.platform,
		status = excluded.status, message = excluded.message, credits = excluded.credits, detail = excluded.detail,
		occurred_at = excluded.occurred_at`,
);

const logs = dump(`SELECT row_to_json(x) FROM (
	SELECT id, key_id, account_id, platform, model, effective_model, prompt_tokens, completion_tokens, total_tokens,
		cache_read_tokens, cache_write_tokens, latency_ms, status, message, client_ip, request_id, usage_source,
		error_category, occurred_at, capability_decision, credit_cost::text AS credit_cost,
		credits_after::text AS credits_after, credits_before::text AS credits_before, route_attempts
	FROM gateway_call_logs) x`);
load(
	"gateway_call_logs",
	logs.map((row) => [
		row.id, text(row.key_id), text(row.account_id), text(row.platform), text(row.model), text(row.effective_model),
		row.prompt_tokens ?? null, row.completion_tokens ?? null, row.total_tokens ?? null,
		row.cache_read_tokens ?? null, row.cache_write_tokens ?? null, row.latency_ms ?? null,
		row.status, text(row.message), text(row.client_ip), text(row.request_id), text(row.usage_source),
		text(row.error_category), toMs(row.occurred_at) ?? 0, text(row.capability_decision), text(row.credit_cost),
		text(row.credits_after), text(row.credits_before), text(row.route_attempts),
	]),
	`INSERT INTO gateway_call_logs (id, key_id, account_id, platform, model, effective_model, prompt_tokens,
		completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens, latency_ms, status, message, client_ip,
		request_id, usage_source, error_category, occurred_at, capability_decision, credit_cost, credits_after,
		credits_before, route_attempts)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		status = excluded.status, message = excluded.message, prompt_tokens = excluded.prompt_tokens,
		completion_tokens = excluded.completion_tokens, total_tokens = excluded.total_tokens,
		credit_cost = excluded.credit_cost, credits_after = excluded.credits_after, credits_before = excluded.credits_before`,
);

const trae = dump("SELECT row_to_json(t) FROM trae_account_model_snapshots t");
load(
	"trae_account_model_snapshots",
	trae.map((row) => [row.account_id, text(row.model_functions) ?? "{}", text(row.model_context_windows), text(row.model_max_output_tokens), toMs(row.synced_at)]),
	`INSERT INTO trae_account_model_snapshots (account_id, model_functions, model_context_windows, model_max_output_tokens, synced_at)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(account_id) DO UPDATE SET
		model_functions = excluded.model_functions, model_context_windows = excluded.model_context_windows,
		model_max_output_tokens = excluded.model_max_output_tokens, synced_at = excluded.synced_at`,
);

const workbuddy = dump("SELECT row_to_json(t) FROM workbuddy_account_model_snapshots t");
load(
	"workbuddy_account_model_snapshots",
	workbuddy.map((row) => [
		row.account_id, text(row.model_ids) ?? "[]", text(row.context_windows), text(row.max_output_tokens),
		text(row.reasoning_efforts), toMs(row.synced_at),
	]),
	`INSERT INTO workbuddy_account_model_snapshots (account_id, model_ids, context_windows, max_output_tokens, reasoning_efforts, synced_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(account_id) DO UPDATE SET
		model_ids = excluded.model_ids, context_windows = excluded.context_windows,
		max_output_tokens = excluded.max_output_tokens, reasoning_efforts = excluded.reasoning_efforts, synced_at = excluded.synced_at`,
);

db.exec("PRAGMA foreign_keys = ON");

const sourceAccounts = dump(`SELECT row_to_json(x) FROM (
	SELECT id, name, platform, enabled, octet_length(credentials) AS credential_bytes,
		credential_status, (credits IS NOT NULL) AS has_credits
	FROM accounts) x`);
const localAccounts = db.prepare(`SELECT id, name, platform, enabled, length(credentials) AS credential_bytes,
	credential_status, (credits IS NOT NULL) AS has_credits FROM accounts`).all();
const localById = new Map(localAccounts.map((row) => [row.id, row]));
const mismatches = [];
for (const source of sourceAccounts) {
	const local = localById.get(source.id);
	if (local === undefined) {
		mismatches.push(`${source.name}/${source.platform} 缺失`);
		continue;
	}
	const same =
		local.name === source.name &&
		local.platform === source.platform &&
		Number(local.enabled) === (source.enabled ? 1 : 0) &&
		Number(local.credential_bytes) === Number(source.credential_bytes);
	if (!same) mismatches.push(`${source.name}/${source.platform} 字段不一致`);
}
const platforms = {};
for (const row of localAccounts) platforms[row.platform] = (platforms[row.platform] ?? 0) + 1;

const counts = {};
for (const table of Object.keys(summary)) {
	counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}
db.close();

console.log(JSON.stringify({ imported: summary, stored: counts, platforms, accountMismatches: mismatches }, null, 2));
