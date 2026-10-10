/**
 * 构建指纹。UI bundle、桥 dist、插件 dist 是三份独立构建的产物；构建时各自在产物目录写一份
 * build-info.json（输入文件清单 + 逐文件内容哈希 + 线协议哈希），运行时据此回答
 * "正在跑的代码和盘上源码、和另一端是不是同一版"。
 *
 * 本文件只依赖 node 内建模块、只用可擦除的 TS 语法：构建脚本直接用 node 运行它（类型剥离），
 * vite 配置与桥运行时引用同一份实现，三处的哈希算法因此不会分叉。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const BUILD_INFO_FILE = "build-info.json";

/** UI 侧 bridge/protocol.ts 转引的线协议类型来源；任何一个变了，UI 与桥都必须一起重建。 */
export const PROTOCOL_SOURCES = [
	"packages/coding-agent/src/modes/desktop/protocol.ts",
	"packages/coding-agent/src/core/news/types.ts",
	"packages/coding-agent/src/core/mail/types.ts",
	"packages/coding-agent/src/core/evaluation/types.ts",
	"packages/coding-agent/src/core/research/types.ts",
	"packages/owl-career/src/types.ts",
	"packages/owl-life-monitor/src/types.ts",
	"packages/owl-map/src/types.ts",
];

export interface BuildInfo {
	schema: 1;
	/** "bridge" | "ui" | "plugin:<包名>" */
	component: string;
	/** 每次构建唯一；运行中的进程与盘上产物 buildId 不同 = 产物已重建、进程还是旧的。 */
	buildId: string;
	builtAt: string;
	gitHead?: string;
	sourceHash: string;
	protocolHash?: string;
	/** 构建输入：仓库根相对路径（/ 分隔）→ 内容哈希。 */
	files: Record<string, string>;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** 从 start 向上找 monorepo 根（以 packages/coding-agent/package.json 为标志）。 */
export function findRepoRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (let depth = 0; depth < 12; depth++) {
		if (existsSync(join(dir, "packages", "coding-agent", "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** 仓库根相对路径；不在仓库内时返回 undefined。 */
export function toRepoPath(repoRoot: string, absolute: string): string | undefined {
	const rel = relative(repoRoot, absolute);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

/** 换行归一后哈希：同一份源码在 autocrlf 不同的检出里指纹一致。 */
export function hashText(content: Buffer | string): string {
	const text = typeof content === "string" ? content : content.toString("utf8");
	return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
}

export function digestFiles(files: Record<string, string>): string {
	const hash = createHash("sha256");
	for (const key of Object.keys(files).sort()) hash.update(`${key}\0${files[key]}\n`);
	return hash.digest("hex").slice(0, 16);
}

const MISSING = "missing";

function hashFilesSync(repoRoot: string, inputs: string[]): Record<string, string> {
	const files: Record<string, string> = {};
	for (const input of inputs) {
		try {
			files[input] = hashText(readFileSync(join(repoRoot, input)));
		} catch {
			files[input] = MISSING;
		}
	}
	return files;
}

/** 递归列出 dir（仓库根相对）下被 accept 接受的文件，跳过 node_modules / dist / .git。 */
export function listSourceFiles(repoRoot: string, dir: string, accept: (repoPath: string) => boolean): string[] {
	const found: string[] = [];
	const walk = (absolute: string): void => {
		for (const entry of readdirSync(absolute, { withFileTypes: true })) {
			const full = join(absolute, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(full);
				continue;
			}
			const repoPath = toRepoPath(repoRoot, full);
			if (repoPath && accept(repoPath)) found.push(repoPath);
		}
	};
	walk(join(repoRoot, dir));
	return found.sort();
}

export function computeProtocolHash(repoRoot: string): string {
	return digestFiles(hashFilesSync(repoRoot, PROTOCOL_SOURCES));
}

function readGitHead(repoRoot: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
	} catch {
		return undefined;
	}
}

export interface CreateBuildInfoOptions {
	component: string;
	repoRoot: string;
	/** 仓库根相对路径。 */
	inputs: string[];
	/** 产物是否实现线协议（UI、桥）。 */
	protocol?: boolean;
	buildId?: string;
}

export function createBuildInfo(options: CreateBuildInfoOptions): BuildInfo {
	const files = hashFilesSync(options.repoRoot, [...new Set(options.inputs)].sort());
	const gitHead = readGitHead(options.repoRoot);
	return {
		schema: 1,
		component: options.component,
		buildId: options.buildId ?? randomUUID(),
		builtAt: new Date().toISOString(),
		...(gitHead ? { gitHead } : {}),
		sourceHash: digestFiles(files),
		...(options.protocol ? { protocolHash: computeProtocolHash(options.repoRoot) } : {}),
		files,
	};
}

export function writeBuildInfo(outDir: string, info: BuildInfo): void {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, BUILD_INFO_FILE), `${JSON.stringify(info, null, "\t")}\n`, "utf8");
}

export function readBuildInfo(dir: string): BuildInfo | undefined {
	try {
		const info = JSON.parse(readFileSync(join(dir, BUILD_INFO_FILE), "utf8")) as Partial<BuildInfo>;
		if (
			info.schema !== 1 ||
			typeof info.buildId !== "string" ||
			typeof info.files !== "object" ||
			info.files === null
		) {
			return undefined;
		}
		return info as BuildInfo;
	} catch {
		return undefined;
	}
}

/**
 * 运行时比对：重新哈希 build-info 记录的输入，找出内容已变或已删除的文件。
 * mtime+size 都没变的文件复用上次的哈希，反复检查（每次 WS 重连）基本只花 stat 的钱。
 */
export class SourceHashCache {
	private readonly entries = new Map<string, { mtimeMs: number; size: number; hash: string }>();

	private async hash(absolute: string): Promise<string> {
		let info: { mtimeMs: number; size: number };
		try {
			const stats = await stat(absolute);
			info = { mtimeMs: stats.mtimeMs, size: stats.size };
		} catch {
			this.entries.delete(absolute);
			return MISSING;
		}
		const cached = this.entries.get(absolute);
		if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
		try {
			const hash = hashText(await readFile(absolute));
			this.entries.set(absolute, { ...info, hash });
			return hash;
		} catch {
			return MISSING;
		}
	}

	async changedInputs(repoRoot: string, info: BuildInfo): Promise<string[]> {
		const changed: string[] = [];
		for (const [input, recorded] of Object.entries(info.files)) {
			if ((await this.hash(join(repoRoot, input))) !== recorded) changed.push(input);
		}
		return changed;
	}
}
