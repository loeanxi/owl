import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getToolsDir } from "../../config.ts";

const ENGINE = "12.6.228.30";
const RELEASE_URL = "https://github.com/xqy2006/jsc2js/releases/tag/12.6.228.30";
const RELEASE_SHA256 = "b8c87c661ebb561db4363ebf48eb9e92288961d233b947f465e1d0303854a6b4";
const SOURCE_COMMITS = new Set([
	"d240cec90dd3ea371504c24bb1fb1ea5aad4e81a",
	"87a35e1e186bd1d86fca6ba500e203a273a6e1bb",
]);
const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 32 * 1024 * 1024;
const HEADER_SIZE = 32;
const WARNINGS = [
	"输出是从 V8 字节码重建的近似 JavaScript，不保证原变量名、注释、完整源码或语义等价。",
	"匹配版本的第三方 d8 补丁会绕过部分 V8 缓存校验，并可能以 Hole 或 undefined 替代无法恢复的对象；成功退出不证明无信息丢失。",
	"只调用固定反序列化与反汇编入口，未执行样本 EXE、加载器或重建代码；独立子进程不是操作系统沙箱。",
];

export interface BytecodeDecompilerFile {
	path: string;
	sha256: string;
}

export interface BytecodeDecompilerManifest {
	schemaVersion: 1;
	adapter: "jsc2js-view8";
	engine: "12.6.228.30";
	releaseUrl: string;
	releaseArchiveSha256: string;
	sourceCommit: string;
	d8: BytecodeDecompilerFile;
	snapshot: BytecodeDecompilerFile;
	python: BytecodeDecompilerFile;
	view8: BytecodeDecompilerFile;
	files: BytecodeDecompilerFile[];
}

export interface BytecodeDecompilerAvailability {
	status: "available" | "toolMissing" | "unsupported" | "invalidToolchain";
	toolchainHome: string;
	engine: string;
	reason?: string;
	manifest?: BytecodeDecompilerManifest;
	verifiedFiles?: BytecodeDecompilerFile[];
}

export interface BytecodeDecompilerInput {
	cwd: string;
	path: string;
	outputCwd: string;
	timeoutMs?: number;
}

export interface BytecodeDecompilerProcessOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeout: number;
	maxBuffer: number;
	windowsHide: true;
	signal?: AbortSignal;
}

export type BytecodeDecompilerRunner = (
	file: string,
	args: string[],
	options: BytecodeDecompilerProcessOptions,
) => Promise<{ stdout: string; stderr: string }>;

/** Internal fixture seam; tool arguments never expose executable or script paths. */
export interface BytecodeDecompilerTestRuntime {
	toolchainHome?: string;
	platform?: NodeJS.Platform;
	run?: BytecodeDecompilerRunner;
}

export interface BytecodeDecompilerArtifact {
	kind: "inputCopy" | "disassembly" | "reconstruction" | "diagnostics";
	path: string;
	bytes: number;
	sha256: string;
}

export interface BytecodeDecompilerReport {
	status: "completed" | "partial" | "unsupported" | "toolMissing" | "failed" | "cancelled";
	approximate: true;
	targetExecuted: false;
	osSandbox: false;
	inputPath?: string;
	inputSha256?: string;
	inputBytes?: number;
	header?: {
		magic: string;
		versionHash: string;
		sourceLength: number;
		flagsHash: string;
		readOnlySnapshotChecksum: string;
		payloadLength: number;
		payloadChecksum: string;
	};
	engine: string;
	outputDirectory?: string;
	functionCount: number;
	opcodeCount: number;
	artifacts: BytecodeDecompilerArtifact[];
	toolchain?: BytecodeDecompilerAvailability;
	warnings: string[];
	errors: string[];
	limits: { inputBytes: number; outputBytes: number; timeoutMs: number };
}

function within(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

async function fencedFile(root: string, path: string): Promise<string> {
	const requested = resolve(root, path);
	if (!within(root, requested)) throw new Error("路径超出所选目录");
	const segments = relative(root, requested).split(sep).filter(Boolean);
	let cursor = root;
	for (const segment of segments) {
		cursor = join(cursor, segment);
		if ((await lstat(cursor)).isSymbolicLink()) throw new Error("拒绝读取链接路径");
	}
	const canonical = await realpath(requested);
	if (!within(root, canonical)) throw new Error("真实路径超出所选目录");
	if (!(await lstat(canonical)).isFile()) throw new Error("需要普通文件");
	return canonical;
}

function sha256(buffer: Buffer | string): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestFile(value: unknown): value is BytecodeDecompilerFile {
	return (
		record(value) &&
		typeof value.path === "string" &&
		value.path.length > 0 &&
		value.path.length < 2_048 &&
		typeof value.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.sha256)
	);
}

