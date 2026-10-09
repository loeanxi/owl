#!/usr/bin/env node
/**
 * 桌面端启动前的新鲜度检查：UI dist、桥 dist、esbuild 插件 dist 各自的 build-info.json
 * 记录了构建时每个输入文件的哈希，源码有改动（或产物没有指纹）就判为过期。
 *
 *   node scripts/check-desktop-freshness.mjs            只报告，过期时退出码 1
 *   node scripts/check-desktop-freshness.mjs --rebuild  过期的就地重建，重建失败退出码 1
 *
 * 启动器（owl-desktop.cmd 等）调用它；失败只告警，不拦启动——旧产物照样能跑，
 * 启动后 build.hello 横幅会再提示一次。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo, SourceHashCache } from "../packages/coding-agent/src/core/build-info.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<{ name: string, dir: string, dist: string, command: string }>} */
const COMPONENTS = [
	{ name: "bridge", dir: "packages/coding-agent", dist: "dist", command: "npm run build:unbundled" },
	{ name: "ui", dir: "apps/desktop", dist: "dist", command: "npx vite build" },
	{ name: "owl-image", dir: "packages/owl-image", dist: "dist", command: "npm run build" },
	{ name: "owl-web-access", dir: "packages/owl-web-access", dist: "dist", command: "npm run build" },
	{ name: "owl-safety-net", dir: "packages/owl-safety-net", dist: "dist", command: "npm run build" },
	{ name: "owl-billion-context", dir: "packages/owl-billion-context", dist: "dist", command: "npm run build" },
];

async function staleReason(component, hashes) {
	const distDir = join(repoRoot, component.dir, component.dist);
	const info = readBuildInfo(distDir);
	if (!info) return existsSync(distDir) ? "产物没有 build-info.json（旧构建）" : "没有构建产物";
	const changed = await hashes.changedInputs(repoRoot, info);
	if (changed.length === 0) return undefined;
	const sample = changed.slice(0, 3).join(", ");
	return `${changed.length} 个源码文件比产物新（${sample}${changed.length > 3 ? " …" : ""}）`;
}

async function main() {
	const rebuild = process.argv.includes("--rebuild");
	const hashes = new SourceHashCache();
	let failed = false;
	for (const component of COMPONENTS) {
		if (!existsSync(join(repoRoot, component.dir, "package.json"))) continue;
		const reason = await staleReason(component, hashes);
		if (!reason) {
			console.log(`[owl] ${component.name}: 最新`);
			continue;
		}
		if (!rebuild) {
			console.warn(`[owl] ${component.name}: 过期 —— ${reason}`);
			failed = true;
			continue;
		}
		console.log(`[owl] ${component.name}: ${reason}，重建中（${component.command}）…`);
		const result = spawnSync(component.command, {
			cwd: join(repoRoot, component.dir),
			shell: true,
			stdio: "inherit",
		});
		if (result.status !== 0) {
			console.warn(`[owl] ${component.name}: 重建失败（退出码 ${result.status ?? "?"}），继续使用旧产物`);
			failed = true;
		}
	}
	process.exitCode = failed ? 1 : 0;
}

await main();
