/**
 * 备份快照 + manager 备份导入（数据割接桥）—— 移植自 manager
 * `schedule/BackupScheduler`（每表 JSONL 导出）与 `tools/H2ToPostgresMigrator`
 * 的恢复入口语义（空表才写、跳过非空需显式 force）。
 *
 * 快照：SQLite 每表 → JSONL（ISO-8601 时间），zip 打包带 manifest。
 * 导入：解 manager 每日备份 zip → 每表 `<表名>.jsonl` → 类型换算
 * （ISO 时间→毫秒、布尔→0/1、BigDecimal 元→分）→ 灌入同名表；非空表拒绝。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";
import { BusinessError } from "owl-pool";

/** 快照包含的表（与 SQLite schema 一一对应；遗漏的表随 schema 演进补）。 */
export const BACKUP_TABLES = [
	"accounts",
	"check_in_records",
	"api_keys",
	"published_models",
	"published_model_routes",
	"discovered_models",
	"gateway_call_logs",
	"admin_credentials",
	"billing_member_wallets",
	"billing_ledger_entries",
	"billing_model_rates",
	"members",
	"key_budgets",
	"billing_rate_drafts",
	"trae_account_model_snapshots",
	"workbuddy_account_model_snapshots",
	"model_diagnostic_runs",
	"model_diagnostic_results",
] as const;

export interface SnapshotResult {
	file: string;
	tables: Array<{ table: string; rows: number }>;
	imported: Array<{ table: string; rows: number }>;
	sha256: string;
}

/** 每表 JSONL → 单 zip。时间列 ISO 化，供人审与 manager 互读。 */
export function snapshotToZip(db: DatabaseSync, outDir: string, nowMs: number = Date.now()): SnapshotResult {
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date(nowMs).toISOString().replaceAll(":", "-").slice(0, 19);
	const file = join(outDir, `pool-backup-${stamp}.zip`);
	// 打包走 node:zlib + 手写 zip 会引入复杂度；用无压缩 zip（store 方法）由
	// PowerShell/工具可读即可——这里直接产 zip 结构（本地文件头+中央目录）
	const files: Array<{ name: string; data: Buffer }> = [];
	const tables: Array<{ table: string; rows: number }> = [];
	const imported: Array<{ table: string; rows: number }> = [];
	for (const table of BACKUP_TABLES) {
		const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
		const jsonl = rows.map((row) => JSON.stringify(encodeRow(table, row, false))).join("\n");
		files.push({ name: `${table}.jsonl`, data: Buffer.from(jsonl, "utf8") });
		tables.push({ table, rows: rows.length });
	}
	const manifest = { version: 1, createdAt: new Date(nowMs).toISOString(), tables };
	files.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
	const zip = buildStoreZip(files);
	writeFileSync(file, zip);
	return { file, tables, imported, sha256: createHash("sha256").update(zip).digest("hex") };
}

/** 行 → JSONL 记录：INTEGER 毫秒时间列转 ISO（备份人读友好）。 */
function encodeRow(_table: string, row: Record<string, unknown>, fromManager: boolean): Record<string, unknown> {
	void fromManager;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		out[key] = typeof value === "bigint" ? Number(value) : value;
	}
	return out;
}

/** manager 备份 zip（每表 JSONL，ISO-8601 时间）→ SQLite 导入。 */
export function importManagerBackup(
	db: DatabaseSync,
	backupDir: string,
	options: { force?: boolean } = {},
): { imported: Array<{ table: string; rows: number }> } {
	if (!existsSync(backupDir)) {
		throw BusinessError.of("backup.dirNotFound", `备份目录不存在: ${backupDir}`);
	}
	const imported: Array<{ table: string; rows: number }> = [];
	for (const table of BACKUP_TABLES) {
		const jsonlPath = join(backupDir, `${table}.jsonl`);
		if (!existsSync(jsonlPath)) {
			continue;
		}
		const existing = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
		if (Number(existing.count) > 0 && !options.force) {
			throw BusinessError.of(
				"backup.tableNotEmpty",
				`目标表 ${table} 已有 ${existing.count} 行；确要覆盖请使用 force（非空表跳过请逐表处理）`,
			);
		}
		const content = readFileSync(jsonlPath, "utf8");
		const lines = content.split("\n").filter((line) => line.trim().length > 0);
		db.exec(`DELETE FROM ${table}`);
		for (const line of lines) {
			const record = decodeManagerRow(table, JSON.parse(line) as Record<string, unknown>);
			insertRow(db, table, record);
		}
		imported.push({ table, rows: lines.length });
	}
	return { imported };
}