function parseManifest(value: unknown): BytecodeDecompilerManifest {
	if (
		!record(value) ||
		value.schemaVersion !== 1 ||
		value.adapter !== "jsc2js-view8" ||
		value.engine !== ENGINE ||
		value.releaseUrl !== RELEASE_URL ||
		value.releaseArchiveSha256 !== RELEASE_SHA256 ||
		typeof value.sourceCommit !== "string" ||
		!SOURCE_COMMITS.has(value.sourceCommit) ||
		!manifestFile(value.d8) ||
		!manifestFile(value.snapshot) ||
		!manifestFile(value.python) ||
		!manifestFile(value.view8) ||
		!Array.isArray(value.files) ||
		value.files.length === 0 ||
		value.files.length > 512 ||
		!value.files.every(manifestFile)
	) {
		throw new Error("工具清单格式、固定版本或来源校验失败");
	}
	return value as unknown as BytecodeDecompilerManifest;
}

async function pythonFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const queue = [root];
	let entries = 0;
	while (queue.length > 0) {
		signal?.throwIfAborted();
		const dir = queue.shift()!;
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (++entries > 1_024) throw new Error("View8 目录条目超出上限");
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error("View8 目录包含链接");
			if (entry.isDirectory()) queue.push(path);
			else if (/\.(?:py|pyc|pyd)$/i.test(entry.name)) files.push(path);
		}
	}
	return files;
}

/** Validates installed, operator configured tools; never downloads or starts them. */
export async function inspectBytecodeDecompilerAvailability(
	signal?: AbortSignal,
	testRuntime: BytecodeDecompilerTestRuntime = {},
): Promise<BytecodeDecompilerAvailability> {
	signal?.throwIfAborted();
	const home = resolve(
		testRuntime.toolchainHome ?? process.env.OWL_RESEARCH_BYTECODE_HOME ?? join(getToolsDir(), "research-decompilers"),
	);
	const result: BytecodeDecompilerAvailability = { status: "toolMissing", toolchainHome: home, engine: ENGINE };
	if ((testRuntime.platform ?? process.platform) !== "win32") {
		return { ...result, status: "unsupported", reason: "当前固定适配器仅支持 Windows x64 工具链" };
	}
	try {
		const root = await realpath(home);
		const manifestPath = await fencedFile(root, "toolchain.json");
		if ((await lstat(manifestPath)).size > 256 * 1024) throw new Error("工具清单超出读取上限");
		const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
		result.manifest = manifest;
		result.status = "invalidToolchain";
		const verified: BytecodeDecompilerFile[] = [];
		const declared = new Map<string, string>();
		let scriptBytes = 0;
		for (const file of [manifest.d8, manifest.snapshot, manifest.view8, ...manifest.files]) {
			signal?.throwIfAborted();
			if (isAbsolute(file.path)) throw new Error("工具清单中的资源必须使用相对路径");
			const path = await fencedFile(root, file.path);
			const previous = declared.get(path);
			if (previous && previous !== file.sha256) throw new Error("工具清单含冲突哈希");
			if (previous) continue;
			const stat = await lstat(path);
			if (stat.size > MAX_OUTPUT) throw new Error("工具资源超出读取上限");
			if (/\.(?:py|pyc|pyd)$/i.test(path)) {
				scriptBytes += stat.size;
				if (scriptBytes > MAX_SCRIPT_BYTES) throw new Error("工具脚本总量超出上限");
			}
			const data = await readFile(path, { signal });
			if (sha256(data) !== file.sha256) throw new Error(`工具哈希不匹配：${file.path}`);
			declared.set(path, file.sha256);
			verified.push({ path, sha256: file.sha256 });
		}
		const view8 = await fencedFile(root, manifest.view8.path);
		for (const path of await pythonFiles(dirname(view8), signal)) {
			if (!declared.has(path)) throw new Error(`View8 包含未校验脚本：${relative(root, path)}`);
		}
		if (!isAbsolute(manifest.python.path)) throw new Error("Python 运行时必须使用管理员配置的绝对路径");
		const python = await realpath(manifest.python.path);
		if ((await lstat(manifest.python.path)).isSymbolicLink() || !(await lstat(python)).isFile())
			throw new Error("Python 运行时不是普通文件");
		const pythonStat = await lstat(python);
		if (pythonStat.size > MAX_OUTPUT) throw new Error("Python 运行时超出读取上限");
		if (sha256(await readFile(python, { signal })) !== manifest.python.sha256) throw new Error("Python 运行时哈希不匹配");
		verified.push({ path: python, sha256: manifest.python.sha256 });
		result.status = "available";
		result.verifiedFiles = verified;
		return result;
	} catch (error) {
		signal?.throwIfAborted();
		result.reason = error instanceof Error ? error.message : String(error);
		if (record(error) && error.code !== "ENOENT") result.status = "invalidToolchain";
		return result;
	}
}

