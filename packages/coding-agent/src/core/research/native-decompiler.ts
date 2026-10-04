import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getToolsDir } from "../../config.ts";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_FUNCTIONS = 200;
const MAX_STRINGS = 2_000;
const MAX_REFERENCES = 2_000;
const MAX_CODE_CHARACTERS = 16_384;
const MAX_TIMEOUT_MS = 15 * 60_000;
const EXPORT_SCRIPT = "OwlNativeExport.java";

export interface NativeDecompilerInput {
	/** Boundary of the explicitly selected application. */
	cwd: string;
	path: string;
	/** Snapshots and artifacts stay here; Ghidra's transient project uses a checked OS temp directory. */
	outputCwd: string;
	maxFunctions?: number;
	maxStrings?: number;
	maxCrossReferences?: number;
	maxFileBytes?: number;
	timeoutMs?: number;
}

export interface NativeDecompilerInventory {
	status: "available" | "toolMissing" | "invalidConfiguration";
	engine: "ghidra";
	configuredBy?: "OWL_RESEARCH_GHIDRA_HOME" | "GHIDRA_INSTALL_DIR" | "native-toolchain.json";
	installationPath?: string;
	launcherPath?: string;
	launcherSha256?: string;
	version?: string;
	javaHome?: string;
	message: string;
}

export interface NativeFunction {
	address: string;
	name: string;
	signature: string;
	decompiled: boolean;
	truncated: boolean;
	pseudocode: string;
	error: string;
}

export interface NativeString {
	address: string;
	value: string;
	truncated: boolean;
}

export interface NativeCrossReference {
	from: string;
	to: string;
	type: string;
}

export interface NativeDecompilerArtifact {
	kind: "pseudocode" | "report" | "log" | "exporter";
	path: string;
	bytes: number;
	sha256: string;
}

export interface NativeDecompilerReport {
	status: "toolMissing" | "unsupported" | "complete" | "partial" | "failed";
	engine: "ghidra";
	outputKind: "decompiled-pseudocode";
	selectedPath: string;
	inputSha256: string;
	inputBytes: number;
	tool: NativeDecompilerInventory;
	outputDirectory?: string;
	functions: NativeFunction[];
	strings: NativeString[];
	crossReferences: NativeCrossReference[];
	artifacts: NativeDecompilerArtifact[];
	languageId?: string;
	analysisTimedOut: boolean;
	truncated: boolean;
	originalUnchanged: boolean | null;
	snapshotUnchanged?: boolean;
	durationMs: number;
	warnings: string[];
	message: string;
}

export interface NativeDecompilerProcessOptions {
	cwd: string;
	timeoutMs: number;
	maxBuffer: number;
	signal?: AbortSignal;
	javaHome?: string;
}

export interface NativeDecompilerProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	logLimitExceeded?: boolean;
}

/** Internal test seam, never exposed as Agent tool arguments. */
export interface NativeDecompilerRuntime {
	inventory?: () => Promise<NativeDecompilerInventory>;
	run?: (
		launcherPath: string,
		args: string[],
		options: NativeDecompilerProcessOptions,
	) => Promise<NativeDecompilerProcessResult>;
}

function bounded(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
		throw new Error(`参数必须是 ${minimum} 至 ${maximum} 之间的整数`);
	}
	return selected;
}

function within(root: string, path: string): boolean {
	const local = relative(root, path);
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

async function fencedPath(root: string, path: string): Promise<string> {
	const candidate = resolve(root, path);
	if (!within(root, candidate)) throw new Error("路径超出已授权输入目录");
	let current = root;
	for (const component of relative(root, candidate).split(sep).filter(Boolean)) {
		current = join(current, component);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("拒绝符号链接或目录联接路径");
	}
	const canonical = await realpath(candidate);
	if (!within(root, canonical)) throw new Error("真实路径超出已授权输入目录");
	return canonical;
}

async function fingerprint(
	path: string,
	maximum: number,
	signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > maximum) throw new Error("输入不是普通文件或大小超出上限");
		const hash = createHash("sha256");
		const chunk = Buffer.alloc(1024 * 1024);
		let position = 0;
		while (position < before.size) {
			signal?.throwIfAborted();
			const read = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
			if (!read.bytesRead) throw new Error("文件读取期间被截断");
			hash.update(chunk.subarray(0, read.bytesRead));
			position += read.bytesRead;
		}
		const after = await handle.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new Error("文件读取期间发生变化");
		}
		return { bytes: before.size, sha256: hash.digest("hex") };
	} finally {
		await handle.close();
	}
}

