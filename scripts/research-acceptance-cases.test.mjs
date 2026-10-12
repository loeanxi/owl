import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowedAcceptanceTool, hash, inside, prepareCase, requestBudget, syntheticPe, verifyCase } from "./research-acceptance-cases.mjs";

test("failed attempts still exhaust per-case and shared limits", () => {
	const budget = requestBudget({ calls: 4, rounds: 3 });
	for (let n = 0; n < 3; n++) budget.claim("a");
	assert.throws(() => budget.claim("a"), /exhausted/);
	budget.claim("b");
	assert.throws(() => budget.claim("c"), /exhausted/);
	assert.equal(budget.attempts, 4);
});

test("fixture controls exclude shell, foreign targets, and fixture overwrites", () => {
	const cwd = join(tmpdir(), "research-scope");
	assert.equal(allowedAcceptanceTool(cwd, "js", { toolName: "bash", input: { command: "node index.js" } }), false);
	assert.equal(allowedAcceptanceTool(cwd, "js", { toolName: "read", input: { path: "../auth.json" } }), false);
	assert.equal(allowedAcceptanceTool(cwd, "js", { toolName: "write", input: { path: "index.js" } }), false);
	assert.equal(allowedAcceptanceTool(cwd, "js", { toolName: "write", input: { path: "analysis.json" } }), true);
	assert.equal(allowedAcceptanceTool(cwd, "native", { toolName: "research_rea", input: { action: "native_function", path: "return42.exe" } }), true);
	assert.equal(allowedAcceptanceTool(cwd, "native", { toolName: "research_rea", input: { action: "javascript", path: "." } }), false);
});

test("native fixture has a valid x64 PE layout and known entry bytes", () => {
	const data = syntheticPe();
	assert.equal(data.readUInt16LE(0x84), 0x8664);
	assert.equal(data.readUInt32LE(0x98 + 16), 0x1000);
	assert.deepEqual([...data.subarray(0x200, 0x206)], [0xb8, 42, 0, 0, 0, 0xc3]);
});

test("plausible final text and forged report cannot pass independent artifact checks", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "owl-acceptance-test-"));
	try {
		const manifest = await prepareCase(cwd, "js");
		await writeFile(join(cwd, "analysis.json"), JSON.stringify({ kind: "js", result: "AB", callChain: ["lookupBadge", "decodeBadge"], evidencePaths: [join(cwd, "fake.json")] }));
		const result = await verifyCase(cwd, manifest, [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "完成" }] }]);
		assert.equal(result.passed, false);
		assert.equal(result.checks.find(check => check.name === "actual_static_tool_result").passed, false);
		assert.equal(hash(await readFile(manifest.inputs[0].path)), manifest.inputs[0].sha256);
	} finally {
		assert.ok(inside(tmpdir(), cwd));
		await rm(cwd, { recursive: true });
	}
});

for (const kind of ["js", "native"]) {
	test(`real hashed ${kind} evidence passes, while altered evidence fails`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "owl-acceptance-evidence-"));
		try {
			const manifest = await prepareCase(cwd, kind);
			const path = join(cwd, kind === "js" ? "session-evidence.json" : "response.json");
			const content = kind === "js" ? '{"modules":["lookupBadge","decodeBadge"]}' : '{"pseudocode":"return 0x2a;"}';
			await writeFile(path, content);
			await writeFile(join(cwd, "analysis.json"), JSON.stringify({ kind, result: kind === "js" ? "AB" : 42, callChain: kind === "js" ? ["lookupBadge", "decodeBadge"] : ["0x140001000"], evidencePaths: [path] }));
			const messages = [{ role: "toolResult", toolName: "research_rea", isError: false, details: { researchRea: { operation: kind === "js" ? "analyze_javascript_application" : "analyze_function", targetExecuted: false, target: { path: kind === "js" ? cwd : manifest.inputs[0].path, sha256: kind === "js" ? null : manifest.inputs[0].sha256 }, artifacts: [{ path, sha256: hash(content) }] } } }];
			assert.equal((await verifyCase(cwd, manifest, messages)).passed, true);
			await writeFile(path, "altered evidence");
			assert.equal((await verifyCase(cwd, manifest, messages)).passed, false);
		} finally {
			assert.ok(inside(tmpdir(), cwd));
			await rm(cwd, { recursive: true });
		}
	});
}
