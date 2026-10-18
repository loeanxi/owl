#!/usr/bin/env node
// Run vitest with the given arguments and fail only on failures not listed in
// test/known-failures.txt, so pre-existing red tests do not hide new breakage.
//   node scripts/test-known.mjs                     all tests
//   node scripts/test-known.mjs --changed           tests related to uncommitted changes
//   node scripts/test-known.mjs test/foo.test.ts    specific files
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = join(packageDir, "..", "..", "node_modules", "vitest", "vitest.mjs");
const knownPath = join(packageDir, "test", "known-failures.txt");

function readKnown() {
	return new Set(
		readFileSync(knownPath, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	);
}

export function evaluateReport(report, known, run, metadata, { allowEmpty = false } = {}) {
	const errors = [];
	if (run.error) errors.push(`vitest could not start: ${run.error.message}`);
	else if (run.signal) errors.push(`vitest was terminated by ${run.signal}`);
	else if (run.status !== 0 && run.status !== 1) errors.push(`vitest exited with status ${run.status}`);
	if (!metadata) errors.push("vitest produced no run metadata");
	else {
		if (metadata.unhandledErrors > 0) errors.push(`vitest reported ${metadata.unhandledErrors} unhandled errors`);
		if (metadata.reason === "interrupted") errors.push("vitest was interrupted");
		for (const error of metadata.suiteErrors) errors.push(`suite error: ${error}`);
	}
	if (!report || !Array.isArray(report.testResults)) {
		errors.push("vitest produced no valid JSON report");
		return { failed: [], unexpected: [], fixed: [], errors, exitCode: 1 };
	}
	const flakyFiles = new Set([...known].filter((key) => key.endsWith(" > *")).map((key) => key.slice(0, -4)));
	const failed = [];
	const passed = new Set();
	let assertions = 0;
	let failedAssertions = 0;
	for (const file of report.testResults) {
		const path = relative(packageDir, file.name).split(sep).join("/");
		const failedTests = file.assertionResults.filter((test) => test.status === "failed");
		assertions += file.assertionResults.length;
		failedAssertions += failedTests.length;
		if (file.status === "failed" && (failedTests.length === 0 || file.message)) {
			failed.push({ path, key: `${path} > (file)`, collection: true });
		} else if (file.status === "passed") passed.add(`${path} > (file)`);
		for (const test of file.assertionResults) {
			const key = `${path} > ${test.fullName}`;
			if (test.status === "failed") failed.push({ path, key });
			else if (test.status === "passed") passed.add(key);
			else if (test.status === "pending") errors.push(`test did not finish: ${key}`);
		}
	}
	const emptyChangedRun =
		allowEmpty && report.testResults.length === 0 && report.numFailedTestSuites === 0 && run.status === 0;
	if (assertions === 0 && !emptyChangedRun) errors.push("vitest reported no test cases");
	if (report.numTotalTests !== assertions || report.numFailedTests !== failedAssertions) {
		errors.push("vitest test counts do not match its assertion results");
	}
	if (
		(report.success !== true || report.numFailedTestSuites > 0 || run.status !== 0 || metadata?.reason === "failed") &&
		failedAssertions === 0 &&
		!emptyChangedRun
	) {
		errors.push("vitest failed without an assertion failure that can be checked against the known list");
	}

	const unexpected = failed
		.filter(({ path, key, collection }) => collection || (!known.has(key) && !flakyFiles.has(path)))
		.map(({ key }) => key);
	const fixed = [...known].filter((key) => passed.has(key));
	return { failed, unexpected, fixed, errors, exitCode: unexpected.length > 0 || errors.length > 0 ? 1 : 0 };
}

function printVerdict({ failed, unexpected, fixed, errors, exitCode }) {
	console.log(
		`\ntest-known: ${failed.length} failed, ${failed.length - unexpected.length} of them listed in test/known-failures.txt.`,
	);
	if (fixed.length > 0) {
		console.log("Listed as known failures but passed in this run (remove them once they stay green):");
		for (const key of fixed) console.log(`  ${key}`);
	}
	if (unexpected.length > 0) {
		console.log("NEW failures or collection errors (collection errors cannot be allowlisted):");
		for (const key of unexpected) console.log(`  ${key}`);
	}
	for (const error of errors) console.error(`test-known: ${error}`);
	if (exitCode === 0) console.log("No new failures.");
	return exitCode;
}

function main(args) {
	const reportDir = mkdtempSync(join(tmpdir(), "owl-test-known-"));
	const reportPath = join(reportDir, "report.json");
	const metadataPath = join(reportDir, "run.json");
	try {
		const run = spawnSync(
			process.execPath,
			[
				vitestCli,
				"--run",
				"--reporter=dot",
				"--reporter=json",
				`--reporter=${join(packageDir, "scripts", "test-known-reporter.mjs")}`,
				`--outputFile.json=${reportPath}`,
				...args,
			],
			{ cwd: packageDir, stdio: "inherit", env: { ...process.env, OWL_TEST_KNOWN_METADATA: metadataPath } },
		);
		const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
		const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : undefined;
		return printVerdict(
			evaluateReport(report, readKnown(), run, metadata, {
				allowEmpty: args.some((arg) => arg === "--changed" || arg.startsWith("--changed=")),
			}),
		);
	} catch (error) {
		console.error(`test-known: could not evaluate vitest results: ${error.message}`);
		return 1;
	} finally {
		rmSync(reportDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
