#!/usr/bin/env node
// Run vitest with the given arguments and fail only on failures not listed in
// test/known-failures.txt, so pre-existing red tests do not hide new breakage.
//   node scripts/test-known.mjs                     all tests
//   node scripts/test-known.mjs --changed           tests related to uncommitted changes
//   node scripts/test-known.mjs test/foo.test.ts    specific files
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
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

function compare(report) {
	const known = readKnown();
	const flakyFiles = new Set([...known].filter((key) => key.endsWith(" > *")).map((key) => key.slice(0, -4)));
	const failed = [];
	const passed = new Set();
	for (const file of report.testResults) {
		const path = relative(packageDir, file.name).split(sep).join("/");
		const failedTests = file.assertionResults.filter((test) => test.status === "failed");
		if (file.status === "failed" && failedTests.length === 0) failed.push({ path, key: `${path} > (file)` });
		else if (file.status === "passed") passed.add(`${path} > (file)`);
		for (const test of file.assertionResults) {
			const key = `${path} > ${test.fullName}`;
			if (test.status === "failed") failed.push({ path, key });
			else if (test.status === "passed") passed.add(key);
		}
	}

	const unexpected = failed
		.filter(({ path, key }) => !known.has(key) && !flakyFiles.has(path))
		.map(({ key }) => key);
	const fixed = [...known].filter((key) => passed.has(key));
	console.log(
		`\ntest-known: ${failed.length} failed, ${failed.length - unexpected.length} of them listed in test/known-failures.txt.`,
	);
	if (fixed.length > 0) {
		console.log("Listed as known failures but passed in this run (remove them once they stay green):");
		for (const key of fixed) console.log(`  ${key}`);
	}
	if (unexpected.length > 0) {
		console.log("NEW failures (not in test/known-failures.txt):");
		for (const key of unexpected) console.log(`  ${key}`);
		return 1;
	}
	console.log("No new failures.");
	return 0;
}

const reportDir = mkdtempSync(join(tmpdir(), "owl-test-known-"));
const reportPath = join(reportDir, "report.json");
let exitCode;
try {
	const run = spawnSync(
		process.execPath,
		[vitestCli, "--run", "--reporter=dot", "--reporter=json", `--outputFile.json=${reportPath}`, ...process.argv.slice(2)],
		{ cwd: packageDir, stdio: "inherit" },
	);
	if (existsSync(reportPath)) {
		exitCode = compare(JSON.parse(readFileSync(reportPath, "utf8")));
	} else {
		console.error("\ntest-known: vitest produced no report; see the output above.");
		exitCode = run.status ?? 1;
	}
} finally {
	rmSync(reportDir, { recursive: true, force: true });
}
process.exit(exitCode);
