#!/usr/bin/env node

/**
 * 混合测试运行器：把同一份测试目录按 import 来源分成两拨，分别交给对应 runner 执行。
 *
 * 背景：仓库里大部分测试写的是 node:test（用 node:assert + t.after），
 * 少数用了 vitest（vi.mock / vi.importActual，node 内建 runner 无法提供）。
 * 为了不改动 800 多条既有断言，这里按文件实际 import 来分流：
 *
 *   - import "vitest"       → vitest（负责 vi.mock / vi.stubGlobal / expect 等）
 *   - import "node:test"    → node --test --experimental-strip-types
 *
 * 两拨都必须全绿才算通过；任一拨失败则以非零码退出。
 *
 * 用法（在所属 workspace 下）：
 *   node scripts/run-mixed-tests.mjs [--vitest-arg=xxx] [--node-arg=xxx] <目录...>
 *   --vitest-arg / --node-arg 可重复，用于透传 --test-name-pattern、--reporter 之类。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// 脚本位于 <repo>/scripts/，仓库根就是它的上一级。
const REPO_ROOT = resolve(import.meta.dirname, "..");
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
// 构建产物与依赖目录：dist 里的编译副本、target 下的嵌入源码都不是测试。
const IGNORED_DIRECTORIES = new Set([
	".git",
	"coverage",
	"dist",
	"build",
	"node_modules",
	"target",
	".artifacts",
]);

/** @typedef {"vitest" | "node"} RunnerKind */

/**
 * 递归收集目录下的测试文件（跳过构建产物与依赖目录）。
 * @param {string} directory
 * @returns {string[]}
 */
function collectTestFiles(directory) {
	if (!existsSync(directory)) return [];
	const stats = statSync(directory);
	if (stats.isFile()) return TEST_FILE_PATTERN.test(directory) ? [resolve(directory)] : [];
	/** @type {string[]} */
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (IGNORED_DIRECTORIES.has(entry.name)) continue;
			found.push(...collectTestFiles(join(directory, entry.name)));
			continue;
		}
		if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) found.push(join(directory, entry.name));
	}
	return found.sort();
}

/**
 * 判断一个测试文件该由哪个 runner 跑：显式 import "vitest" 归 vitest，其余归 node 内建 runner。
 * @param {string} file
 * @returns {RunnerKind}
 */
function detectRunner(file) {
	const source = readFileSync(file, "utf8");
	// 只看 import 头部即可，测试正文里出现的 "vitest" 字符串不应影响判定。
	const head = source.split("\n").filter((line) => /^\s*(import|export)\b/.test(line)).join("\n");
	if (/\bfrom\s+["']vitest["']|\bimport\s+["']vitest["']/.test(head)) return "vitest";
	return "node";
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	/** @type {string[]} */
	const targets = [];
	/** @type {string[]} */
	const vitestArgs = [];
	/** @type {string[]} */
	const nodeArgs = [];
	for (const argument of argv) {
		if (argument.startsWith("--vitest-arg=")) vitestArgs.push(argument.slice("--vitest-arg=".length));
		else if (argument.startsWith("--node-arg=")) nodeArgs.push(argument.slice("--node-arg=".length));
		else targets.push(argument);
	}
	if (targets.length === 0) targets.push(".");
	return { targets: targets.map((target) => resolve(process.cwd(), target)), vitestArgs, nodeArgs };
}

/**
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean} 是否通过
 */
function run(label, command, args) {
	process.stdout.write(`\n[run-mixed-tests] ${label}: ${command} ${args.join(" ")}\n`);
	const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", shell: false });
	if (result.error) {
		process.stderr.write(`[run-mixed-tests] ${label} 无法启动: ${String(result.error)}\n`);
		return false;
	}
	return result.status === 0;
}

const { targets, vitestArgs, nodeArgs } = parseArgs(process.argv.slice(2));
const allFiles = targets.flatMap((target) => collectTestFiles(target));

if (allFiles.length === 0) {
	process.stderr.write("[run-mixed-tests] 没有找到任何测试文件\n");
	process.exit(1);
}

/** @type {Record<RunnerKind, string[]>} */
const buckets = { vitest: [], node: [] };
for (const file of allFiles) buckets[detectRunner(file)].push(file);

const relabel = (file) => relative(process.cwd(), file);
const results = [];

// vitest 需要自己的配置与别名解析；node 内建 runner 直接吃文件列表。
if (buckets.vitest.length > 0) {
	results.push([
		"vitest",
		run("vitest", process.execPath, [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...vitestArgs, ...buckets.vitest.map(relabel)]),
	]);
}
if (buckets.node.length > 0) {
	results.push([
		"node --test",
		run("node --test", process.execPath, ["--test", "--experimental-strip-types", ...nodeArgs, ...buckets.node.map(relabel)]),
	]);
}

const failed = results.filter(([, passed]) => !passed).map(([name]) => name);
process.stdout.write(
	`\n[run-mixed-tests] 共 ${allFiles.length} 个测试文件：vitest ${buckets.vitest.length} 个，node --test ${buckets.node.length} 个` +
		`${failed.length === 0 ? "，全部通过" : `，失败：${failed.join(", ")}`}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);