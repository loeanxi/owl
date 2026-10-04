import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TransformOptions, TransformResult } from "esbuild";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CLUES = 300;
const trustedRequire = createRequire(import.meta.url);

export interface JavascriptRecoveryInput {
	/** Canonical boundary of the explicitly selected application resources. */
	inputRoot: string;
	/** User workspace; outputs never replace installed application files. */
	outputCwd: string;
	/** Explicit relative paths, using forward slashes, to JS/CJS/MJS files. */
	names: string[];
}

export interface JavascriptClue {
	kind: "module" | "ipc" | "export" | "feature";
	value: string;
	/** UTF-8 byte offset in the complete original source. Lexical evidence only. */
	offset: number;
}

export interface RecoveredJavascriptFile {
	path: string;
	sourcePath: string;
	originalPath: string;
	readablePath?: string;
	bytes: number;
	sha256: string;
	readableBytes?: number;
	readableSha256?: string;
	normalization: "readable" | "parseError" | "formatterMissing";
	clues: JavascriptClue[];
	cluesTruncated: boolean;
	warnings: string[];
}

export interface JavascriptRecoveryReport {
	status: "recovered" | "partial";
	inputRoot: string;
	outputDirectory: string;
	manifestPath: string;
	createdAt: string;
	method: "static-source-normalization";
	normalizer: { name: "esbuild"; available: boolean; version?: string };
	files: RecoveredJavascriptFile[];
	totalBytes: number;
	warnings: string[];
}

interface JavascriptNormalizer {
	transform(source: string, options: TransformOptions): Promise<TransformResult>;
	version: string;
}

