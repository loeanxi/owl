import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 30_000;
const MAX_LIST_ENTRIES = 1_500;
const MAX_DEPTH = 32;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 65_536;
const MAX_EXTRACT_FILES = 512;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACT_BYTES = 128 * 1024 * 1024;
const MAX_UPX_OUTPUT_BYTES = 512 * 1024 * 1024;

export interface ApplicationContainerInput {
	cwd: string;
	path?: string;
	exePath?: string;
	archivePath?: string;
}

export interface ContainerEntry {
	path: string;
	type: "file" | "directory" | "link";
	size?: number;
	unpacked?: boolean;
}

export interface ContainerEvidence {
	path: string;
	note: string;
	bytesRead?: number;
}

export interface ContainerPackage {
	path: string;
	name?: string;
	version?: string;
	main?: string;
}

export interface ContainerJavascript {
	path: string;
	bytesRead: number;
	truncated: boolean;
	/** Fingerprint of exactly the bytes read, not necessarily of the complete file. */
	sha256Read: string;
	signals: { kind: "module" | "ipc" | "window" | "navigation" | "process"; offset: number; snippet: string }[];
}

export interface ApplicationContainerInspection {
	status: "supported" | "unsupported";
	container: "asar" | "directory" | "none";
	selectedPath: string;
	containerPath?: string;
	entries: ContainerEntry[];
	entriesTruncated: boolean;
	package?: ContainerPackage;
	javascript: ContainerJavascript[];
	evidence: ContainerEvidence[];
	warnings: string[];
	capabilities: { list: boolean; readJavascript: boolean; extract: boolean; peUnpack: false };
}

export interface ContainerExtractionInput {
	/** Boundary of the explicitly selected application or archive. */
	cwd: string;
	archivePath: string;
	names: string[];
	/** User workspace; never derive output placement from the installed application. */
	outputCwd: string;
}

export interface ContainerExtraction {
	archivePath: string;
	outputDirectory: string;
	files: { path: string; outputPath: string; bytes: number; sha256: string }[];
	totalBytes: number;
}

interface ArchiveFile extends ContainerEntry {
	type: "file";
	size: number;
	offset?: number;
}

interface ArchiveIndex {
	handle: FileHandle;
	archivePath: string;
	dataOffset: number;
	entries: Map<string, ContainerEntry | ArchiveFile>;
}

function isWithin(root: string, path: string): boolean {
	const local = relative(root, path);
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

async function sourcePath(root: string, path: string): Promise<string> {
	const candidate = resolve(root, path);
	if (!isWithin(root, candidate)) throw new Error("路径超出已授权的输入目录");
	const components = relative(root, candidate).split(sep).filter(Boolean);
	let current = root;
	for (const component of components) {
		current = join(current, component);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("拒绝读取符号链接路径");
	}
	const canonical = await realpath(candidate);
	if (!isWithin(root, canonical)) throw new Error("真实路径超出已授权的输入目录");
	return canonical;
}

function archiveName(name: string): string {
	if (!name || name.length > 1_024 || name.includes("\\") || isAbsolute(name)) {
		throw new Error("无效的容器条目路径");
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
			throw new Error("拒绝不安全的容器条目路径");
		}
	}
	return name;
}

function objectRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ASAR 索引条目无效");
	return value as Record<string, unknown>;
}

async function readBytes(handle: FileHandle, position: number, length: number, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted();
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		signal?.throwIfAborted();
		const read = await handle.read(buffer, offset, length - offset, position + offset);
		if (!read.bytesRead) throw new Error("文件提前结束，容器内容不完整");
		offset += read.bytesRead;
	}
	return buffer;
}