const runProcess: BytecodeDecompilerRunner = (file, args, options) =>
	new Promise((resolveRun, reject) => {
		execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolveRun({ stdout, stderr });
		});
	});

async function outputDirectory(root: string): Promise<string> {
	let cursor = root;
	for (const part of [".owl", "research", "decompiled"]) {
		cursor = join(cursor, part);
		await mkdir(cursor).catch((error: unknown) => {
			if (!record(error) || error.code !== "EEXIST") throw error;
		});
		const stat = await lstat(cursor);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !within(root, await realpath(cursor)))
			throw new Error("输出目录包含链接或超出工作区");
	}
	return mkdtemp(join(cursor, "jsc-"));
}

function cleanEnvironment(output: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
		TEMP: output,
		TMP: output,
		TMPDIR: output,
	};
	for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "LANG"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

async function artifact(
	root: string,
	path: string,
	kind: BytecodeDecompilerArtifact["kind"],
	signal?: AbortSignal,
): Promise<BytecodeDecompilerArtifact> {
	const safe = await fencedFile(root, path);
	const stat = await lstat(safe);
	if (stat.size > MAX_OUTPUT) throw new Error("生成结果超过大小上限");
	const data = await readFile(safe, { signal });
	return { kind, path: safe, bytes: data.length, sha256: sha256(data) };
}

