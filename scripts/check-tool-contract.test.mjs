import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-tool-contract.mjs", import.meta.url));

async function check(t, source) {
	const root = await mkdtemp(join(tmpdir(), "pi-tool-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const fullPath = join(root, "packages", "example", "src", "tool.ts");
	await mkdir(join(fullPath, ".."), { recursive: true });
	await writeFile(fullPath, source);
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// Regression for the production failure: anyOf-of-objects parameters produced bare `arguments: {}` calls from weak models.
test("rejects published parameters that are a top-level union of object branches", async (t) => {
	const result = await check(
		t,
		`
import { Type } from "typebox";
export const branchSchema = Type.Union([
	Type.Object({ path: Type.String() }),
	Type.Object({ action: Type.Literal("inventory") }),
]);
export const tool = { name: "x", parameters: branchSchema };
`,
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /top-level Type\.Union of object branches/);
	assert.match(result.stderr, /1 tool contract error/);
});

test("rejects inline union parameters while accepting scalar unions inside a flat object", async (t) => {
	const result = await check(
		t,
		`
import { Type } from "typebox";
export const flat = Type.Object({ action: Type.Union([Type.Literal("save"), Type.Literal("read")]) });
export const inline = { name: "y", parameters: Type.Union([Type.Object({ a: Type.String() })]) };
`,
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /inline tool parameters is a top-level Type\.Union/);
});

test("accepts flat schemas and warns when a schema-fallback error lacks a copyable template", async (t) => {
	const result = await check(
		t,
		`
import { Type } from "typebox";
export const flatSchema = Type.Object({ action: Type.Optional(Type.Union([Type.Literal("save"), Type.Literal("read")])) });
export const tool = { name: "z", parameters: flatSchema };
export function strict(value) {
	if (!value) throw new Error("研究检查点参数无效");
	if (value === 2) throw new Error('研究检查点参数无效；标准格式：{"action":"read"}');
}
`,
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Checked 1 tool parameters schema\(s\) in 1 file\(s\); 0 unresolved\./);
	assert.match(result.stdout, /Tool contract OK\./);
	assert.match(result.stdout, /1 template warning\(s\)/);
	assert.match(result.stderr, /warning: validation error has no copyable JSON template/);
});

test("reports schemas declared outside scanned sources as unresolved without failing", async (t) => {
	const result = await check(
		t,
		`
export const tool = { name: "w", parameters: schemaDeclaredElsewhere };
`,
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Checked 1 tool parameters schema\(s\) in 0 file\(s\); 1 unresolved\./);
});