async function readArchive(root: string, path: string, signal?: AbortSignal): Promise<ArchiveIndex> {
	const archivePath = await sourcePath(root, path);
	const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("ASAR 输入必须是普通文件");
		// Official @electron/asar disk.ts and pickle.ts: an 8-byte size Pickle precedes
		// a string Pickle. Its first uint32 is payload size; the string starts after
		// the Pickle header and a signed int32 string length. Packed offsets are
		// relative to 8 + headerSize. No executable code or native module is loaded.
		// https://github.com/electron/asar/blob/main/src/disk.ts
		// https://github.com/electron/asar/blob/main/src/pickle.ts
		const sizePickle = await readBytes(handle, 0, 8, signal);
		if (sizePickle.readUInt32LE(0) !== 4) throw new Error("ASAR 大小 Pickle 无效");
		const headerSize = sizePickle.readUInt32LE(4);
		if (headerSize < 8 || headerSize > MAX_HEADER_BYTES || headerSize > stat.size - 8) {
			throw new Error("ASAR 索引大小超出安全上限或文件边界");
		}
		const header = await readBytes(handle, 8, headerSize, signal);
		const payloadSize = header.readUInt32LE(0);
		const pickleHeaderSize = header.length - payloadSize;
		if (pickleHeaderSize < 4 || pickleHeaderSize % 4 !== 0 || payloadSize < 4) {
			throw new Error("ASAR 索引 Pickle 无效");
		}
		const stringSize = header.readInt32LE(pickleHeaderSize);
		if (stringSize < 0 || stringSize > payloadSize - 4) throw new Error("ASAR 索引字符串长度无效");
		const json = new TextDecoder("utf-8", { fatal: true }).decode(
			header.subarray(pickleHeaderSize + 4, pickleHeaderSize + 4 + stringSize),
		);
		const entries = new Map<string, ContainerEntry | ArchiveFile>();
		const dataOffset = 8 + headerSize;
		const visit = (value: unknown, parent: string, depth: number): void => {
			signal?.throwIfAborted();
			if (depth > MAX_DEPTH) throw new Error("ASAR 目录深度超出安全上限");
			const files = objectRecord(objectRecord(value).files);
			for (const [name, raw] of Object.entries(files)) {
				if (name.includes("/") || name.includes("\\")) throw new Error("ASAR 索引包含不安全名称");
				const path = archiveName(parent ? `${parent}/${name}` : name);
				const entry = objectRecord(raw);
				if (entries.size >= MAX_INDEX_ENTRIES) throw new Error("ASAR 条目数量超出安全上限");
				if ("link" in entry) {
					if (typeof entry.link !== "string") throw new Error("ASAR 链接条目无效");
					entries.set(path, { path, type: "link" });
				} else if ("files" in entry) {
					entries.set(path, { path, type: "directory" });
					visit(entry, path, depth + 1);
				} else {
					if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
						throw new Error("ASAR 文件大小无效");
					}
					if (entry.unpacked !== undefined && typeof entry.unpacked !== "boolean") {
						throw new Error("ASAR unpacked 标记无效");
					}
					const file: ArchiveFile = { path, type: "file", size: entry.size, unpacked: entry.unpacked === true };
					if (!file.unpacked) {
						if (typeof entry.offset !== "string" || !/^\d+$/.test(entry.offset)) {
							throw new Error("ASAR 文件偏移无效");
						}
						file.offset = Number(entry.offset);
						const end = dataOffset + file.offset + file.size;
						if (!Number.isSafeInteger(file.offset) || !Number.isSafeInteger(end) || end > stat.size) {
							throw new Error("ASAR 文件超出容器边界");
						}
					}
					entries.set(path, file);
				}
			}
		};
		visit(JSON.parse(json) as unknown, "", 0);
		return { handle, archivePath, dataOffset, entries };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function archiveFile(
	index: ArchiveIndex,
	root: string,
	name: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ buffer: Buffer; size: number }> {
	const entry = index.entries.get(archiveName(name));
	if (!entry || entry.type !== "file" || entry.size === undefined) throw new Error("容器条目不是普通文件");
	const file = entry as ArchiveFile;
	if (!file.unpacked) {
		return {
			buffer: await readBytes(
				index.handle,
				index.dataOffset + (file.offset ?? 0),
				Math.min(file.size, limit),
				signal,
			),
			size: file.size,
		};
	}
	const path = await sourcePath(root, join(`${index.archivePath}.unpacked`, ...name.split("/")));
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size !== file.size) throw new Error("ASAR 外置文件与索引大小不匹配");
		return { buffer: await readBytes(handle, 0, Math.min(stat.size, limit), signal), size: stat.size };
	} finally {
		await handle.close();
	}
}

