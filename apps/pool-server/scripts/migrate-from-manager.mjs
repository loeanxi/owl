/**
 * manager → owl 一次性数据迁移脚本。
 * 读取 PG 导出的 JSON 文件，转换后灌入 owl 的 SQLite。
 * 用法：node migrate-data.js <pg_export_dir> <pool_db_path>
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [exportDir, dbPath] = process.argv.slice(2);
if (!exportDir || !dbPath) {
	console.error("用法: node migrate-data.js <pg_export_dir> <pool_db_path>");
	process.exit(1);
}
if (!existsSync(dbPath)) {
	console.error(`数据库不存在: ${dbPath}`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = OFF"); // 导入期间关外键

function readJson(table) {
	const file = resolve(exportDir, `${table}.json`);
	if (!existsSync(file)) return [];
	return JSON.parse(readFileSync(file, "utf8"));
}

function toMs(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return value;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function toBool(value) {
	return value === true || value === 1 || value === "true" ? 1 : 0;
}

function toCents(value) {
	if (value === null || value === undefined) return null;
	return Math.round(Number(value) * 100);
}

function toJson(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function text(value) { return value === null || value === undefined ? null : String(value); }
function num(value) { return value === null || value === undefined ? null : Number(value); }

// ── accounts ──
const accounts = readJson("accounts");
const insAccount = db.prepare(`
	INSERT INTO accounts (id, name, platform, credentials, session_generation, trae_session_hash,
		enabled, remark, last_check_in_at, last_check_in_status, last_check_in_message,
		credits, credits_label, credits_status, credits_message, credits_details, credits_updated_at,
		credential_expires_at, credential_status, credential_checked_at, credential_message,
		cooldown_until, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name = excluded.name, credentials = excluded.credentials, enabled = excluded.enabled,
		credits = excluded.credits, credits_label = excluded.credits_label,
		credits_status = excluded.credits_status, credits_updated_at = excluded.credits_updated_at,
		credential_status = excluded.credential_status, credential_expires_at = excluded.credential_expires_at,
		credential_checked_at = excluded.credential_checked_at, credential_message = excluded.credential_message,
		last_check_in_at = excluded.last_check_in_at, last_check_in_status = excluded.last_check_in_status,
		last_check_in_message = excluded.last_check_in_message, updated_at = excluded.updated_at
`);
let accountCount = 0;
for (const a of accounts) {
	insAccount.run(
		a.id, a.name, a.platform, text(a.credentials), a.session_generation, text(a.trae_session_hash),
		toBool(a.enabled), text(a.remark), toMs(a.last_check_in_at), text(a.last_check_in_status), text(a.last_check_in_message),
		num(a.credits), text(a.credits_label), text(a.credits_status), text(a.credits_message), text(a.credits_details), toMs(a.credits_updated_at),
		toMs(a.credential_expires_at), text(a.credential_status), toMs(a.credential_checked_at), text(a.credential_message),
		toMs(a.cooldown_until), toMs(a.created_at) ?? 0, toMs(a.updated_at) ?? 0,
	);
	accountCount++;
}
console.log(`accounts: ${accountCount} 行`);

// ── api_keys ──
const apiKeys = readJson("api_keys");
const insKey = db.prepare(`
	INSERT INTO api_keys (id, name, key_prefix, key_suffix, key_hash, owner_member_id, parent_key_id,
		revoked_at, bound_platform, allowed_models, effort_policy, allowed_ips, rate_limit_per_minute,
		enabled, created_at, expires_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name = excluded.name, key_hash = excluded.key_hash, enabled = excluded.enabled,
		revoked_at = excluded.revoked_at, bound_platform = excluded.bound_platform,
		allowed_models = excluded.allowed_models, allowed_ips = excluded.allowed_ips,
		rate_limit_per_minute = excluded.rate_limit_per_minute, expires_at = excluded.expires_at
`);
let keyCount = 0;
for (const k of apiKeys) {
	insKey.run(
		k.id, k.name, text(k.key_prefix), text(k.key_suffix), k.key_hash,
		text(k.owner_member_id), text(k.parent_key_id), toMs(k.revoked_at),
		text(k.bound_platform), toJson(k.allowed_models), toJson(k.effort_policy),
		text(k.allowed_ips), k.rate_limit_per_minute, toBool(k.enabled),
		toMs(k.created_at) ?? 0, toMs(k.expires_at),
	);
	keyCount++;
}
console.log(`api_keys: ${keyCount} 行`);

// ── published_models ──
const models = readJson("published_models");
const insModel = db.prepare(`
	INSERT INTO published_models (id, public_id, name, description, model_version, context_window,
		default_context_window, default_reasoning_effort, max_output_tokens, supports_images,
		supports_tools, reasoning_efforts, published, sort_order, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		public_id = excluded.public_id, name = excluded.name, description = excluded.description,
		model_version = excluded.model_version, context_window = excluded.context_window,
		default_context_window = excluded.default_context_window,
		default_reasoning_effort = excluded.default_reasoning_effort,
		max_output_tokens = excluded.max_output_tokens, supports_images = excluded.supports_images,
		supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts,
		published = excluded.published, sort_order = excluded.sort_order, updated_at = excluded.updated_at
`);
let modelCount = 0;
for (const m of models) {
	insModel.run(
		m.id, m.public_id, m.name, text(m.description), text(m.model_version),
		m.context_window, m.default_context_window, text(m.default_reasoning_effort),
		m.max_output_tokens, toBool(m.supports_images), toBool(m.supports_tools),
		typeof m.reasoning_efforts === "string" ? m.reasoning_efforts : JSON.stringify(m.reasoning_efforts || []),
		toBool(m.published), m.sort_order ?? 0, toMs(m.updated_at) ?? Date.now(),
	);
	modelCount++;
}
console.log(`published_models: ${modelCount} 行`);

// ── published_model_routes ──
const routes = readJson("published_model_routes");
const insRoute = db.prepare(`
	INSERT INTO published_model_routes (id, model_id, platform, upstream_model, priority, enabled,
		supports_images, supports_tools, reasoning_efforts)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		model_id = excluded.model_id, platform = excluded.platform,
		upstream_model = excluded.upstream_model, priority = excluded.priority,
		enabled = excluded.enabled, supports_images = excluded.supports_images,
		supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts
`);
let routeCount = 0;
for (const r of routes) {
	insRoute.run(
		r.id, r.published_model_id, r.platform, r.upstream_model, r.priority,
		toBool(r.enabled), toBool(r.supports_images), toBool(r.supports_tools),
		typeof r.reasoning_efforts === "string" ? r.reasoning_efforts : JSON.stringify(r.reasoning_efforts || []),
	);
	routeCount++;
}
console.log(`published_model_routes: ${routeCount} 行`);

// ── billing_model_rates ──
const rates = readJson("billing_model_rates");
const insRate = db.prepare(`
	INSERT INTO billing_model_rates (model, prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_write_per_1m, enabled)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(model) DO UPDATE SET
		prompt_per_1m = excluded.prompt_per_1m, completion_per_1m = excluded.completion_per_1m,
		cache_read_per_1m = excluded.cache_read_per_1m, cache_write_per_1m = excluded.cache_write_per_1m,
		enabled = excluded.enabled
`);
let rateCount = 0;
for (const r of rates) {
	insRate.run(r.model, toCents(r.prompt_per1m) ?? 0, toCents(r.completion_per1m) ?? 0, toCents(r.cache_read_per1m) ?? 0, toCents(r.cache_write_per1m) ?? 0, toBool(r.enabled));
	rateCount++;
}
console.log(`billing_model_rates: ${rateCount} 行`);

// ── discovered_models ──
const discovered = readJson("discovered_models");
const insDiscovered = db.prepare(`
	INSERT INTO discovered_models (platform, upstream_model, available, context_window, max_output_tokens, updated_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(platform, upstream_model) DO UPDATE SET
		available = excluded.available, context_window = excluded.context_window,
		max_output_tokens = excluded.max_output_tokens, updated_at = excluded.updated_at
`);
let discoveredCount = 0;
for (const d of discovered) {
	insDiscovered.run(d.platform, d.upstream_model, toBool(d.available), d.context_window, d.max_output_tokens, toMs(d.last_seen_at) ?? Date.now());
	discoveredCount++;
}
console.log(`discovered_models: ${discoveredCount} 行`);

// ── admin_credentials（单行；不迁则管理台会要求重新设密，旧口令失效）──
const credentials = readJson("admin_credentials");
const insCredential = db.prepare(`
	INSERT INTO admin_credentials (id, username, salt, password_hash, source_fingerprint, updated_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		username = excluded.username, salt = excluded.salt, password_hash = excluded.password_hash,
		source_fingerprint = excluded.source_fingerprint, updated_at = excluded.updated_at
`);
let credentialCount = 0;
for (const c of credentials) {
	insCredential.run(
		c.id ?? "default",
		c.username,
		c.salt,
		c.password_hash,
		text(c.source_fingerprint) ?? "",
		toMs(c.updated_at) ?? Date.now(),
	);
	credentialCount++;
}
console.log(`admin_credentials: ${credentialCount} 行`);

// ── members（口令哈希原样搬入，算法与 admin 相同）──
db.exec(`
CREATE TABLE IF NOT EXISTS members (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	password_salt TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	max_concurrent_requests INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`);
const members = readJson("members");
const insMember = db.prepare(`
	INSERT INTO members (id, username, display_name, password_salt, password_hash, enabled,
		max_concurrent_requests, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		username = excluded.username, display_name = excluded.display_name,
		password_salt = excluded.password_salt, password_hash = excluded.password_hash,
		enabled = excluded.enabled, max_concurrent_requests = excluded.max_concurrent_requests,
		updated_at = excluded.updated_at
`);
let memberCount = 0;
for (const member of members) {
	insMember.run(
		member.id,
		String(member.username ?? "").trim().toLowerCase(),
		member.display_name,
		member.password_salt,
		member.password_hash,
		toBool(member.enabled),
		member.max_concurrent_requests ?? null,
		toMs(member.created_at) ?? Date.now(),
		toMs(member.updated_at) ?? Date.now(),
	);
	memberCount++;
}
console.log(`members: ${memberCount} 行`);

db.exec("PRAGMA foreign_keys = ON");
db.close();
console.log("\n✅ 数据迁移完成");