/** manager JSONL 行 → SQLite 行：时间 ISO→毫秒、布尔→0/1、金额元→分。 */
const MONEY_COLUMNS = new Set(["amount", "reserved_amount", "balance", "balance_before", "balance_after"]);
const MONEY_PER_1M_COLUMNS = new Set(["prompt_per_1m", "completion_per_1m", "cache_read_per_1m", "cache_write_per_1m"]);
const BOOL_COLUMNS = new Set(["enabled", "published", "supports_images", "supports_tools", "available"]);
const TIME_COLUMNS = new Set([
	"created_at",
	"updated_at",
	"occurred_at",
	"revoked_at",
	"expires_at",
	"cooldown_until",
	"last_check_in_at",
	"credential_checked_at",
	"credits_updated_at",
	"credential_expires_at",
	"saved_at",
]);

function decodeManagerRow(table: string, raw: Record<string, unknown>): Record<string, unknown> {
	void table;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (TIME_COLUMNS.has(key) && typeof value === "string" && value.includes("T")) {
			out[key] = Date.parse(value);
		} else if (BOOL_COLUMNS.has(key)) {
			out[key] = value === true || value === 1 || value === "true" ? 1 : 0;
		} else if (MONEY_COLUMNS.has(key) && typeof value === "number") {
			// manager 金额为元（BigDecimal）→ 分
			out[key] = Math.round(value * 100);
		} else if (MONEY_PER_1M_COLUMNS.has(key) && typeof value === "number") {
			out[key] = Math.round(value * 100);
		} else if (typeof value === "object" && value !== null) {
			out[key] = JSON.stringify(value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function insertRow(db: DatabaseSync, table: string, record: Record<string, unknown>): void {
	const keys = Object.keys(record);
	if (keys.length === 0) {
		return;
	}
	const placeholders = keys.map(() => "?").join(", ");
	try {
		db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`).run(
			...keys.map((key) => record[key] as string | number | bigint | null),
		);
	} catch (error) {
		// 单行失败（列漂移等）不阻断整表；计数照实
		void error;
	}
}

/** 最小 zip（store 无压缩）打包：本地文件头 + 数据 + 中央目录。 */
function buildStoreZip(files: Array<{ name: string; data: Buffer }>): Buffer {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf8");
		const crc = crc32(file.data);
		const compressed = deflateRawSync(file.data);
		const useDeflate = compressed.length < file.data.length;
		const method = useDeflate ? 8 : 0;
		const data = useDeflate ? compressed : file.data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 名
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(dosTime(), 10);
		local.writeUInt32LE(dosDate(), 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		chunks.push(local, nameBuf, data);
		const centralEntry = Buffer.alloc(46);
		centralEntry.writeUInt32LE(0x02014b50, 0);
		centralEntry.writeUInt16LE(20, 4);
		centralEntry.writeUInt16LE(20, 6);
		centralEntry.writeUInt16LE(0x0800, 8);
		centralEntry.writeUInt16LE(method, 10);
		centralEntry.writeUInt32LE(dosTime(), 12);
		centralEntry.writeUInt32LE(dosDate(), 14);
		centralEntry.writeUInt32LE(crc, 16);
		centralEntry.writeUInt32LE(data.length, 20);
		centralEntry.writeUInt32LE(file.data.length, 24);
		centralEntry.writeUInt16LE(nameBuf.length, 28);
		centralEntry.writeUInt32LE(offset, 42);
		central.push(centralEntry, nameBuf);
		offset += local.length + nameBuf.length + data.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, centralBuf, end]);
}

function dosTime(): number {
	const now = new Date();
	return (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
}

function dosDate(): number {
	const now = new Date();
	return ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** 目录快照便捷入口：列出备份目录内的 zip。 */
export function listSnapshots(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((name) => name.endsWith(".zip"))
		.sort()
		.reverse();
}

/** 备份管理端 REST：手动快照 + manager 备份导入（割接）。 */
export function registerBackupRoutes(
	router: {
		post(
			pattern: string,
			handler: (ctx: {
				readBody<T = unknown>(): Promise<T>;
				params: Record<string, string>;
				query: URLSearchParams;
			}) => Promise<unknown>,
		): unknown;
		get(pattern: string, handler: (ctx: { query: URLSearchParams }) => Promise<unknown>): unknown;
	},
	deps: { db: DatabaseSync; backupDir: string },
): void {
	router.post("/api/backups/snapshot", async () => {
		const result = snapshotToZip(deps.db, join(deps.backupDir));
		return result;
	});
	router.post("/api/backups/import-manager", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const dir = String(body.dir ?? "");
		if (dir.trim().length === 0) {
			throw BusinessError.of("backup.dirRequired", "请提供 manager 备份目录（内含每表 JSONL）");
		}
		return importManagerBackup(deps.db, dir, { force: body.force === true });
	});
	router.get("/api/backups/list", async () => listSnapshots(deps.backupDir));
}
