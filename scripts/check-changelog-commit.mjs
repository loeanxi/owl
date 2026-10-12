#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const CHANGELOG = "CHANGELOG.md";
const KINDS = ["新增", "改进", "修复", "移除", "维护"];

const skipValue = process.env.OWL_SKIP_CHANGELOG;
const skipped = skipValue === "1" || skipValue === "true" || skipValue === "yes";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function inMerge() {
	try {
		git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
		return true;
	} catch {
		return false;
	}
}

function printFormat() {
	console.error("");
	console.error(`Add an entry to ${CHANGELOG} (repository root) and stage it:`);
	console.error("");
	console.error("  ## YYYY-MM-DD            <- today; newest date first, reuse it if it exists");
	console.error("");
	console.error(`  ### <category>           <- one of: ${KINDS.join(" / ")}`);
	console.error("");
	console.error("  - `scope` one-line description   <- scope as in the commit header; omit for cross-package");
	console.error("");
	console.error("See COMMIT_SPEC.md for the rules. Shown in desktop Settings > Changelog.");
	console.error(`Bypass only when the user explicitly asks: OWL_SKIP_CHANGELOG=1 git commit ...`);
}

const stagedFiles = git(["diff", "--cached", "--name-only"])
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

if (stagedFiles.length === 0 || inMerge()) {
	process.exit(0);
}

if (skipped) {
	console.error(`${CHANGELOG} check skipped (OWL_SKIP_CHANGELOG is set).`);
	process.exit(0);
}

if (!stagedFiles.includes(CHANGELOG)) {
	console.error(`${CHANGELOG} is not staged. Every commit must record its change in the Owl changelog.`);
	printFormat();
	process.exit(1);
}

const added = git(["diff", "--cached", "-U0", "--", CHANGELOG])
	.split("\n")
	.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
	.map((line) => line.slice(1).trim());

const problems = [];
for (const line of added) {
	const day = /^##\s+(.+)$/.exec(line);
	if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day[1].trim())) problems.push(`date heading must be YYYY-MM-DD: "${line}"`);
	const kind = /^###\s+(.+)$/.exec(line);
	if (kind && !KINDS.includes(kind[1].trim())) problems.push(`unknown category "${kind[1].trim()}": "${line}"`);
}
if (!added.some((line) => /^[-*]\s+\S/.test(line))) {
	problems.push(`staged ${CHANGELOG} adds no "- ..." entry`);
}

if (problems.length > 0) {
	console.error(`${CHANGELOG} entry is invalid:`);
	for (const problem of problems) console.error(`  - ${problem}`);
	printFormat();
	process.exit(1);
}
