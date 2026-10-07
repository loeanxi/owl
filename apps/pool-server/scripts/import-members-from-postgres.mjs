/**
 * 从正在跑的 manager Postgres 把 members 行搬进 pool.db。
 * 只在控制台打印用户名和是否启用，不打印 salt / 哈希。
 *
 * 用法（在 apps/pool-server 下）:
 *   node scripts/import-members-from-postgres.mjs
 *   node scripts/import-members-from-postgres.mjs data/pool.db
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const dbPath = resolve(process.argv[2] ?? "data/pool.db");
const dumped = spawnSync(
	"docker",
	[
		"exec",
		"manager-postgres-1",
		"psql",
		"-U",
		"manager",
		"-d",
		"manager",
		"-t",
		"-A",
		"-c",
		`SELECT COALESCE(json_agg(json_build_object(
			'id', id,
			'username', username,
			'display_name', display_name,
			'enabled', enabled,
			'max_concurrent_requests', max_concurrent_requests,
			'created_at', (EXTRACT(EPOCH FROM created_at) * 1000)::bigint,
			'updated_at', (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint,
			'password_salt', password_salt,
			'password_hash', password_hash
		)), '[]'::json) FROM members`,
	],
	{ encoding: "utf8" },
);
if (dumped.status !== 0) {
	console.error(dumped.stderr || "读取 Postgres members 失败");
	process.exit(1);
}

const rows = JSON.parse(dumped.stdout);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
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
const insert = db.prepare(`
	INSERT INTO members (id, username, display_name, password_salt, password_hash, enabled,
		max_concurrent_requests, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		username = excluded.username, display_name = excluded.display_name,
		password_salt = excluded.password_salt, password_hash = excluded.password_hash,
		enabled = excluded.enabled, max_concurrent_requests = excluded.max_concurrent_requests,
		updated_at = excluded.updated_at
`);
const imported = [];
for (const row of rows) {
	insert.run(
		row.id,
		String(row.username).trim().toLowerCase(),
		row.display_name,
		row.password_salt,
		row.password_hash,
		row.enabled === true || row.enabled === "t" ? 1 : 0,
		row.max_concurrent_requests,
		Number(row.created_at),
		Number(row.updated_at),
	);
	imported.push({ username: String(row.username).trim().toLowerCase(), enabled: row.enabled === true || row.enabled === "t" });
}
const linked = db
	.prepare(`
		SELECT m.username AS username, COUNT(k.id) AS keys
		FROM members m
		LEFT JOIN api_keys k ON k.owner_member_id = m.id
		GROUP BY m.username
		ORDER BY m.username
	`)
	.all();
db.close();
console.log(JSON.stringify({ db: dbPath, count: imported.length, members: imported, keys: linked }));
