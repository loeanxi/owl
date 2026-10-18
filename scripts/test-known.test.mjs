import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReport } from "../packages/coding-agent/scripts/test-known.mjs";

const script = fileURLToPath(new URL("../packages/coding-agent/scripts/test-known.mjs", import.meta.url));
const file = fileURLToPath(new URL("../packages/coding-agent/test/verdict-fixture.test.ts", import.meta.url));
const key = "test/verdict-fixture.test.ts > suite fails";

function report(assertionResults = [{ fullName: "suite fails", status: "passed" }], overrides = {}) {
	const numFailedTests = assertionResults.filter((assertion) => assertion.status === "failed").length;
	return {
		testResults: [{ name: file, status: numFailedTests ? "failed" : "passed", message: "", assertionResults }],
		numTotalTests: assertionResults.length,
		numFailedTests,
		numFailedTestSuites: numFailedTests ? 1 : 0,
		success: numFailedTests === 0,
		...overrides,
	};
}

function evaluate(result = report(), options = {}) {
	const {
		known = [],
		run = { status: 0 },
		metadata = { unhandledErrors: 0, suiteErrors: [], reason: "passed" },
		...rest
	} = options;
	return evaluateReport(result, new Set(known), run, metadata, rest);
}

test("passes completed tests and reports resolved known assertions", () => {
	const verdict = evaluate(report(), { known: [key] });
	assert.equal(verdict.exitCode, 0);
	assert.deepEqual(verdict.fixed, [key]);
});

test("preserves known assertion failures, including nested failed suites and wildcard entries", () => {
	const result = report([{ fullName: "suite fails", status: "failed" }], { numFailedTestSuites: 3 });
	for (const known of [[key], ["test/verdict-fixture.test.ts > *"]]) {
		const verdict = evaluate(result, { known, run: { status: 1 } });
		assert.equal(verdict.exitCode, 0);
		assert.equal(verdict.failed.length, 1);
	}
	assert.equal(evaluate(result, { run: { status: 1 } }).exitCode, 1);
});

test("collection failures cannot be tolerated by file or wildcard entries", () => {
	const result = report([], {
		testResults: [{ name: file, status: "failed", message: "No test suite found", assertionResults: [] }],
		numFailedTestSuites: 1,
		success: false,
	});
	for (const known of [["test/verdict-fixture.test.ts > (file)"], ["test/verdict-fixture.test.ts > *"]]) {
		const verdict = evaluate(result, { known, run: { status: 1 } });
		assert.equal(verdict.exitCode, 1);
		assert.deepEqual(verdict.unexpected, ["test/verdict-fixture.test.ts > (file)"]);
	}
});

test("unhandled and nested-suite errors remain fatal beside known assertion failures", () => {
	const result = report([{ fullName: "suite fails", status: "failed" }]);
	for (const metadata of [
		{ unhandledErrors: 1, suiteErrors: [], reason: "failed" },
		{ unhandledErrors: 0, suiteErrors: ["afterAll failed"], reason: "failed" },
		{ unhandledErrors: 0, suiteErrors: [], reason: "interrupted" },
	]) {
		const verdict = evaluate(result, { known: [key], run: { status: 1 }, metadata });
		assert.equal(verdict.exitCode, 1);
		assert.ok(verdict.errors.length > 0);
	}
});

test("spawn errors, termination and unexpected exit codes remain fatal beside known failures", () => {
	const result = report([{ fullName: "suite fails", status: "failed" }]);
	for (const run of [
		{ status: null, error: new Error("ENOENT") },
		{ status: null, signal: "SIGTERM" },
		{ status: 2 },
	]) {
		assert.equal(evaluate(result, { known: [key], run }).exitCode, 1);
	}
});

test("missing reports or metadata cannot turn a successful process into a green run", () => {
	assert.equal(evaluate(null).exitCode, 1);
	assert.equal(evaluate(report(), { metadata: null }).exitCode, 1);
});

test("only a successful changed run may report no affected test files", () => {
	const empty = report([], { testResults: [], success: false });
	assert.equal(evaluate(empty).exitCode, 1);
	assert.equal(evaluate(empty, { allowEmpty: true }).exitCode, 0);
	assert.equal(evaluate(empty, { allowEmpty: true, run: { status: 1 } }).exitCode, 1);
	assert.equal(evaluate(report([], { success: true }), { allowEmpty: true }).exitCode, 1);
});

test("unexplained failures, unfinished tests and omitted assertion results are fatal", () => {
	assert.equal(evaluate(report([], { success: true })).exitCode, 1);
	assert.equal(evaluate(report(), { run: { status: 1 } }).exitCode, 1);
	assert.equal(evaluate(report(undefined, { success: false })).exitCode, 1);
	assert.equal(evaluate(report([{ fullName: "suite fails", status: "pending" }])).exitCode, 1);
	assert.equal(evaluate(report(undefined, { numTotalTests: 2 })).exitCode, 1);
	const omittedFailure = report([{ fullName: "suite fails", status: "failed" }], { numFailedTests: 2 });
	assert.equal(evaluate(omittedFailure, { known: [key], run: { status: 1 } }).exitCode, 1);
});

function runFixture(t, source, target) {
	const directory = mkdtempSync(join(tmpdir(), "owl-test-known-fixture-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const config = join(directory, "vitest.config.mjs");
	writeFileSync(config, `export default { root: ${JSON.stringify(directory)}, test: { globals: true, include: ["*.test.ts"] } };`);
	if (source) writeFileSync(join(directory, "fixture.test.ts"), source);
	return spawnSync(process.execPath, [script, "--config", config, target], {
		encoding: "utf8",
		timeout: 30_000,
	});
}

test("an explicit target with no collected tests exits nonzero", (t) => {
	const result = runFixture(t, undefined, "missing.test.ts");
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.doesNotMatch(result.stdout, /No new failures/);
	assert.match(result.stderr, /no test cases/);
});

test("a real collection error exits nonzero and is not labeled a tolerated failure", (t) => {
	const result = runFixture(t, 'throw new Error("collection fixture failed");', "fixture.test.ts");
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.doesNotMatch(result.stdout, /No new failures/);
	assert.match(result.stdout + result.stderr, /collection fixture failed/);
	assert.match(result.stderr, /suite error: collection fixture failed/);
});

test("a completed real suite passes with reporter metadata", (t) => {
	const result = runFixture(t, 'test("passes", () => {});', "fixture.test.ts");
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /No new failures/);
});

test("a real assertion failure stays an assertion rather than a collection error", (t) => {
	const result = runFixture(t, 'test("assertion fixture fails", () => { throw new Error("assertion fixture failed"); });', "fixture.test.ts");
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, / > assertion fixture fails/);
	assert.doesNotMatch(result.stdout, / > \(file\)/);
	assert.doesNotMatch(result.stderr, /suite error:/);
});

test("the real reporter captures an unhandled rejection despite passing assertions", (t) => {
	const result = runFixture(t, `test("passes", async () => {
		void Promise.reject(new Error("unhandled fixture"));
		await new Promise((resolve) => setTimeout(resolve, 20));
	});`, "fixture.test.ts");
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /reported 1 unhandled errors/);
	assert.doesNotMatch(result.stdout, /No new failures/);
});