/** No discovery through model-provided command paths or package/application scripts. */
export async function inspectNativeDecompilerAvailability(): Promise<NativeDecompilerInventory> {
	let configuredBy: NativeDecompilerInventory["configuredBy"] = process.env.OWL_RESEARCH_GHIDRA_HOME
		? "OWL_RESEARCH_GHIDRA_HOME"
		: process.env.GHIDRA_INSTALL_DIR
			? "GHIDRA_INSTALL_DIR"
			: undefined;
	let configured = configuredBy ? process.env[configuredBy] : undefined;
	let javaHome: string | undefined;
	try {
		if (!configured) {
			const toolsRoot = await realpath(join(getToolsDir(), "research-decompilers"));
			const configurationPath = await fencedPath(toolsRoot, "native-toolchain.json");
			const configurationStat = await lstat(configurationPath);
			if (!configurationStat.isFile() || configurationStat.size > 16_384)
				throw new Error("原生工具链宿主配置无效或过大");
			const configuration = record(JSON.parse(await readFile(configurationPath, "utf8")) as unknown, [
				"ghidraHome",
				"javaHome",
			]);
			configured = textField(configuration.ghidraHome, 4096);
			if (configuration.javaHome !== undefined) javaHome = textField(configuration.javaHome, 4096);
			configuredBy = "native-toolchain.json";
		}
		if (!isAbsolute(configured) || /[\x00\r\n]/.test(configured)) throw new Error("Ghidra 配置必须是绝对安装目录");
		const installationPath = await realpath(configured);
		if (!(await lstat(installationPath)).isDirectory()) throw new Error("Ghidra 配置不是目录");
		const launcherPath = await fencedPath(
			installationPath,
			join("support", process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless"),
		);
		const propertiesPath = await fencedPath(installationPath, join("Ghidra", "application.properties"));
		const propertiesStat = await lstat(propertiesPath);
		if (!propertiesStat.isFile() || propertiesStat.size > 65_536) throw new Error("Ghidra 应用元数据无效");
		const properties = await readFile(propertiesPath, "utf8");
		if (!/^application\.name=Ghidra\s*$/m.test(properties)) throw new Error("未发现 Ghidra 应用标识");
		const version = /^application\.version=([^\r\n]{1,100})$/m.exec(properties)?.[1];
		const launcher = await fingerprint(launcherPath, 1024 * 1024);
		if (javaHome) {
			if (!isAbsolute(javaHome)) throw new Error("宿主 Java 配置必须是绝对目录");
			javaHome = await realpath(javaHome);
			const java = await fencedPath(javaHome, join("bin", process.platform === "win32" ? "java.exe" : "java"));
			if (!(await lstat(java)).isFile()) throw new Error("宿主 Java 配置没有 bin/java");
		}
		return {
			status: "available",
			engine: "ghidra",
			configuredBy,
			installationPath,
			launcherPath,
			launcherSha256: launcher.sha256,
			version,
			javaHome,
			message: "已定位宿主配置的 Ghidra 头部分析器；运行时 Java 或分析器错误会单独报告。",
		};
	} catch (error) {
		if (!configuredBy && error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {
				status: "toolMissing",
				engine: "ghidra",
				message: "未配置 Ghidra。请由宿主配置原生工具链或 OWL_RESEARCH_GHIDRA_HOME；Agent 不能指定工具命令。",
			};
		}
		return {
			status: "invalidConfiguration",
			engine: "ghidra",
			configuredBy,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

async function freshOutput(workspace: string): Promise<string> {
	let current = await realpath(resolve(workspace));
	if (!(await lstat(current)).isDirectory()) throw new Error("输出工作区必须是目录");
	const root = current;
	for (const component of [".owl", "research", "native", randomUUID()]) {
		current = join(current, component);
		try {
			await mkdir(current);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const stat = await lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("输出目录包含链接或非目录");
		if (!within(root, await realpath(current))) throw new Error("输出路径超出工作区");
	}
	return current;
}

async function copySnapshot(source: string, destination: string, maximum: number, signal?: AbortSignal): Promise<void> {
	const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	const output = await open(destination, "wx", 0o600);
	try {
		const stat = await input.stat();
		if (!stat.isFile() || stat.size > maximum) throw new Error("快照输入大小超出上限");
		let position = 0;
		const buffer = Buffer.alloc(1024 * 1024);
		while (position < stat.size) {
			signal?.throwIfAborted();
			const read = await input.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
			if (!read.bytesRead) throw new Error("快照读取期间输入被截断");
			let written = 0;
			while (written < read.bytesRead) {
				const write = await output.write(buffer, written, read.bytesRead - written, position + written);
				if (!write.bytesWritten) throw new Error("快照写入未完成");
				written += write.bytesWritten;
			}
			position += read.bytesRead;
		}
	} finally {
		await Promise.all([input.close(), output.close()]);
	}
}

async function nativePeReason(path: string): Promise<string | undefined> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		const dos = Buffer.alloc(64);
		if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") {
			return "本适配器只处理 PE 原生程序，输入没有有效的 MZ 头";
		}
		const peOffset = dos.readUInt32LE(60);
		if (peOffset < 64 || peOffset > stat.size - 24) return "PE 头偏移超出文件边界";
		const header = Buffer.alloc(24);
		if (
			(await handle.read(header, 0, header.length, peOffset)).bytesRead !== header.length ||
			header.readUInt32LE(0) !== 0x4550
		) {
			return "没有有效的 PE 签名";
		}
		const optionalSize = header.readUInt16LE(20);
		if (optionalSize < 96 || optionalSize > 4096 || peOffset + 24 + optionalSize > stat.size) return "PE 可选头无效";
		const optional = Buffer.alloc(optionalSize);
		if ((await handle.read(optional, 0, optionalSize, peOffset + 24)).bytesRead !== optionalSize)
			return "PE 可选头不完整";
		const magic = optional.readUInt16LE(0);
		const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
		if (!directories) return "不支持的 PE 可选头类型";
		if (optionalSize >= directories + 15 * 8 && optional.readUInt32LE(directories + 14 * 8) !== 0) {
			return "发现 CLR 目录。此适配器输出原生 C 伪代码，托管 IL 需要独立的 .NET 反编译器";
		}
		return undefined;
	} finally {
		await handle.close();
	}
}

function terminateTree(pid: number): void {
	if (process.platform === "win32") {
		execFile(
			join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
			["/pid", String(pid), "/T", "/F"],
			{ windowsHide: true },
			() => {},
		);
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The process may already have exited.
		}
	}
}

/** Executes the configured analyzer only. Neither the imported PE nor its resources are launched. */
async function runAnalyzer(
	launcherPath: string,
	args: string[],
	options: NativeDecompilerProcessOptions,
): Promise<NativeDecompilerProcessResult> {
	options.signal?.throwIfAborted();
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"HOME",
		"USERPROFILE",
		"JAVA_HOME",
		"JDK_HOME",
		"LANG",
	]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	if (options.javaHome) {
		env.JAVA_HOME = options.javaHome;
		env.JDK_HOME = options.javaHome;
		env.PATH = `${join(options.javaHome, "bin")}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
	}
	const profile = join(options.cwd, "analyzer-profile");
	await mkdir(profile);
	env.APPDATA = profile;
	env.LOCALAPPDATA = profile;
	env.USERPROFILE = profile;
	env.HOME = profile;
	let executable = launcherPath;
	let arguments_ = args;
	if (process.platform === "win32") {
		// Batch launchers require cmd.exe. Reject expansion/control characters even
		// inside quotes; all arguments are fixed switches and fresh local paths.
		if ([launcherPath, ...args].some((value) => /[\x00-\x1f"%^!&|<>]/.test(value))) {
			throw new Error("Windows 分析器路径包含不支持的命令解释字符");
		}
		executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
		arguments_ = ["/d", "/s", "/c", `"${[launcherPath, ...args].map((value) => `"${value}"`).join(" ")}"`];
	}
	return new Promise((resolveResult, reject) => {
		const child = spawn(executable, arguments_, {
			cwd: options.cwd,
			env,
			windowsHide: true,
			windowsVerbatimArguments: process.platform === "win32",
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let timedOut = false;
		let logLimitExceeded = false;
		const stop = () => {
			if (child.pid) terminateTree(child.pid);
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", stop, { once: true });
		const collect = (target: Buffer[], chunk: Buffer) => {
			if (bytes + chunk.length > options.maxBuffer) {
				logLimitExceeded = true;
				stop();
				return;
			}
			bytes += chunk.length;
			target.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.on("error", reject);
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", stop);
			if (options.signal?.aborted) {
				reject(options.signal.reason ?? new Error("分析已取消"));
				return;
			}
			resolveResult({
				exitCode,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
				logLimitExceeded,
			});
		});
	});
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分析器报告不是有效对象");
	const item = value as Record<string, unknown>;
	if (Object.keys(item).some((key) => !fields.includes(key))) throw new Error("分析器报告包含未审查字段");
	return item;
}

function textField(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || value.includes("\0"))
		throw new Error("分析器文本字段无效或超出上限");
	return value;
}

function booleanField(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("分析器状态字段无效");
	return value;
}

function address(value: unknown, externalSymbol = false): string {
	const result = textField(value, 100);
	if (externalSymbol && result === "Entry Point") return result;
	if (!/^(?:[A-Za-z0-9_.-]+:)?[a-fA-F0-9]{1,32}$/.test(result)) throw new Error("分析器地址字段无效");
	return result;
}

function array(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error("分析器条目数量无效或超出上限");
	return value;
}

function validateExport(
	value: unknown,
	sha256: string,
	limits: { functions: number; strings: number; references: number },
): {
	functions: NativeFunction[];
	strings: NativeString[];
	crossReferences: NativeCrossReference[];
	languageId: string;
	analysisTimedOut: boolean;
	truncated: boolean;
} {
	const item = record(value, [
		"schemaVersion",
		"inputSha256",
		"languageId",
		"analysisTimedOut",
		"truncated",
		"functions",
		"strings",
		"crossReferences",
	]);
	if (item.schemaVersion !== 1 || item.inputSha256 !== sha256) throw new Error("分析器报告格式或输入哈希不匹配");
	const functions = array(item.functions, limits.functions).map((value) => {
		const fn = record(value, ["address", "name", "signature", "decompiled", "truncated", "pseudocode", "error"]);
		const result: NativeFunction = {
			address: address(fn.address),
			name: textField(fn.name, 1024),
			signature: textField(fn.signature, 2048),
			decompiled: booleanField(fn.decompiled),
			truncated: booleanField(fn.truncated),
			pseudocode: textField(fn.pseudocode, MAX_CODE_CHARACTERS),
			error: textField(fn.error, 1024),
		};
		if (result.decompiled !== !!result.pseudocode.trim()) throw new Error("函数反编译状态与伪代码不匹配");
		return result;
	});
	if (new Set(functions.map((fn) => fn.address)).size !== functions.length) throw new Error("分析器函数地址重复");
	const strings = array(item.strings, limits.strings).map((value) => {
		const data = record(value, ["address", "value", "truncated"]);
		return {
			address: address(data.address),
			value: textField(data.value, 1024),
			truncated: booleanField(data.truncated),
		};
	});
	const crossReferences = array(item.crossReferences, limits.references).map((value) => {
		const ref = record(value, ["from", "to", "type"]);
		return { from: address(ref.from, ref.type === "EXTERNAL"), to: address(ref.to), type: textField(ref.type, 100) };
	});
	return {
		functions,
		strings,
		crossReferences,
		languageId: textField(item.languageId, 200),
		analysisTimedOut: booleanField(item.analysisTimedOut),
		truncated: booleanField(item.truncated),
	};
}

/** Static native decompilation with bounded, provenance-checked C-like pseudocode. */
export async function runNativeDecompiler(
	input: NativeDecompilerInput,
	signal?: AbortSignal,
	runtime: NativeDecompilerRuntime = {},
): Promise<NativeDecompilerReport> {
	const started = Date.now();
	signal?.throwIfAborted();
	const maxFileBytes = bounded(input.maxFileBytes, MAX_FILE_BYTES, MAX_FILE_BYTES);
	const limits = {
		functions: bounded(input.maxFunctions, 50, MAX_FUNCTIONS),
		strings: bounded(input.maxStrings, 500, MAX_STRINGS, 0),
		references: bounded(input.maxCrossReferences, 500, MAX_REFERENCES, 0),
	};
	const timeoutMs = bounded(input.timeoutMs, 5 * 60_000, MAX_TIMEOUT_MS, 1_000);
	const root = await realpath(resolve(input.cwd));
	const selectedPath = await fencedPath(root, input.path);
	const original = await fingerprint(selectedPath, maxFileBytes, signal);
	const tool = await (runtime.inventory ?? inspectNativeDecompilerAvailability)();
	const result: NativeDecompilerReport = {
		status: "toolMissing",
		engine: "ghidra",
		outputKind: "decompiled-pseudocode",
		selectedPath,
		inputSha256: original.sha256,
		inputBytes: original.bytes,
		tool,
		functions: [],
		strings: [],
		crossReferences: [],
		artifacts: [],
		analysisTimedOut: false,
		truncated: false,
		originalUnchanged: true,
		durationMs: Date.now() - started,
		warnings: [
			"输出为反编译伪代码，原始变量名、注释、类型和工程结构可能已被编译器丢弃；不得称为精确恢复的原始源码。",
		],
		message: tool.message,
	};
	const unsupported = await nativePeReason(selectedPath);
	if (unsupported) {
		result.status = "unsupported";
		result.message = unsupported;
		return result;
	}
	if (tool.status !== "available" || !tool.launcherPath || !tool.launcherSha256) return result;
	signal?.throwIfAborted();
	const outputDirectory = await freshOutput(input.outputCwd);
	result.outputDirectory = outputDirectory;
	const snapshot = join(outputDirectory, "input.exe");
	const scripts = join(outputDirectory, "scripts");
	// Ghidra rejects any absolute project-path component starting with '.', including .owl.
	const temporaryRoot = await realpath(tmpdir());
	const project = await mkdtemp(join(temporaryRoot, "owl-ghidra-"));
	const exportPath = join(outputDirectory, "native-export.json");
	await mkdir(scripts);
	await copySnapshot(selectedPath, snapshot, maxFileBytes, signal);
	if ((await fingerprint(snapshot, maxFileBytes, signal)).sha256 !== original.sha256)
		throw new Error("输入在复制快照期间发生变化");
	const exporterPath = join(scripts, EXPORT_SCRIPT);
	await writeFile(exporterPath, JAVA_EXPORTER, { flag: "wx", mode: 0o600 });
	const args = [
		project,
		"owl-native",
		"-import",
		snapshot,
		"-loader",
		"PeLoader",
		"-loader-loadLibraries",
		"false",
		"-loader-linkExistingProjectLibraries",
		"false",
		"-analysisTimeoutPerFile",
		String(Math.max(1, Math.floor(timeoutMs / 2000))),
		"-max-cpu",
		"2",
		"-scriptPath",
		scripts,
		"-postScript",
		EXPORT_SCRIPT,
		exportPath,
		String(limits.functions),
		String(limits.strings),
		String(limits.references),
		"-readOnly",
		"-deleteProject",
		"-log",
		join(outputDirectory, "ghidra-analysis.log"),
		"-scriptlog",
		join(outputDirectory, "ghidra-script.log"),
	];
	try {
		if ((await fingerprint(tool.launcherPath, 1024 * 1024, signal)).sha256 !== tool.launcherSha256)
			throw new Error("Ghidra 启动器在发现后发生变化");
		result.originalUnchanged = null;
		const processResult = await (runtime.run ?? runAnalyzer)(tool.launcherPath, args, {
			cwd: outputDirectory,
			timeoutMs,
			maxBuffer: MAX_LOG_BYTES,
			signal,
			javaHome: tool.javaHome,
		});
		signal?.throwIfAborted();
		const logPath = join(outputDirectory, "process.log");
		const log = `stdout:\n${processResult.stdout}\nstderr:\n${processResult.stderr}`;
		if (Buffer.byteLength(log, "utf8") > MAX_LOG_BYTES + 32) throw new Error("分析器日志超出上限");
		await writeFile(logPath, log, { flag: "wx", mode: 0o600 });
		const unchanged = await fingerprint(await fencedPath(root, input.path), maxFileBytes, signal);
		result.originalUnchanged = unchanged.sha256 === original.sha256;
		result.snapshotUnchanged =
			(await fingerprint(await fencedPath(outputDirectory, snapshot), maxFileBytes, signal)).sha256 ===
			original.sha256;
		if (!result.originalUnchanged || !result.snapshotUnchanged)
			throw new Error("输入原件或分析快照发生变化，拒绝发布反编译结果");
		if (processResult.timedOut || processResult.logLimitExceeded || processResult.exitCode !== 0) {
			result.analysisTimedOut = processResult.timedOut === true;
			throw new Error(
				processResult.timedOut
					? "Ghidra 整体分析超时"
					: processResult.logLimitExceeded
						? "Ghidra 日志超过上限"
						: `Ghidra 退出码 ${processResult.exitCode ?? "unknown"}`,
			);
		}
		const verifiedExportPath = await fencedPath(outputDirectory, exportPath);
		const exportFingerprint = await fingerprint(verifiedExportPath, MAX_REPORT_BYTES, signal);
		const reportBytes = await readFile(verifiedExportPath);
		if (
			reportBytes.length !== exportFingerprint.bytes ||
			createHash("sha256").update(reportBytes).digest("hex") !== exportFingerprint.sha256
		)
			throw new Error("分析器报告读取期间发生变化");
		const exported = validateExport(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes)) as unknown,
			original.sha256,
			limits,
		);
		Object.assign(result, exported);
		const recovered = result.functions.filter((fn) => fn.decompiled);
		const pseudocodePath = join(outputDirectory, "pseudocode.c");
		const pseudocode = recovered
			.map(
				(fn) =>
					`/* Ghidra address ${fn.address}; decompiled pseudocode${fn.truncated ? "; truncated" : ""} */\n${fn.pseudocode}\n`,
			)
			.join("\n");
		await writeFile(pseudocodePath, pseudocode, { flag: "wx", mode: 0o600 });
		for (const [kind, path] of [
			["report", verifiedExportPath],
			["pseudocode", pseudocodePath],
			["log", logPath],
			["exporter", exporterPath],
		] as const) {
			result.artifacts.push({
				kind,
				path,
				...(await fingerprint(await fencedPath(outputDirectory, path), MAX_REPORT_BYTES, signal)),
			});
		}
		result.truncated ||= result.functions.some((fn) => fn.truncated) || result.strings.some((data) => data.truncated);
		result.status =
			recovered.length === 0
				? "partial"
				: result.analysisTimedOut || result.truncated || recovered.length !== result.functions.length
					? "partial"
					: "complete";
		result.message = `Ghidra 实际导出 ${recovered.length}/${result.functions.length} 个函数的反编译伪代码、${result.strings.length} 条已定义字符串和 ${result.crossReferences.length} 条交叉引用。`;
		if (!recovered.length) result.warnings.push("没有函数成功导出伪代码；不能据此声称恢复了源码。");
		if (result.analysisTimedOut || result.truncated)
			result.warnings.push("分析或导出达到预算，结果只覆盖已导出的部分。");
	} catch (error) {
		signal?.throwIfAborted();
		result.status = "failed";
		if (result.originalUnchanged === null) result.warnings.push("原件的运行后哈希校验未完成，未确认原件保持不变");
		result.functions = [];
		result.strings = [];
		result.crossReferences = [];
		result.artifacts = [];
		result.message = error instanceof Error ? error.message : String(error);
	} finally {
		try {
			const canonicalProject = await realpath(project);
			if (
				dirname(canonicalProject) === temporaryRoot &&
				basename(canonicalProject).startsWith("owl-ghidra-") &&
				!(await lstat(project)).isSymbolicLink()
			) {
				await rm(canonicalProject, { recursive: true, force: true });
			} else result.warnings.push("临时分析项目路径不匹配，未进行清理");
		} catch {
			result.warnings.push("临时分析项目清理未完成，分析状态和已生成证据保持原样");
		}
	}
	result.durationMs = Date.now() - started;
	return result;
}

// Reviewed exporter based on Ghidra's HeadlessScript, DecompInterface and Listing
// APIs. It reads the imported program database only; it never invokes application
// code, scripts, external commands, a debugger, or target resources.
// https://ghidra.re/ghidra_docs/api/ghidra/app/util/headless/HeadlessScript.html
// https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/DecompInterface.html
// https://github.com/NationalSecurityAgency/ghidra/blob/master/Ghidra/RuntimeScripts/support/analyzeHeadlessREADME.md
const JAVA_EXPORTER = String.raw`// Export bounded native decompiler evidence without executing the imported target.
//@category OWL.Research
import ghidra.app.util.headless.HeadlessScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.Address;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class OwlNativeExport extends HeadlessScript {
    private boolean truncated = false;
    private final List<String> references = new ArrayList<>();
    private int maxReferences;
    private String cut(String value, int limit) {
        if (value == null) return "";
        if (value.length() > limit) { truncated = true; return value.substring(0, limit); }
        return value;
    }
    private String quote(String value) {
        StringBuilder output = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') output.append('\\').append(c);
            else if (c < 32 || Character.isSurrogate(c)) output.append(String.format("\\u%04x", (int)c));
            else output.append(c);
        }
        return output.append('"').toString();
    }
    private void referencesTo(Address target) throws Exception {
        ReferenceIterator iterator = currentProgram.getReferenceManager().getReferencesTo(target);
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            if (references.size() >= maxReferences) { truncated = true; break; }
            Reference reference = iterator.next();
            references.add("{\"from\":" + quote(reference.getFromAddress().toString()) +
                ",\"to\":" + quote(reference.getToAddress().toString()) +
                ",\"type\":" + quote(cut(reference.getReferenceType().toString(), 100)) + "}");
        }
    }
    @Override public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 4 || currentProgram == null) throw new IllegalArgumentException("Invalid OWL exporter arguments");
        Path destination = Paths.get(arguments[0]);
        int maxFunctions = Integer.parseInt(arguments[1]);
        int maxStrings = Integer.parseInt(arguments[2]);
        maxReferences = Integer.parseInt(arguments[3]);
        if (maxFunctions < 1 || maxFunctions > 200 || maxStrings < 0 || maxStrings > 2000 || maxReferences < 0 || maxReferences > 2000) throw new IllegalArgumentException("Invalid OWL exporter limits");
        List<String> functions = new ArrayList<>();
        List<String> strings = new ArrayList<>();
        DecompInterface decompiler = new DecompInterface();
        try {
            decompiler.toggleCCode(true);
            decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("Cannot initialize Ghidra decompiler");
            FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
            while (iterator.hasNext()) {
                monitor.checkCancelled();
                Function function = iterator.next();
                if (function.isExternal()) continue;
                if (functions.size() >= maxFunctions) { truncated = true; break; }
                DecompileResults result = decompiler.decompileFunction(function, 15, monitor);
                boolean completed = result != null && result.decompileCompleted() && result.getDecompiledFunction() != null;
                String code = completed ? result.getDecompiledFunction().getC() : "";
                if (code == null || code.trim().length() == 0) { code = ""; completed = false; }
                boolean codeTruncated = code.length() > 16384;
                code = cut(code, 16384);
                functions.add("{\"address\":" + quote(function.getEntryPoint().toString()) +
                    ",\"name\":" + quote(cut(function.getName(), 1024)) +
                    ",\"signature\":" + quote(cut(function.getSignature().getPrototypeString(), 2048)) +
                    ",\"decompiled\":" + completed + ",\"truncated\":" + codeTruncated +
                    ",\"pseudocode\":" + quote(code) +
                    ",\"error\":" + quote(completed ? "" : cut(result == null ? "No decompiler result" : result.getErrorMessage(), 1024)) + "}");
                referencesTo(function.getEntryPoint());
            }
            DataIterator data = currentProgram.getListing().getDefinedData(true);
            int examined = 0;
            while (data.hasNext()) {
                monitor.checkCancelled();
                if (++examined > 200000) { truncated = true; break; }
                Data item = data.next();
                Object value = item.getValue();
                if (!(value instanceof String)) continue;
                if (strings.size() >= maxStrings) { truncated = true; break; }
                String text = (String)value;
                strings.add("{\"address\":" + quote(item.getAddress().toString()) +
                    ",\"value\":" + quote(cut(text, 1024)) + ",\"truncated\":" + (text.length() > 1024) + "}");
                referencesTo(item.getAddress());
            }
        } finally { decompiler.dispose(); }
        String report = "{\"schemaVersion\":1,\"inputSha256\":" + quote(currentProgram.getExecutableSHA256()) +
            ",\"languageId\":" + quote(currentProgram.getLanguageID().toString()) +
            ",\"analysisTimedOut\":" + analysisTimeoutOccurred() +
            ",\"truncated\":" + truncated + ",\"functions\":[" + String.join(",", functions) +
            "],\"strings\":[" + String.join(",", strings) + "],\"crossReferences\":[" + String.join(",", references) + "]}";
        byte[] bytes = report.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 16777216) throw new IllegalStateException("OWL report limit exceeded");
        Files.write(destination, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    }
}
`;