/** Only the pinned decoder processes a copied cached-data file; reconstructed code is never evaluated. */
export async function runBytecodeDecompiler(
	input: BytecodeDecompilerInput,
	signal?: AbortSignal,
	testRuntime: BytecodeDecompilerTestRuntime = {},
): Promise<BytecodeDecompilerReport> {
	const timeout = Math.min(Math.max(Math.floor(input.timeoutMs ?? 60_000), 1_000), 120_000);
	const report: BytecodeDecompilerReport = {
		status: "failed",
		approximate: true,
		targetExecuted: false,
		osSandbox: false,
		engine: ENGINE,
		functionCount: 0,
		opcodeCount: 0,
		artifacts: [],
		warnings: [...WARNINGS],
		errors: [],
		limits: { inputBytes: MAX_INPUT, outputBytes: MAX_OUTPUT, timeoutMs: timeout },
	};
	try {
		signal?.throwIfAborted();
		if (!Number.isFinite(timeout)) throw new Error("无效超时参数");
		const sourceRoot = await realpath(resolve(input.cwd));
		const path = await fencedFile(sourceRoot, input.path);
		report.inputPath = path;
		if (!/\.(?:jsc|cjsc)$/i.test(path)) {
			report.status = "unsupported";
			report.errors.push("此适配器只接受 V8 .jsc/.cjsc 缓存文件");
			return report;
		}
		const stat = await lstat(path);
		if (stat.size < HEADER_SIZE || stat.size > MAX_INPUT) throw new Error("JSC 文件截断或超过输入大小上限");
		const data = await readFile(path, { signal });
		if (data.length !== stat.size || data.length > MAX_INPUT) throw new Error("JSC 文件在读取期间变化");
		report.inputBytes = data.length;
		report.inputSha256 = sha256(data);
		const hex = (offset: number) => `0x${data.readUInt32LE(offset).toString(16).padStart(8, "0")}`;
		report.header = {
			magic: hex(0),
			versionHash: hex(4),
			sourceLength: data.readUInt32LE(8) & 0x7fffffff,
			flagsHash: hex(12),
			readOnlySnapshotChecksum: hex(16),
			payloadLength: data.readUInt32LE(20),
			payloadChecksum: hex(24),
		};
		// Official V8 12.6 header and version hash, independently matched to Electron 31.7.4.
		// https://github.com/v8/v8/blob/12.6.228.30/src/snapshot/code-serializer.h
		if (data.readUInt32LE(0) !== 0xc0de063a || data.readUInt32LE(4) !== 0xa5e2d63c) {
			report.status = "unsupported";
			report.errors.push("未找到与 JSC 魔数和版本哈希同时匹配的适配器；不会修改输入头或尝试不兼容版本");
			return report;
		}
		if (report.header.payloadLength !== data.length - HEADER_SIZE || report.header.payloadLength === 0)
			throw new Error("JSC 头声明的 payload 长度与文件边界不一致");
		const available = await inspectBytecodeDecompilerAvailability(signal, testRuntime);
		report.toolchain = available;
		if (available.status !== "available" || !available.manifest) {
			report.status = available.status === "unsupported" ? "unsupported" : "toolMissing";
			report.errors.push(available.reason ?? "固定反编译工具链未安装或校验失败");
			return report;
		}
		if (!input.outputCwd) throw new Error("需要明确的输出工作区");
		const outputRoot = await realpath(resolve(input.outputCwd));
		signal?.throwIfAborted();
		const output = await outputDirectory(outputRoot);
		report.outputDirectory = output;
		const copied = join(output, "input.jsc");
		await writeFile(copied, data, { flag: "wx", signal });
		report.artifacts.push(await artifact(outputRoot, copied, "inputCopy", signal));
		const manifest = available.manifest;
		const runner = testRuntime.run ?? runProcess;
		const options: BytecodeDecompilerProcessOptions = {
			cwd: output,
			env: cleanEnvironment(output),
			timeout,
			maxBuffer: MAX_OUTPUT,
			windowsHide: true,
			signal,
		};
		const toolRoot = await realpath(available.toolchainHome);
		const d8 = await fencedFile(toolRoot, manifest.d8.path);
		const snapshot = await fencedFile(toolRoot, manifest.snapshot.path);
		// The snapshot is an authenticated decoder resource, never supplied by the sample.
		const d8Result = await runner(
			d8,
			["--snapshot_blob", snapshot, "-e", `loadjsc(${JSON.stringify(copied.replaceAll("\\", "/"))});`],
			options,
		);
		if (Buffer.byteLength(d8Result.stdout) > MAX_OUTPUT || Buffer.byteLength(d8Result.stderr) > MAX_OUTPUT)
			throw new Error("反汇编进程输出超过上限");
		const dumpPath = join(output, "disasm.txt");
		await writeFile(dumpPath, d8Result.stdout, { flag: "wx", signal });
		report.artifacts.push(await artifact(outputRoot, dumpPath, "disassembly", signal));
		const functions = new Set(
			Array.from(d8Result.stdout.matchAll(/(?:0x)?([a-f0-9]+):\s*\[SharedFunctionInfo\]/gi), (match) => match[1]),
		);
		report.functionCount = functions.size;
		report.opcodeCount = Array.from(d8Result.stdout.matchAll(/@\s+\d+\s*:\s*[a-f0-9 ]+\s+[A-Z][A-Za-z0-9]+/g)).length;
		if (functions.size === 0 || report.opcodeCount === 0) throw new Error("工具未产出可验证的函数和字节码指令");
		const startCount = d8Result.stdout.match(/Start SharedFunctionInfo/g)?.length ?? 0;
		const endCount = d8Result.stdout.match(/End SharedFunctionInfo/g)?.length ?? 0;
		if (startCount !== endCount) report.warnings.push("反汇编函数块不完整，结果只按部分恢复处理");
		if (d8Result.stderr.trim()) report.warnings.push(`d8 诊断：${d8Result.stderr.slice(0, 4_096)}`);
		const view8 = await fencedFile(toolRoot, manifest.view8.path);
		const reconstructed = join(output, "reconstructed.js");
		const python = await realpath(manifest.python.path);
		const viewResult = await runner(
			python,
			["-E", "-s", "-S", "-B", view8, "--disassembled", dumpPath, reconstructed],
			options,
		);
		if (Buffer.byteLength(viewResult.stdout) > MAX_OUTPUT || Buffer.byteLength(viewResult.stderr) > MAX_OUTPUT)
			throw new Error("重建进程输出超过上限");
		const recovered = await artifact(outputRoot, reconstructed, "reconstruction", signal);
		if (recovered.bytes === 0) throw new Error("重建文件为空");
		report.artifacts.push(recovered);
		const diagnostics = `${d8Result.stderr}\n${viewResult.stdout}\n${viewResult.stderr}`;
		const diagnosticsPath = join(output, "diagnostics.txt");
		await writeFile(diagnosticsPath, diagnostics.slice(0, 65_536), { flag: "wx", signal });
		report.artifacts.push(await artifact(outputRoot, diagnosticsPath, "diagnostics", signal));
		const errors = diagnostics
			.split(/\r?\n/)
			.filter((line) => /warning|error|failed|stopped after|unsupported|unknown|corrupt|fallback/i.test(line))
			.slice(0, 40)
			.map((line) => line.slice(0, 1_024));
		report.warnings.push(...errors);
		const recoveryText = await readFile(reconstructed, { encoding: "utf8", signal });
		if (/unknown bytecode|unsupported opcode|placeholder|func_unknown|stopped after|<unknown>|<Hole>/i.test(recoveryText))
			report.warnings.push("近似代码含未知对象、占位或不支持的指令，需结合原始反汇编审阅");
		report.status = errors.length > 0 || startCount !== endCount || report.warnings.length > WARNINGS.length ? "partial" : "completed";
		return report;
	} catch (error) {
		report.status = signal?.aborted ? "cancelled" : "failed";
		report.errors.push(error instanceof Error ? error.message : String(error));
		return report;
	}
}
