import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { OfficeRuntime } from "../src/runtime.ts";

const assetRoot = process.env.OWL_UNIVER_TEST_RUNTIME;
const validationRoot = resolve(process.env.OWL_UNIVER_TEST_WORKSPACE || join(process.cwd(), ".artifacts", "office-integration"));

test("real Office runtime keeps edits in a draft, exports XLSX and reimports it", { skip: !assetRoot, timeout: 180_000 }, async () => {
	if (!assetRoot) return;
	const cwd = join(validationRoot, `run-${randomUUID()}`);
	await mkdir(cwd, { recursive: true });
	const runtime = new OfficeRuntime({ assetRoot });
	try {
		await runtime.call("new", { file: "sample.univer" }, cwd);
		const draft = await runtime.call("worktree", { file: "sample.univer", action: "create", name: "验证草稿" }, cwd);
		assert.equal(typeof draft.worktreeId, "string");
		const worktreeId = draft.worktreeId;
		const unit = await runtime.call("unit", { file: "sample.univer", worktreeId, action: "create", kind: "sheet", name: "费用明细" }, cwd);
		assert.equal(typeof unit.unitId, "string");
		const unitId = unit.unitId;
		const written = await runtime.call("execute", { file: "sample.univer", worktreeId, unitId,
			code: 'const sheet = workbook.getActiveSheet(); sheet.getRange("A1:C3").setValues([["项目", "数量", "单价"], ["设备", 2, 150], ["耗材", 3, 20]]); sheet.getRange("D1").setValue("合计"); sheet.getRange("D2").setFormula("=B2*C2"); sheet.getRange("D3").setFormula("=B3*C3"); return sheet.getRange("A1:C3").getValues();',
		}, cwd);
		assert.equal(written.ok, true);
		const trunk = await runtime.call("status", { file: "sample.univer" }, cwd);
		assert.deepEqual((trunk.result as { trunk: { units: unknown[] } }).trunk.units, []);
		const inspected = await runtime.call("inspect", { file: "sample.univer", worktreeId, unitId, range: "A1:D3" }, cwd);
		assert.match(JSON.stringify(inspected), /费用明细|设备/);
		await assert.rejects(runtime.call("worktree", { file: "sample.univer", worktreeId, action: "merge" }, cwd), /Confirm this Office action/);
		await runtime.call("worktree", { file: "sample.univer", worktreeId, action: "ready" }, cwd);
		await runtime.call("worktree", { file: "sample.univer", worktreeId, action: "merge", userConfirmed: true }, cwd);
		await runtime.call("export", { file: "sample.univer", unitId, output: "exported.xlsx" }, cwd);
		assert.ok((await stat(join(cwd, "exported.xlsx"))).size > 100);
		await assert.rejects(runtime.call("export", { file: "sample.univer", unitId, output: "exported.xlsx" }, cwd), /already exists/);
		const reimport = await runtime.call("worktree", { file: "sample.univer", action: "create", name: "往返检查" }, cwd);
		await runtime.call("import", { file: "sample.univer", worktreeId: reimport.worktreeId, source: "exported.xlsx", name: "重新导入" }, cwd);
		const api = await runtime.call("api", { action: "show", queries: ["FRange.setValue"] }, cwd);
		assert.match(JSON.stringify(api), /FRange/);
		const preview = await runtime.open({ cwd, path: "sample.univer" });
		const bootstrap = await fetch(preview.url, { redirect: "manual" });
		assert.equal(bootstrap.status, 303);
		const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
		assert.ok(cookie);
		const pageUrl = new URL(bootstrap.headers.get("location")!, preview.url);
		const page = await fetch(pageUrl, { headers: { Cookie: cookie } });
		assert.equal(page.status, 200);
		assert.match(await page.text(), /Univer/);
		await writeFile(join(cwd, "validation.json"), JSON.stringify({ cwd, file: "sample.univer", unitId, worktreeId, exported: "exported.xlsx", previewChecked: true }, null, 2));
		process.stdout.write(`Office validation artifacts: ${cwd}\n`);
	} finally {
		await runtime.dispose();
	}
});