async function directoryFile(
	root: string,
	containerPath: string,
	name: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ buffer: Buffer; size: number }> {
	const path = await sourcePath(root, join(containerPath, ...archiveName(name).split("/")));
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("应用资源不是普通文件");
		return { buffer: await readBytes(handle, 0, Math.min(stat.size, limit), signal), size: stat.size };
	} finally {
		await handle.close();
	}
}

async function directoryEntries(root: string, path: string, signal?: AbortSignal): Promise<ContainerEntry[]> {
	const entries: ContainerEntry[] = [];
	const queue = [{ path, parent: "", depth: 0 }];
	while (queue.length && entries.length < MAX_LIST_ENTRIES) {
		signal?.throwIfAborted();
		const current = queue.shift()!;
		const children = await readdir(await sourcePath(root, current.path), { withFileTypes: true });
		children.sort(
			(a, b) =>
				Number(a.name === "node_modules") - Number(b.name === "node_modules") || a.name.localeCompare(b.name),
		);
		for (const child of children) {
			if (entries.length >= MAX_LIST_ENTRIES) break;
			const name = current.parent ? `${current.parent}/${child.name}` : child.name;
			archiveName(name);
			const childPath = join(current.path, child.name);
			const stat = await lstat(childPath);
			if (stat.isSymbolicLink()) entries.push({ path: name, type: "link" });
			else if (stat.isDirectory()) {
				entries.push({ path: name, type: "directory" });
				if (current.depth < MAX_DEPTH && child.name !== "node_modules")
					queue.push({ path: childPath, parent: name, depth: current.depth + 1 });
			} else if (stat.isFile()) entries.push({ path: name, type: "file", size: stat.size });
		}
	}
	return entries;
}

