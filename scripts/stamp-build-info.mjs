#!/usr/bin/env node
/**
 * 在构建产物目录写 build-info.json（格式与算法见 packages/coding-agent/src/core/build-info.ts）。
 *
 *   node scripts/stamp-build-info.mjs bridge   coding-agent 的 tsc 产物（packages/coding-agent/dist）
 *   stampEsbuild(result.metafile, { ... })     插件的 esbuild 构建脚本里调用（metafile: true）
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createBuildInfo,
	listSourceFiles,
	toRepoPath,
	writeBuildInfo,
} from "../packages/coding-agent/src/core/build-info.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 packages/coding-agent/tsconfig.build.json 的 include/exclude 对齐。 */
const BRIDGE_SOURCE_DIR = "packages/coding-agent/src";
const BRIDGE_EXCLUDED = [
	`${BRIDGE_SOURCE_DIR}/client/`,
	`${BRIDGE_SOURCE_DIR}/experimental/`,
	`${BRIDGE_SOURCE_DIR}/cli/experimental/`,
];

export function stampBridge() {
	const inputs = listSourceFiles(
		repoRoot,
		BRIDGE_SOURCE_DIR,
		(path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !BRIDGE_EXCLUDED.some((prefix) => path.startsWith(prefix)),
	);
	const info = createBuildInfo({ component: "bridge", repoRoot, inputs, protocol: true });
	writeBuildInfo(resolve(repoRoot, "packages/coding-agent/dist"), info);
	console.log(`build-info: bridge ${info.sourceHash} (${inputs.length} files)`);
}

/**
 * @param {{ inputs: Record<string, unknown> }} metafile esbuild 的 metafile（路径相对 absWorkingDir）
 * @param {{ component: string, outDir: string, workingDir?: string }} options
 */
export function stampEsbuild(metafile, options) {
	const workingDir = options.workingDir ?? process.cwd();
	const inputs = Object.keys(metafile.inputs)
		.filter((path) => !path.includes("node_modules") && !path.includes(":"))
		.map((path) => toRepoPath(repoRoot, resolve(workingDir, path)))
		.filter((path) => path !== undefined);
	const info = createBuildInfo({ component: options.component, repoRoot, inputs });
	writeBuildInfo(resolve(workingDir, options.outDir), info);
	console.log(`build-info: ${options.component} ${info.sourceHash} (${inputs.length} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const mode = process.argv[2];
	if (mode === "bridge") {
		stampBridge();
	} else {
		console.error("usage: node scripts/stamp-build-info.mjs bridge");
		process.exit(1);
	}
}
