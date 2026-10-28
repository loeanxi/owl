import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DiffApprovalStore } from "../../src/core/diff-approval/store.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";

let cwd: string;
let file: string;
let storePath: string;
let store: DiffApprovalStore;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "owl-approval-cache-"));
	file = join(cwd, "file.txt");
	storePath = join(cwd, "approval.json");
	store = new DiffApprovalStore({ filePath: storePath, workspaceDir: cwd });
	store.load();
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function capture(before: string, after: string): Promise<string> {
	writeFileSync(file, before);
	const input = { path: file, content: after };
	store.stage("write", file, { sessionId: "session", turnId: "turn", toolName: "write", input });
	store.recordMutationBefore("session:write", after);
	await createWriteTool(cwd).execute("write", input);
	store.commit("write", false, "session");
	return store.list(cwd)[0]!.id;
}

it("keeps the in-memory copy when the store file has not changed", async () => {
	const id = await capture("original\n", "agent\n");
	const before = statSync(storePath).mtimeMs;
	// 反复读接口不再把整个文件读一遍：文件指纹没变就复用内存副本。
	expect(store.list(cwd)).toHaveLength(1);
	expect(store.diff(id).diff).toContain("+agent");
	expect(store.diff(id).diff).toContain("-original");
	expect(statSync(storePath).mtimeMs).toBe(before);
});

it("picks up an external write to the store file", async () => {
	const id = await capture("original\n", "agent\n");
	const raw = JSON.parse(readFileSync(storePath, "utf8")) as { entries: Array<Record<string, unknown>> };
	raw.entries.push({ ...raw.entries[0]!, id: "external-entry", path: join(cwd, "other.txt") });
	writeFileSync(storePath, JSON.stringify(raw));
	// 文件变了：下一次读接口必须重新读盘，不能停在旧副本上。
	expect(store.list(cwd).map((row) => row.id)).toContain("external-entry");
	expect(store.list(cwd)).toHaveLength(2);
	expect(store.diff(id)).toBeTruthy();
});

it("returns a batch of diffs in one pass and reports per-entry failures", async () => {
	const first = await capture("original\n", "one\n");
	const second = await capture("original\n", "two\n");
	const results = store.diffs([first, second, "missing-entry"]);
	expect(results).toHaveLength(3);
	expect(results[0]!.diff).toContain("+one");
	expect(results[1]!.diff).toContain("+two");
	expect(results[2]!.error).toContain("Unknown diff-approval entry");
	expect(results[0]!.error).toBeUndefined();
});

it("keeps the snapshot body out of the metadata file", async () => {
	const id = await capture("original\n", "alpha\n");
	const metadata = readFileSync(storePath, "utf8");
	// 元数据里没有正文：正文在独立快照文件里。
	expect(metadata).not.toContain("original\\n");
	expect(metadata).not.toContain("alpha\\n");
	expect(metadata.length).toBeLessThan(2000);
	// 快照文件单独存在，正文齐全。
	const snapshotPath = `${storePath}.snaps/${id.slice(0, 2)}/${id}.json`;
	expect(existsSync(snapshotPath)).toBe(true);
	const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { before: string; after: string };
	expect(snapshot.before).toBe("original\n");
	expect(snapshot.after).toBe("alpha\n");
	// 增删行数在建条目时就算好，列表面板不必再读快照。
	expect(store.list(cwd)[0]!.added).toBe(1);
	expect(store.list(cwd)[0]!.removed).toBe(1);
});

it("migrates a legacy inline store to the split layout", async () => {
	mkdirSync(join(cwd, "store"), { recursive: true });
	const legacyPath = join(cwd, "store", "legacy.json");
	writeFileSync(
		legacyPath,
		JSON.stringify({
			version: 1,
			workspaceDir: cwd,
			entries: [
				{
					id: "legacy",
					path: file,
					status: "pending",
					originalExisted: true,
					originalContent: "very old\n",
					baselineAt: "2026-01-01T00:00:00Z",
					resolvedAt: null,
				},
			],
		}),
	);
	const legacy = new DiffApprovalStore({ filePath: legacyPath, workspaceDir: cwd });
	legacy.load();
	// 旧记录照样看得见，但只能人工核对（没有改后快照、没有归属）。
	expect(legacy.list(cwd)[0]).toMatchObject({ id: "legacy", scope: "legacy", revertible: false });
	// 迁移后：元数据是新的，正文进了独立文件。
	const migrated = JSON.parse(readFileSync(legacyPath, "utf8")) as {
		version: number;
		entries: Array<{ hasBefore: boolean }>;
	};
	expect(migrated.version).toBe(3);
	expect(migrated.entries[0]!.hasBefore).toBe(true);
	const snapshotPath = `${legacyPath}.snaps/le/legacy.json`;
	expect(existsSync(snapshotPath)).toBe(true);
	expect((JSON.parse(readFileSync(snapshotPath, "utf8")) as { before: string }).before).toBe("very old\n");
});

it("keeps the legacy file in place when the migration cannot finish", async () => {
	const legacyPath = join(cwd, "legacy.json");
	const legacyBody = JSON.stringify({
		version: 1,
		workspaceDir: cwd,
		entries: [
			{
				id: "legacy",
				path: file,
				status: "pending",
				originalExisted: true,
				originalContent: "very old\n",
				baselineAt: "2026-01-01T00:00:00Z",
				resolvedAt: null,
			},
		],
	});
	writeFileSync(legacyPath, legacyBody);
	// 把快照目录占成文件：迁移必然失败。
	writeFileSync(`${legacyPath}.snaps`, "blocked");
	const legacy = new DiffApprovalStore({ filePath: legacyPath, workspaceDir: cwd });
	legacy.load();
	// 迁移失败不能动原文件：旧记录还在，内容一字未改。
	expect(readFileSync(legacyPath, "utf8")).toBe(legacyBody);
	expect(legacy.list(cwd)[0]).toMatchObject({ id: "legacy" });
});

it("drops the snapshot body once an entry is resolved", async () => {
	const id = await capture("original\n", "agent\n");
	const snapshotPath = `${storePath}.snaps/${id.slice(0, 2)}/${id}.json`;
	expect(existsSync(snapshotPath)).toBe(true);
	await store.resolve([id], "keep");
	// 条目还在（历史可见），但正文不再占磁盘。
	expect(store.list(cwd)[0]).toMatchObject({ id, status: "kept" });
	expect(existsSync(snapshotPath)).toBe(false);
});