function javascriptSignals(buffer: Buffer): ContainerJavascript["signals"] {
	const text = buffer.toString("utf8");
	const signals: ContainerJavascript["signals"] = [];
	// These are lexical tokens, not a JavaScript parser or a semantic call graph.
	// Return only the matched operation/module name, never whole source lines.
	const patterns: { kind: ContainerJavascript["signals"][number]["kind"]; pattern: RegExp }[] = [
		{ kind: "module", pattern: /(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*)["']([^"'\r\n]{1,180})["']/g },
		{ kind: "ipc", pattern: /\bipc(?:Main|Renderer)\s*\.\s*(?:handle|on|invoke|send)\s*\(/g },
		{ kind: "window", pattern: /\b(?:new\s+)?BrowserWindow\s*\(/g },
		{ kind: "navigation", pattern: /\b(?:loadFile|loadURL|preload)\b/g },
		{ kind: "process", pattern: /\b(?:spawn|execFile|exec|spawnSync|execSync)\s*\(/g },
	];
	for (const { kind, pattern } of patterns) {
		let count = 0;
		for (const match of text.matchAll(pattern)) {
			if (count++ >= 8) break;
			let snippet = kind === "module" ? match[1] : match[0];
			if (/(?:token|secret|password|api.?key|bearer|\?|#)/i.test(snippet)) snippet = "[sensitive value omitted]";
			signals.push({ kind, offset: Buffer.byteLength(text.slice(0, match.index), "utf8"), snippet });
		}
	}
	return signals.sort((a, b) => a.offset - b.offset);
}

/** Static Electron container inspection. It neither loads application code nor unpacks a PE. */
export async function inspectApplicationContainer(
	input: ApplicationContainerInput,
	signal?: AbortSignal,
): Promise<ApplicationContainerInspection> {
	signal?.throwIfAborted();
	const root = await realpath(resolve(input.cwd));
	const selected = input.archivePath ?? input.exePath ?? input.path;
	if (!selected) throw new Error("需要明确选择应用或 ASAR 路径");
	const selectedPath = await sourcePath(root, selected);
	if (!(await lstat(selectedPath)).isFile()) throw new Error("选中的应用或 ASAR 必须是普通文件");
	const result: ApplicationContainerInspection = {
		status: "unsupported",
		container: "none",
		selectedPath,
		entries: [],
		entriesTruncated: false,
		javascript: [],
		evidence: [],
		warnings: [],
		capabilities: { list: false, readJavascript: false, extract: false, peUnpack: false },
	};
	let index: ArchiveIndex | undefined;
	let containerPath: string;
	if (input.archivePath || selectedPath.toLowerCase().endsWith(".asar")) {
		containerPath = selectedPath;
		index = await readArchive(root, containerPath, signal);
	} else {
		const resources = join(dirname(selectedPath), "resources");
		const archivePath = join(resources, "app.asar");
		try {
			containerPath = await sourcePath(root, archivePath);
			index = await readArchive(root, containerPath, signal);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			result.evidence.push({ path: archivePath, note: "未发现相邻 resources/app.asar" });
			try {
				containerPath = await sourcePath(root, join(resources, "app"));
				if (!(await lstat(containerPath)).isDirectory()) throw new Error("resources/app 不是目录");
			} catch (directoryError) {
				if (!(directoryError instanceof Error && "code" in directoryError && directoryError.code === "ENOENT"))
					throw directoryError;
				result.warnings.push("未发现 Electron 应用容器；这不能证明 PE 已脱壳或没有加密。");
				return result;
			}
		}
	}
	try {
		result.status = "supported";
		result.container = index ? "asar" : "directory";
		result.containerPath = containerPath;
		const entries = index ? [...index.entries.values()] : await directoryEntries(root, containerPath, signal);
		result.entries = entries
			.slice(0, MAX_LIST_ENTRIES)
			.map(({ path, type, size, unpacked }) => ({ path, type, size, unpacked }));
		result.entriesTruncated = entries.length >= MAX_LIST_ENTRIES;
		result.capabilities = { list: true, readJavascript: true, extract: !!index, peUnpack: false };
		result.evidence.push({
			path: containerPath,
			note: index ? "已按 Electron ASAR Pickle 格式验证索引及文件边界" : "发现已展开的 Electron resources/app 目录",
		});
		const read = (name: string, limit: number) =>
			index
				? archiveFile(index, root, name, limit, signal)
				: directoryFile(root, containerPath, name, limit, signal);
		try {
			const data = await read("package.json", MAX_PACKAGE_BYTES);
			if (data.size > MAX_PACKAGE_BYTES) throw new Error("package.json 超出读取上限");
			const metadata = objectRecord(JSON.parse(data.buffer.toString("utf8")) as unknown);
			result.package = { path: "package.json" };
			for (const key of ["name", "version", "main"] as const) {
				if (typeof metadata[key] === "string") result.package[key] = metadata[key].slice(0, 1_024);
			}
			result.evidence.push({
				path: `${containerPath}/package.json`,
				note: "读取包名称、版本和入口字段",
				bytesRead: data.buffer.length,
			});
		} catch (error) {
			signal?.throwIfAborted();
			result.warnings.push(`包信息不可用：${error instanceof Error ? error.message : String(error)}`);
		}
		const main = result.package?.main?.replace(/^\.\//, "");
		const scriptEntries = entries
			.filter(
				(entry) =>
					entry.type === "file" &&
					/\.(?:js|cjs|mjs)$/i.test(entry.path) &&
					!entry.path.startsWith("node_modules/"),
			)
			.sort((a, b) => {
				const priority = (path: string) =>
					path.includes("preload/") ? 0 : main && posix.dirname(path) === posix.dirname(main) ? 1 : 2;
				return priority(a.path) - priority(b.path);
			});
		const candidates = [...new Set([...(main ? [main] : []), ...scriptEntries.map((entry) => entry.path)])];
		for (let candidateIndex = 0; candidateIndex < Math.min(candidates.length, 3); candidateIndex++) {
			const name = candidates[candidateIndex];
			try {
				const data = await read(name, MAX_PREVIEW_BYTES);
				const signals = javascriptSignals(data.buffer);
				result.javascript.push({
					path: name,
					bytesRead: data.buffer.length,
					truncated: data.size > data.buffer.length,
					sha256Read: createHash("sha256").update(data.buffer).digest("hex"),
					signals,
				});
				if (candidateIndex === 0) {
					for (const match of signals
						.filter(
							(item) =>
								item.kind === "module" &&
								item.snippet.startsWith(".") &&
								/\.(?:js|cjs|mjs)$/i.test(item.snippet),
						)
						.reverse()) {
						const dependency = posix.join(posix.dirname(name), match.snippet);
						if (!entries.some((entry) => entry.path === dependency && entry.type === "file")) continue;
						const previous = candidates.indexOf(dependency);
						if (previous >= 0) candidates.splice(previous, 1);
						candidates.splice(1, 0, dependency);
					}
				}
				result.evidence.push({
					path: `${containerPath}/${name}`,
					note: "仅读取限长入口代码，未执行",
					bytesRead: data.buffer.length,
				});
			} catch (error) {
				signal?.throwIfAborted();
				result.warnings.push(`入口 ${name} 不可读：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (result.entriesTruncated) result.warnings.push(`目录列表限制为 ${MAX_LIST_ENTRIES} 个条目`);
		if (entries.some((entry) => entry.type === "file" && entry.path.endsWith(".jsc"))) {
			result.warnings.push("发现 .jsc 字节码文件；本工具没有解码或执行字节码，不能声称已恢复其中的源码。");
		}
		result.warnings.push(
			"JS 线索来自限长静态词法匹配，可能出现在注释或字符串中，不保证完整语义调用链；未遍历 node_modules。",
		);
		result.warnings.push("应用资源展开不等于破解加密，也不证明 PE 已脱壳。");
		return result;
	} finally {
		await index?.handle.close();
	}
}

async function outputDirectory(outputCwd: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const root = await realpath(resolve(outputCwd));
	let current = root;
	for (const part of [".owl", "research", "extracted"]) {
		current = join(current, part);
		try {
			await mkdir(current);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const stat = await lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("输出目录包含符号链接或不是目录");
		if (!isWithin(root, await realpath(current))) throw new Error("输出目录超出工作区");
	}
	const output = join(current, randomUUID());
	await mkdir(output);
	return output;
}

async function removeOutput(root: string, output: string): Promise<void> {
	const canonical = await sourcePath(root, output);
	if (!isWithin(root, canonical) || !(await lstat(canonical)).isDirectory()) {
		throw new Error("拒绝清理工作区之外的输出目录");
	}
	await rm(canonical, { recursive: true, force: true });
}

/** Extract only explicit regular-file names to a fresh workspace directory; preserve the archive. */
export async function extractApplicationContainer(
	input: ContainerExtractionInput,
	signal?: AbortSignal,
): Promise<ContainerExtraction> {
	signal?.throwIfAborted();
	if (!input.outputCwd) throw new Error("需要明确指定输出工作区");
	if (!input.names.length || input.names.length > MAX_EXTRACT_FILES) throw new Error("提取文件数量超出安全上限");
	const names = [...new Set(input.names.map(archiveName))];
	const root = await realpath(resolve(input.cwd));
	const outputRoot = await realpath(resolve(input.outputCwd));
	const index = await readArchive(root, input.archivePath, signal);
	let output: string | undefined;
	try {
		let totalBytes = 0;
		for (const name of names) {
			const entry = index.entries.get(name);
			if (!entry || entry.type !== "file" || entry.size === undefined)
				throw new Error("拒绝提取目录、链接或不存在的条目");
			if (entry.size > MAX_FILE_BYTES) throw new Error("单个提取文件超出安全上限");
			totalBytes += entry.size;
			if (totalBytes > MAX_EXTRACT_BYTES) throw new Error("提取总大小超出安全上限");
		}
		output = await outputDirectory(outputRoot, signal);
		const result: ContainerExtraction = {
			archivePath: index.archivePath,
			outputDirectory: output,
			files: [],
			totalBytes,
		};
		for (const name of names) {
			signal?.throwIfAborted();
			const data = await archiveFile(index, root, name, MAX_FILE_BYTES, signal);
			const outputPath = join(output, ...name.split("/"));
			await mkdir(dirname(outputPath), { recursive: true });
			const target = await open(outputPath, "wx", 0o600);
			try {
				await target.writeFile(data.buffer, { signal });
			} finally {
				await target.close();
			}
			result.files.push({
				path: name,
				outputPath,
				bytes: data.buffer.length,
				sha256: createHash("sha256").update(data.buffer).digest("hex"),
			});
		}
		return result;
	} catch (error) {
		if (output) await removeOutput(outputRoot, output);
		throw error;
	} finally {
		await index.handle.close();
	}
}

export interface UpxInput {
	cwd: string;
	path: string;
	outputCwd: string;
}
export interface UpxResult {
	status: "toolMissing" | "unsupported" | "decompressed";
	inputPath: string;
	toolPath?: string;
	outputPath?: string;
	bytes?: number;
	evidence: string[];
}
export interface UpxRunOptions {
	timeout: number;
	maxBuffer: number;
	signal?: AbortSignal;
	windowsHide: true;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
/** Dependency injection is for tests; tool inputs never supply a command or tool path. */
export type UpxRunner = (
	file: string,
	args: string[],
	options: UpxRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

const runUpx: UpxRunner = (file, args, options) =>
	new Promise((resolveRun, reject) => {
		execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolveRun({ stdout, stderr });
		});
	});

/** Only the installed UPX tool runs. The selected executable is always a data argument. */
export async function decompressUpx(
	input: UpxInput,
	signal?: AbortSignal,
	runner: UpxRunner = runUpx,
): Promise<UpxResult> {
	signal?.throwIfAborted();
	const root = await realpath(resolve(input.cwd));
	const inputPath = await sourcePath(root, input.path);
	if (!(await lstat(inputPath)).isFile()) throw new Error("UPX 输入必须是普通文件");
	if (!input.outputCwd) throw new Error("需要明确指定输出工作区");
	const outputRoot = await realpath(resolve(input.outputCwd));
	// UPX's environment variable can inject default options; remove it.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "UPX"));
	const options: UpxRunOptions = {
		timeout: 20_000,
		maxBuffer: 65_536,
		signal,
		windowsHide: true,
		cwd: outputRoot,
		env,
	};
	const result: UpxResult = { status: "toolMissing", inputPath, evidence: [] };
	const locator =
		process.platform === "win32"
			? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
			: "/usr/bin/which";
	let toolPath: string;
	try {
		const located = await runner(locator, [process.platform === "win32" ? "upx.exe" : "upx"], options);
		const candidates = located.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const candidate = candidates.find(
			(path) =>
				isAbsolute(path) &&
				/^(?:upx|upx\.exe)$/i.test(basename(path)) &&
				!isWithin(root, path) &&
				!isWithin(outputRoot, path),
		);
		if (!candidate || (await lstat(candidate)).isSymbolicLink())
			throw new Error("未发现应用或工作区以外的已安装 UPX 工具");
		toolPath = await realpath(candidate);
		if (isWithin(root, toolPath) || isWithin(outputRoot, toolPath))
			throw new Error("拒绝执行应用或工作区内提供的 UPX");
		if (!(await lstat(toolPath)).isFile()) throw new Error("UPX 工具路径不是普通文件");
	} catch (error) {
		signal?.throwIfAborted();
		result.evidence.push(`UPX 工具不可用：${error instanceof Error ? error.message : String(error)}`);
		return result;
	}
	result.toolPath = toolPath;
	result.status = "unsupported";
	try {
		const tested = await runner(toolPath, ["-t", inputPath], options);
		result.evidence.push(`UPX -t 成功：${`${tested.stdout}\n${tested.stderr}`.slice(0, 4_096)}`);
	} catch (error) {
		signal?.throwIfAborted();
		result.evidence.push(`UPX -t 未确认可解压：${error instanceof Error ? error.message : String(error)}`);
		return result;
	}
	const output = await outputDirectory(outputRoot, signal);
	const outputPath = join(output, "unpacked.exe");
	try {
		// Official UPX documents -t (integrity test), -d (decompress), and -o file.
		// https://github.com/upx/upx/blob/devel/doc/upx-doc.html
		const unpacked = await runner(toolPath, ["-d", "-o", outputPath, inputPath], options);
		const safeOutput = await sourcePath(outputRoot, outputPath);
		const stat = await lstat(safeOutput);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_UPX_OUTPUT_BYTES)
			throw new Error("UPX 输出为空或超出安全上限");
		result.status = "decompressed";
		result.outputPath = safeOutput;
		result.bytes = stat.size;
		result.evidence.push(`UPX -d 完成：${`${unpacked.stdout}\n${unpacked.stderr}`.slice(0, 4_096)}`);
		result.evidence.push("已创建新输出并保留原文件；未运行样本。UPX 不能处理所有壳或破解加密。");
		return result;
	} catch (error) {
		await removeOutput(outputRoot, output);
		signal?.throwIfAborted();
		result.evidence.push(`UPX 解压未完成：${error instanceof Error ? error.message : String(error)}`);
		return result;
	}
}