function within(root: string, path: string): boolean {
	const local = relative(root, path);
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

function validateName(name: string): string {
	if (!name || name.length > 1_024 || isAbsolute(name) || name.includes("\\") || !/\.(?:js|cjs|mjs)$/i.test(name)) {
		throw new Error("需要明确选择相对路径的 JS、CJS 或 MJS 文件");
	}
	for (const part of name.split("/")) {
		if (
			!part ||
			part === "." ||
			part === ".." ||
			/[\x00-\x1f<>:"|?*]/.test(part) ||
			/[. ]$/.test(part) ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
		) {
			throw new Error("拒绝不安全的源文件路径");
		}
	}
	return name;
}

async function fencedPath(root: string, name: string): Promise<string> {
	const path = resolve(root, ...name.split("/"));
	if (!within(root, path)) throw new Error("源文件超出输入目录");
	let current = root;
	for (const component of relative(root, path).split(sep).filter(Boolean)) {
		current = join(current, component);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("拒绝读取符号链接源文件路径");
	}
	const canonical = await realpath(path);
	if (!within(root, canonical)) throw new Error("源文件真实路径超出输入目录");
	return canonical;
}

async function makeDirectory(root: string, path: string): Promise<void> {
	if (!within(root, path)) throw new Error("恢复输出超出工作区");
	let current = root;
	for (const component of relative(root, path).split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			await mkdir(current);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const info = await lstat(current);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("拒绝符号链接或非目录输出路径");
		if (!within(root, await realpath(current))) throw new Error("输出真实路径超出工作区");
	}
}

function lexicalClues(source: string): { clues: JavascriptClue[]; truncated: boolean } {
	const candidates: { kind: JavascriptClue["kind"]; index: number; value: string }[] = [];
	const patterns: { kind: JavascriptClue["kind"]; regex: RegExp }[] = [
		{ kind: "module", regex: /(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*)["']([^"'\r\n]{1,180})["']/g },
		{
			kind: "ipc",
			regex: /\bipc(?:Renderer|Main)\s*\.\s*(?:invoke|send|on|once|handle)\s*\(\s*["']([A-Za-z0-9_:./-]{1,120})["']/g,
		},
		{ kind: "export", regex: /\b(?:exports|module\.exports)\.([A-Za-z_$][\w$]{0,79})\s*=/g },
		{ kind: "export", regex: /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]{0,79})/g },
		{
			kind: "feature",
			regex: /\b([A-Za-z_$][\w$]{0,79})\s*:\s*(?:\([^\r\n)]{0,120}\)|[A-Za-z_$][\w$]{0,79})\s*=>/g,
		},
	];
	let truncated = false;
	for (const { kind, regex } of patterns) {
		let count = 0;
		for (const match of source.matchAll(regex)) {
			if (count++ >= MAX_CLUES) {
				truncated = true;
				break;
			}
			const value = match[1];
			if (/(?:token|secret|password|api.?key|bearer|\?|#)/i.test(value)) continue;
			if (
				kind === "feature" &&
				!/(?:device|firmware|usb|audio|config|store|window|updat|mouse|key|driver|theme|lang)/i.test(value)
			) {
				continue;
			}
			candidates.push({ kind, index: match.index, value });
		}
	}
	candidates.sort((a, b) => a.index - b.index);
	if (candidates.length > MAX_CLUES) truncated = true;
	const clues: JavascriptClue[] = [];
	let previousIndex = 0;
	let byteOffset = 0;
	for (const candidate of candidates.slice(0, MAX_CLUES)) {
		byteOffset += Buffer.byteLength(source.slice(previousIndex, candidate.index), "utf8");
		previousIndex = candidate.index;
		clues.push({ kind: candidate.kind, value: candidate.value, offset: byteOffset });
	}
	return { clues, truncated };
}

/**
 * Copies explicitly selected source and parses it into readable JavaScript.
 * The transform API accepts source text only: no entrypoints, plugins, imports,
 * loader execution, or application code evaluation. It does not decompile JSC.
 * An optional installed esbuild is resolved from OWL, never from the target app.
 */
export async function recoverJavascriptSources(
	input: JavascriptRecoveryInput,
	signal?: AbortSignal,
): Promise<JavascriptRecoveryReport> {
	signal?.throwIfAborted();
	if (!Array.isArray(input.names) || input.names.length < 1 || input.names.length > MAX_FILES) {
		throw new Error(`每轮必须明确选择 1 至 ${MAX_FILES} 个源文件`);
	}
	const names = input.names.map(validateName);
	if (new Set(names.map((name) => (process.platform === "win32" ? name.toLowerCase() : name))).size !== names.length) {
		throw new Error("源文件选择重复");
	}
	const inputRoot = await realpath(resolve(input.inputRoot));
	const outputRoot = await realpath(resolve(input.outputCwd));
	if (!(await lstat(inputRoot)).isDirectory() || !(await lstat(outputRoot)).isDirectory()) {
		throw new Error("输入目录和工作区必须是已存在的目录");
	}
	const sources: { path: string; sourcePath: string; buffer: Buffer; text: string }[] = [];
	let totalBytes = 0;
	for (const name of names) {
		signal?.throwIfAborted();
		const sourcePath = await fencedPath(inputRoot, name);
		const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error("源文件必须是普通文件");
			if (stat.size > MAX_FILE_BYTES) throw new Error("单个源文件超出 8 MiB 读取上限");
			totalBytes += stat.size;
			if (totalBytes > MAX_TOTAL_BYTES) throw new Error("源文件总大小超出 24 MiB 读取上限");
			const buffer = Buffer.alloc(stat.size);
			let position = 0;
			while (position < buffer.length) {
				signal?.throwIfAborted();
				const result = await handle.read(buffer, position, Math.min(65_536, buffer.length - position), position);
				if (!result.bytesRead) throw new Error("源文件提前结束");
				position += result.bytesRead;
			}
			const after = await handle.stat();
			if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("源文件在读取期间发生变更");
			const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
			if (text.includes("\0")) throw new Error("拒绝将二进制内容作为 JavaScript 源文件恢复");
			sources.push({ path: name, sourcePath, buffer, text });
		} finally {
			await handle.close();
		}
	}
	let normalizer: JavascriptNormalizer | undefined;
	try {
		const candidate = trustedRequire("esbuild") as Partial<JavascriptNormalizer>;
		if (typeof candidate.transform === "function" && typeof candidate.version === "string") {
			normalizer = candidate as JavascriptNormalizer;
		}
	} catch {
		// Optional adapter absence never prevents starting ordinary Agent sessions.
	}
	const outputDirectory = join(outputRoot, ".owl", "research", "recovered", randomUUID());
	const report: JavascriptRecoveryReport = {
		status: "recovered",
		inputRoot,
		outputDirectory,
		manifestPath: join(outputDirectory, "manifest.json"),
		createdAt: new Date().toISOString(),
		method: "static-source-normalization",
		normalizer: { name: "esbuild", available: !!normalizer, version: normalizer?.version },
		files: [],
		totalBytes,
		warnings: [
			"输出为已存在的源文件副本与静态语法规范化结果；不代表原始工程、注释、变量名或混淆已全部恢复。",
			"模块、IPC、导出和功能名称仅为词法线索，不证明对应业务处理实现或运行行为。",
		],
	};
	await makeDirectory(outputRoot, dirname(outputDirectory));
	await mkdir(outputDirectory);
	try {
		let outputBytes = 0;
		for (const source of sources) {
			signal?.throwIfAborted();
			const originalPath = join(outputDirectory, "original", ...source.path.split("/"));
			outputBytes += source.buffer.length;
			if (outputBytes > MAX_OUTPUT_BYTES) throw new Error("恢复输出超出 64 MiB 总大小上限");
			await makeDirectory(outputRoot, dirname(originalPath));
			await writeFile(originalPath, source.buffer, { flag: "wx", signal });
			const lexical = lexicalClues(source.text);
			const file: RecoveredJavascriptFile = {
				path: source.path,
				sourcePath: source.sourcePath,
				originalPath,
				bytes: source.buffer.length,
				sha256: createHash("sha256").update(source.buffer).digest("hex"),
				normalization: normalizer ? "parseError" : "formatterMissing",
				clues: lexical.clues,
				cluesTruncated: lexical.truncated,
				warnings: [],
			};
			if (normalizer) {
				let normalized: TransformResult | undefined;
				try {
					// https://esbuild.github.io/api/#transform: isolated source transform.
					normalized = await normalizer.transform(source.text, {
						loader: "js",
						sourcefile: source.path,
						target: "esnext",
						charset: "utf8",
						minify: false,
						treeShaking: false,
						legalComments: "inline",
						logLevel: "silent",
					});
				} catch {
					file.warnings.push("静态语法解析失败，已保留完整原文件副本；未生成可读源码结果。");
				}
				signal?.throwIfAborted();
				if (normalized) {
					const readable = Buffer.from(normalized.code, "utf8");
					outputBytes += readable.length;
					if (outputBytes > MAX_OUTPUT_BYTES) throw new Error("恢复输出超出 64 MiB 总大小上限");
					file.readablePath = join(outputDirectory, "readable", ...source.path.split("/"));
					await makeDirectory(outputRoot, dirname(file.readablePath));
					await writeFile(file.readablePath, readable, { flag: "wx", signal });
					file.readableBytes = readable.length;
					file.readableSha256 = createHash("sha256").update(readable).digest("hex");
					file.normalization = "readable";
					if (normalized.warnings.length)
						file.warnings.push(`静态解析发出 ${normalized.warnings.length} 条诊断。`);
				}
			} else {
				file.warnings.push("OWL 运行环境未提供 esbuild 静态解析器；已保留源码副本，没有伪造可读源码。");
			}
			if (file.normalization !== "readable") report.status = "partial";
			report.files.push(file);
		}
		signal?.throwIfAborted();
		await writeFile(report.manifestPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", signal });
		return report;
	} catch (error) {
		// Only this call's fresh UUID directory can be removed on failure.
		if (within(outputRoot, outputDirectory) && !(await lstat(outputDirectory)).isSymbolicLink()) {
			await rm(outputDirectory, { recursive: true, force: true });
		}
		throw error;
	}
}
