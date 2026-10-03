import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeRuntime } from "../src/runtime.ts";
import { assertInside, isRecord, requiredString } from "../src/runtime-paths.ts";

const assetRoot = process.env.OWL_UNIVER_RUNTIME_ROOT;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(): Promise<{ runtime: OfficeRuntime; cwd: string; worktreeId: string; unitId: string }> {
	if (!assetRoot) throw new Error("Set OWL_UNIVER_RUNTIME_ROOT to the installed pinned runtime package.");
	const cwd = await mkdtemp(join(tmpdir(), "owl-office-cache-"));
	cleanup.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = new OfficeRuntime({ assetRoot });
	cleanup.push(() => runtime.dispose());
	await writeFile(join(cwd, "source.csv"), "name,value\nalpha,1\nbeta,2\n");
	await runtime.call("new", { file: "book.univer" }, cwd);
	const tree = await runtime.call("worktree", { file: "book.univer", action: "create" }, cwd);
	const worktreeId = requiredString(tree.worktreeId, "worktreeId");
	const imported = await runtime.call(
		"import",
		{ file: "book.univer", worktreeId, source: "source.csv", name: "Original" },
		cwd,
	);
	const unitId = requiredString(imported.unitId, "unitId");
	await runtime.call("export", { file: "book.univer", worktreeId, unitId, output: "source.xlsx" }, cwd);
	return { runtime, cwd, worktreeId, unitId };
}

async function opened(
	runtime: OfficeRuntime,
	cwd: string,
): Promise<{ file: string; cookie: string; location: string }> {
	const result = await runtime.open({ cwd, path: "source.xlsx" });
	const response = await fetch(result.url, { redirect: "manual" });
	expect(response.status).toBe(303);
	const location = response.headers.get("location") ?? "";
	const key = new URL(location, result.url).searchParams.get("file");
	if (!key) throw new Error("Office bootstrap did not identify its working copy.");
	const file = Buffer.from(key, "base64url").toString("utf8");
	assertInside(cwd, file);
	return { file, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", location };
}

describe.skipIf(!assetRoot)("pinned runtime working-copy cache", () => {
	it("discovers draft Units and keeps the edited working copy across concurrent opens and 40 refreshes", async () => {
		const { runtime, cwd, unitId } = await fixture();
		const status = await runtime.call("status", { file: "book.univer" }, cwd);
		expect(JSON.stringify(status)).toContain(unitId);
		const originalBytes = await readFile(join(cwd, "source.xlsx"));
		const [first, concurrent] = await Promise.all([opened(runtime, cwd), opened(runtime, cwd)]);
		expect(concurrent.file).toBe(first.file);
		expect(concurrent.cookie).toBe(first.cookie);
		const importedStatus = await runtime.call("status", { file: first.file }, cwd);
		if (
			!isRecord(importedStatus.result) ||
			!isRecord(importedStatus.result.trunk) ||
			!Array.isArray(importedStatus.result.trunk.units)
		)
			throw new Error("Missing imported Units");
		const unit = importedStatus.result.trunk.units[0];
		if (!isRecord(unit)) throw new Error("Missing imported Unit");
		const importedId = requiredString(unit.unitId, "unitId");
		const tree = await runtime.call("worktree", { file: first.file, action: "create" }, cwd);
		await runtime.call(
			"execute",
			{
				file: first.file,
				worktreeId: tree.worktreeId,
				unitId: importedId,
				code: 'workbook.getActiveSheet().getRange("B2").setValue({v:42,t:2}); return 42;',
			},
			cwd,
		);
		await runtime.call("worktree", { file: first.file, worktreeId: tree.worktreeId, action: "ready" }, cwd);
		await runtime.call(
			"worktree",
			{ file: first.file, worktreeId: tree.worktreeId, action: "merge", userConfirmed: true },
			cwd,
		);
		for (let index = 0; index < 40; index++) {
			const refresh = await opened(runtime, cwd);
			expect(refresh.file).toBe(first.file);
			expect(refresh.cookie).toBe(first.cookie);
		}
		expect(
			JSON.stringify(await runtime.call("inspect", { file: first.file, unitId: importedId, range: "B2" }, cwd)),
		).toContain("42");
		expect((await readdir(join(cwd, ".owl", "office"))).filter((name) => name.endsWith(".univer"))).toHaveLength(1);
		expect(await readFile(join(cwd, "source.xlsx"))).toEqual(originalBytes);
	}, 60_000);

	it("creates a new baseline after source content changes without replacing the old working copy", async () => {
		const { runtime, cwd, worktreeId, unitId } = await fixture();
		const first = await opened(runtime, cwd);
		await runtime.call(
			"execute",
			{
				file: "book.univer",
				worktreeId,
				unitId,
				code: 'workbook.getActiveSheet().getRange("B2").setValue({v:99,t:2}); return 99;',
			},
			cwd,
		);
		await runtime.call("export", { file: "book.univer", worktreeId, unitId, output: "changed.xlsx" }, cwd);
		await copyFile(join(cwd, "changed.xlsx"), join(cwd, "source.xlsx"));
		const changed = await opened(runtime, cwd);
		expect(changed.file).not.toBe(first.file);
		expect((await stat(first.file)).isFile()).toBe(true);
		expect((await readdir(join(cwd, ".owl", "office"))).filter((name) => name.endsWith(".univer"))).toHaveLength(2);
	}, 60_000);

	it("recovers when the cached working copy has been deleted", async () => {
		const { runtime, cwd } = await fixture();
		const first = await opened(runtime, cwd);
		// Windows cannot unlink a SQLite file while its Gateway still holds a handle.
		// Simulate this runtime's Gateway exiting, then delete the cache while its process is gone.
		const pid = runtime.gatewayProcessId;
		if (!pid || pid === process.pid) throw new Error("Missing owned Gateway process");
		process.kill(pid, "SIGKILL");
		for (let attempt = 0; attempt < 100 && runtime.gatewayOrigin !== undefined; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(runtime.gatewayOrigin).toBeUndefined();
		await rm(first.file);
		const replacement = await opened(runtime, cwd);
		expect(replacement.file).not.toBe(first.file);
		expect((await stat(replacement.file)).isFile()).toBe(true);
	}, 60_000);

	it("cancels one concurrent opener while preserving the other and releases servers on disposal", async () => {
		const { runtime, cwd } = await fixture();
		const controller = new AbortController();
		const cancelled = runtime
			.open({ cwd, path: "source.xlsx", signal: controller.signal })
			.catch((error: unknown) => error);
		const continuing = opened(runtime, cwd);
		const timer = setTimeout(() => controller.abort(), 30);
		try {
			expect(await cancelled).toMatchObject({ name: "AbortError" });
			const completed = await continuing;
			expect((await stat(completed.file)).isFile()).toBe(true);
			const origin = runtime.gatewayOrigin;
			await runtime.dispose();
			if (!origin) throw new Error("Gateway did not start");
			await expect(fetch(origin, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
		} finally {
			clearTimeout(timer);
		}
	}, 60_000);

	it("rejects an already cancelled open before creating a working copy or Gateway", async () => {
		const { cwd } = await fixture();
		if (!assetRoot) throw new Error("Runtime required");
		const runtime = new OfficeRuntime({ assetRoot });
		cleanup.push(() => runtime.dispose());
		const controller = new AbortController();
		controller.abort();
		await expect(runtime.open({ cwd, path: "source.xlsx", signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(runtime.gatewayOrigin).toBeUndefined();
		await expect(stat(join(cwd, ".owl", "office"))).rejects.toMatchObject({ code: "ENOENT" });
	}, 60_000);
});
