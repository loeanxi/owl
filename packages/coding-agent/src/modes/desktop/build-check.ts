/**
 * 构建一致性检查（build.hello 的数据面）：把"你以为在跑的代码"和"实际在跑的代码"对齐。
 *
 * 桥启动时记下自己的 build-info（= 正在运行的那份代码），UI 每次连上桥报一次自己的指纹，
 * 这里逐项比对并返回差异清单，UI 据此显示横幅：
 * - 协议哈希不一致：UI 与桥的线协议对不上（最典型的"点了没反应"来源）。
 * - 窗口里的 bundle 不是盘上那份 dist（dist 已重建，窗口没刷新）。
 * - 运行中的桥不是盘上那份 dist（dist 已重建，桥没重启）。
 * - UI / 桥 / 插件的源码比各自 dist 新（改完没重建）。
 * - agentDir 里有 *.corrupt 备份（有状态文件曾经读不出来）。
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUILD_INFO_FILE,
	type BuildInfo,
	computeProtocolHash,
	findRepoRoot,
	readBuildInfo,
	SourceHashCache,
} from "../../core/build-info.ts";
import type { PluginSource } from "../../core/settings-manager.ts";
import { type CorruptFileInfo, findCorruptFiles } from "../../utils/atomic-file.ts";
import type { BuildHelloResult, BuildIssue, UiBuildFingerprint } from "./protocol.ts";

/** 横幅里只列前几个文件，其余给总数。 */
const SAMPLE_FILES = 3;

export interface BuildCheckerOptions {
	/** serve.ts 的 import.meta.url：据此判断跑的是 dist 还是源码，并定位 dist 根。 */
	moduleUrl: string;
	uiRoot: string | null;
	agentDir: string;
	/** 当前启用的插件条目（settings 的 plugins 字段，含旧字段合并）。 */
	plugins: () => Promise<PluginSource[]>;
	onDiagnostic: (message: string) => void;
}

function sample(changed: string[]): { files: string[]; count: number } {
	return { files: changed.slice(0, SAMPLE_FILES), count: changed.length };
}

/** 本地目录型插件条目 → 目录绝对路径（npm/git 源和单文件扩展不在 monorepo 构建链里，不查）。 */
function localPluginDirs(plugins: PluginSource[], agentDir: string): string[] {
	const dirs: string[] = [];
	for (const plugin of plugins) {
		const source = typeof plugin === "string" ? plugin : plugin.disabled ? undefined : plugin.source;
		if (!source || /^(npm:|git[+:]|https?:|ssh:)/.test(source) || /^[+\-!]/.test(source)) continue;
		if (/\.[cm]?[jt]s$/.test(source)) continue;
		dirs.push(isAbsolute(source) ? source : resolve(agentDir, source));
	}
	return dirs;
}

export class BuildChecker {
	private readonly options: BuildCheckerOptions;
	private readonly hashes = new SourceHashCache();
	private readonly repoRoot: string | undefined;
	private readonly mode: BuildHelloResult["bridge"]["mode"];
	private readonly distRoot: string | undefined;
	/** 桥启动时盘上的 build-info：也就是本进程正在运行的代码。 */
	private readonly running: BuildInfo | undefined;
	private readonly protocolHash: string | undefined;
	private readonly corrupt: Promise<CorruptFileInfo[]>;

	constructor(options: BuildCheckerOptions) {
		this.options = options;
		const modulePath = fileURLToPath(options.moduleUrl);
		this.repoRoot = findRepoRoot(dirname(modulePath));
		if (modulePath.endsWith(".ts")) {
			this.mode = "source";
			this.protocolHash = this.repoRoot ? computeProtocolHash(this.repoRoot) : undefined;
		} else {
			// dist/modes/desktop/serve.js → dist
			this.distRoot = resolve(dirname(modulePath), "..", "..");
			this.running = readBuildInfo(this.distRoot);
			this.mode = this.running ? "dist" : "unstamped";
			this.protocolHash = this.running?.protocolHash;
		}
		this.corrupt = findCorruptFiles(options.agentDir).then(
			(files) => {
				for (const file of files) options.onDiagnostic(`发现损坏状态文件的备份：${file.path}（${file.size} 字节）`);
				return files;
			},
			() => [],
		);
	}

	async hello(ui: UiBuildFingerprint | undefined): Promise<BuildHelloResult> {
		const issues: BuildIssue[] = [];
		const repoRoot = this.repoRoot;

		if (this.mode === "unstamped") issues.push({ kind: "bridge-unstamped" });
		if (this.distRoot && this.running) {
			const disk = readBuildInfo(this.distRoot) ?? this.running;
			if (disk.buildId !== this.running.buildId) issues.push({ kind: "bridge-restart" });
			if (repoRoot) {
				const changed = await this.hashes.changedInputs(repoRoot, disk);
				if (changed.length > 0) issues.push({ kind: "bridge-source-newer", ...sample(changed) });
			}
		}

		if (ui && ui.buildId !== "dev") {
			if (ui.protocolHash && this.protocolHash && ui.protocolHash !== this.protocolHash) {
				issues.push({ kind: "protocol-mismatch", uiProtocol: ui.protocolHash, bridgeProtocol: this.protocolHash });
			}
			const disk = this.options.uiRoot ? readBuildInfo(this.options.uiRoot) : undefined;
			if (disk && disk.buildId !== ui.buildId) issues.push({ kind: "ui-reload" });
			if (disk && repoRoot) {
				const changed = await this.hashes.changedInputs(repoRoot, disk);
				if (changed.length > 0) issues.push({ kind: "ui-source-newer", ...sample(changed) });
			}
		}

		if (repoRoot) {
			let plugins: PluginSource[] = [];
			try {
				plugins = await this.options.plugins();
			} catch (error) {
				this.options.onDiagnostic(
					`build.hello: 读取插件列表失败：${error instanceof Error ? error.message : String(error)}`,
				);
			}
			for (const dir of localPluginDirs(plugins, this.options.agentDir)) {
				const distDir = join(dir, "dist");
				if (!existsSync(join(distDir, BUILD_INFO_FILE))) continue;
				const info = readBuildInfo(distDir);
				if (!info) continue;
				const changed = await this.hashes.changedInputs(repoRoot, info);
				if (changed.length > 0) {
					issues.push({ kind: "plugin-source-newer", plugin: basename(dir), ...sample(changed) });
				}
			}
		}

		const corrupt = await this.corrupt;
		if (corrupt.length > 0) {
			issues.push({
				kind: "corrupt-files",
				files: corrupt.map((file) => ({
					path: file.path,
					size: file.size,
					mtime: new Date(file.mtimeMs).toISOString(),
				})),
			});
		}

		for (const issue of issues) {
			if (issue.kind !== "corrupt-files") this.options.onDiagnostic(`build.hello: ${JSON.stringify(issue)}`);
		}

		return {
			bridge: {
				mode: this.mode,
				...(this.running
					? {
							buildId: this.running.buildId,
							builtAt: this.running.builtAt,
							...(this.running.gitHead ? { gitHead: this.running.gitHead } : {}),
						}
					: {}),
				...(this.protocolHash ? { protocolHash: this.protocolHash } : {}),
			},
			issues,
		};
	}
}
