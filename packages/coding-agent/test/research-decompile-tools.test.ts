import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { normalizeResearchResult } from "../src/core/research/agent.ts";
import type { BytecodeDecompilerInput, BytecodeDecompilerReport } from "../src/core/research/bytecode-decompiler.ts";
import * as bytecode from "../src/core/research/bytecode-decompiler.ts";
import {
	buildResearchDecompileResult,
	createResearchDecompileTool,
	RESEARCH_DECOMPILE_TOOL,
	type ResearchDecompileReport,
	runResearchDecompile,
} from "../src/core/research/decompile-tools.ts";
import type { NativeDecompilerInput, NativeDecompilerReport } from "../src/core/research/native-decompiler.ts";
import * as native from "../src/core/research/native-decompiler.ts";
import type { ResearchResult } from "../src/core/research/types.ts";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";

const temporary: string[] = [];

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "owl-decompile-wrapper-"));
	temporary.push(root);
	return root;
}

function digest(source: Buffer | string): string {
	return createHash("sha256").update(source).digest("hex");
}

// A synthetic PE header used only as local routing input; no native process starts.
function toyPe(): Buffer {
	const buffer = Buffer.alloc(1_024);
	buffer.writeUInt16LE(0x5a4d, 0);
	buffer.writeUInt32LE(0x80, 0x3c);
	buffer.writeUInt32LE(0x4550, 0x80);
	buffer.writeUInt16LE(0x8664, 0x84);
	buffer.writeUInt16LE(1, 0x86);
	buffer.writeUInt16LE(240, 0x94);
	buffer.writeUInt16LE(0x20b, 0x98);
	return buffer;
}

async function toyApplication(input: string): Promise<{ exe: string; app: string; main: string; jsc: string }> {
	const exe = join(input, "toy.exe");
	const app = join(input, "resources", "app");
	await mkdir(join(app, "out", "main"), { recursive: true });
	await mkdir(join(app, "out", "preload"), { recursive: true });
	await mkdir(join(app, "out", "renderer"), { recursive: true });
	await writeFile(exe, toyPe());
	await writeFile(join(app, "package.json"), JSON.stringify({ name: "public-toy", main: "./out/main/index.js" }));
	const main = join(app, "out", "main", "index.js");
	const jsc = join(app, "out", "main", "index.jsc");
	await writeFile(main, 'require("./index.jsc");');
	await writeFile(jsc, "public toy cached data; NEVER LOAD");
	await writeFile(
		join(app, "out", "preload", "index.js"),
		'const electron=require("electron");const getDevice=()=>electron.ipcRenderer.invoke("getDevice");',
	);
	await writeFile(join(app, "out", "renderer", "index.js"), "const settings={getConfig:()=>1};");
	return { exe, app, main, jsc };
}

function asar(header: unknown, body: Buffer): Buffer {
	const json = Buffer.from(JSON.stringify(header));
	const headerPickle = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
	headerPickle.writeUInt32LE(headerPickle.length - 4, 0);
	headerPickle.writeInt32LE(json.length, 4);
	json.copy(headerPickle, 8);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	return Buffer.concat([sizePickle, headerPickle, body]);
}

async function toyArchive(input: string): Promise<string> {
	const metadata = Buffer.from(JSON.stringify({ name: "public-asar", main: "out/main.js" }));
	const main = Buffer.from('require("./main.jsc");');
	const jsc = Buffer.from("public toy cached data NEVER LOAD");
	const preload = Buffer.from('const electron=require("electron");electron.ipcRenderer.invoke("getDevice");');
	const path = join(input, "app.asar");
	await writeFile(
		path,
		asar(
			{
				files: {
					"package.json": { size: metadata.length, offset: "0" },
					out: {
						files: {
							"main.js": { size: main.length, offset: String(metadata.length) },
							"main.jsc": { size: jsc.length, offset: String(metadata.length + main.length) },
							"preload.js": {
								size: preload.length,
								offset: String(metadata.length + main.length + jsc.length),
							},
						},
					},
					link: { link: "out/main.js" },
				},
			},
			Buffer.concat([metadata, main, jsc, preload]),
		),
	);
	return path;
}

/** Explicit test double: writes toy artifacts, never invokes d8/Python or evaluates cached data. */
async function toyBytecode(
	input: BytecodeDecompilerInput,
	status: BytecodeDecompilerReport["status"] = "partial",
): Promise<BytecodeDecompilerReport> {
	const inputPath = await realpath(resolve(input.cwd, input.path));
	const data = await readFile(inputPath);
	const result: BytecodeDecompilerReport = {
		status,
		approximate: true,
		outputKind: "javascriptLikePseudocode",
		sourceRecoveryVerified: false,
		targetExecuted: false,
		osSandbox: false,
		inputPath,
		inputSha256: digest(data),
		inputBytes: data.length,
		engine: "12.6.228.30",
		functionCount: 0,
		opcodeCount: 0,
		artifacts: [],
		warnings: ["Public fixture adapter; bytecode implementation was not executed."],
		errors: status === "unsupported" ? ["Toy unsupported engine"] : [],
		limits: { inputBytes: 8 * 1024 * 1024, outputBytes: 64 * 1024 * 1024, timeoutMs: input.timeoutMs ?? 60_000 },
	};
	if (status === "partial" || status === "completed") {
		const output = join(input.outputCwd, ".owl", "research", "decompiled", `toy-${randomUUID()}`);
		await mkdir(output, { recursive: true });
		const source =
			"// Synthetic test adapter only; not sample reconstruction.\nfunction toyDevice(){ return undefined; }\n";
		const path = join(output, "reconstructed.js");
		await writeFile(path, source);
		result.outputDirectory = output;
		result.functionCount = 1;
		result.opcodeCount = 2;
		result.artifacts.push({ kind: "reconstruction", path, bytes: Buffer.byteLength(source), sha256: digest(source) });
	}
	return result;
}

async function missingNative(input: NativeDecompilerInput): Promise<NativeDecompilerReport> {
	const data = await readFile(input.path);
	return {
		status: "toolMissing",
		engine: "ghidra",
		outputKind: "decompiled-pseudocode",
		selectedPath: input.path,
		inputSha256: digest(data),
		inputBytes: data.length,
		tool: { status: "toolMissing", engine: "ghidra", message: "No native process permitted in fixture" },
		functions: [],
		strings: [],
		crossReferences: [],
		artifacts: [],
		analysisTimedOut: false,
		truncated: false,
		originalUnchanged: true,
		durationMs: 0,
		warnings: [],
		message: "No native process permitted in fixture",
	};
}

beforeEach(() => {
	vi.spyOn(bytecode, "runBytecodeDecompiler").mockImplementation((input) => toyBytecode(input));
	vi.spyOn(native, "runNativeDecompiler").mockImplementation((input) => missingNative(input));
	vi.spyOn(bytecode, "inspectBytecodeDecompilerAvailability").mockResolvedValue({
		status: "toolMissing",
		toolchainHome: "public-test-toolchain",
		engine: "12.6.228.30",
	});
	vi.spyOn(native, "inspectNativeDecompilerAvailability").mockResolvedValue({
		status: "toolMissing",
		engine: "ghidra",
		message: "Public fixture inventory; no process",
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of temporary.splice(0)) {
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("owl-decompile-wrapper-")) {
			throw new Error("Unsafe decompiler fixture cleanup target");
		}
		await rm(root, { recursive: true, force: true });
	}
});

describe("research decompile routing and evidence", () => {
	it("permits only inventory as read-only and keeps artifact-writing recovery out of plan mode", () => {
		expect(isReadOnlyDesktopTool(RESEARCH_DECOMPILE_TOOL, { action: "inventory" })).toBe(true);
		for (const input of [{}, { action: "decompile" }, { action: "unknown" }, null]) {
			expect(isReadOnlyDesktopTool(RESEARCH_DECOMPILE_TOOL, input)).toBe(false);
		}
	});

	it("auto identifies unpacked application resources, decodes only copied toy JSC input and really formats visible JS", async () => {
		const input = await workspace();
		const output = await workspace();
		const app = await toyApplication(input);
		const originalExe = await readFile(app.exe);
		const originalJsc = await readFile(app.jsc);
		const report = await runResearchDecompile({ path: app.exe }, output);
		expect(report).toMatchObject({ method: "bytecode", status: "partial", targetExecuted: false });
		expect(report.container).toMatchObject({ container: "directory", containerPath: await realpath(app.app) });
		expect(report.bytecode).toHaveLength(1);
		expect(report.javascript?.status).toBe("recovered");
		expect(report.javascript?.files.map((file) => file.path)).toEqual([
			"out/main/index.js",
			"out/preload/index.js",
			"out/renderer/index.js",
		]);
		expect(bytecode.runBytecodeDecompiler).toHaveBeenCalledWith(
			{ cwd: await realpath(app.app), path: "out/main/index.jsc", outputCwd: output, timeoutMs: undefined },
			undefined,
		);
		expect(native.runNativeDecompiler).not.toHaveBeenCalled();
		const preload = report.javascript?.files.find((file) => file.path.includes("preload"));
		expect(await readFile(preload!.readablePath!, "utf8")).toContain('const electron = require("electron");\n');
		for (const file of report.javascript?.files ?? []) expect(file.originalPath.startsWith(output)).toBe(true);
		expect(report.bytecode[0].outputDirectory?.startsWith(output)).toBe(true);
		expect(await readFile(app.exe)).toEqual(originalExe);
		expect(await readFile(app.jsc)).toEqual(originalJsc);
		expect(await readdir(input)).not.toContain(".owl");
	});

	it("respects explicit names without automatically adding main or preload scripts", async () => {
		const input = await workspace();
		const output = await workspace();
		const app = await toyApplication(input);
		const report = await runResearchDecompile({ path: app.exe, names: ["out/preload/index.js"] }, output);
		expect(report.status).toBe("complete");
		expect(report.method).toBe("javascript");
		expect(report.javascript?.files.map((file) => file.path)).toEqual(["out/preload/index.js"]);
		expect(report.bytecode).toEqual([]);
		expect(bytecode.runBytecodeDecompiler).not.toHaveBeenCalled();
		const jscOnly = await runResearchDecompile({ path: app.exe, names: ["out/main/index.jsc"] }, output);
		expect(jscOnly.javascript).toBeUndefined();
		expect(jscOnly.bytecode).toHaveLength(1);
		for (const name of ["../outside.js", "missing.js", "package.json"]) {
			await expect(runResearchDecompile({ path: app.exe, names: [name] }, output)).rejects.toThrow();
		}
	});

	it("extracts exactly selected ASAR entries before static recovery and preserves the archive", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = await toyArchive(input);
		const original = await readFile(path);
		const report = await runResearchDecompile({ path, names: ["out/main.jsc", "out/preload.js"] }, output);
		expect(report.container?.container).toBe("asar");
		expect(report.extraction?.files.map((file) => file.path)).toEqual(["out/main.jsc", "out/preload.js"]);
		expect(report.javascript?.files.map((file) => file.path)).toEqual(["out/preload.js"]);
		expect(report.bytecode[0].inputPath?.startsWith(report.extraction!.outputDirectory)).toBe(true);
		expect(report.extraction?.outputDirectory.startsWith(output)).toBe(true);
		expect(await readFile(path)).toEqual(original);
		expect(await readdir(input)).toEqual(["app.asar"]);
		await expect(runResearchDecompile({ path, names: ["link"] }, output)).rejects.toThrow("普通资源");
	});

	it("reports selected JS resources beyond the eight-file batch as pending instead of silently claiming completion", async () => {
		const input = await workspace();
		const output = await workspace();
		const app = await toyApplication(input);
		const names = Array.from({ length: 9 }, (_, index) => `out/renderer/selected-${index}.js`);
		for (const name of names) await writeFile(join(app.app, ...name.split("/")), "const getDevice=()=>1;");
		const report = await runResearchDecompile({ path: app.exe, engine: "javascript", names }, output);
		expect(report.javascript?.files.map((file) => file.path)).toEqual(names.slice(0, 8));
		expect(report.pendingPaths).toEqual(names.slice(8));
		expect(report.status).toBe("partial");
		const { id: _id, createdAt: _createdAt, ...card } = buildResearchDecompileResult(report);
		expect(normalizeResearchResult(card).status).toBe("partial");
		expect(card.findings.some((finding) => finding.kind === "unverified" && finding.text.includes("未处理"))).toBe(
			true,
		);
	});

	it("does not convert partial, unsupported, missing or failed decoder states into a successful research card", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.jsc");
		await writeFile(path, "public toy data never loaded");
		for (const status of ["partial", "unsupported", "toolMissing", "failed", "cancelled", "completed"] as const) {
			vi.mocked(bytecode.runBytecodeDecompiler).mockImplementationOnce((args) => toyBytecode(args, status));
			const report = await runResearchDecompile({ path, engine: "bytecode", timeoutMs: 3_000 }, output);
			expect(report.status).toBe("partial");
			expect(report.bytecode[0].status).toBe(status);
			const { id, createdAt, ...card } = buildResearchDecompileResult(report);
			expect(id).toMatch(/^[a-f0-9-]{36}$/);
			expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
			expect(normalizeResearchResult(card).status).toBe("partial");
			expect(card.findings.some((finding) => finding.text.includes(status))).toBe(true);
		}
	});

	it("accepts selected local file URLs and quoted JS paths, with no sample evaluation", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "selected source.mjs");
		const code = 'throw new Error("NEVER_EVALUATE_TARGET");export const deviceConfig={getConfig:()=>1};';
		await writeFile(path, code);
		for (const selected of [pathToFileURL(path).href, `"${path}"`]) {
			const report = await runResearchDecompile({ path: selected }, output);
			expect(report).toMatchObject({ status: "complete", method: "javascript", targetExecuted: false });
			expect(report.javascript?.files[0].normalization).toBe("readable");
			expect(report.javascript?.files[0].sha256).toBe(digest(code));
		}
		expect(bytecode.runBytecodeDecompiler).not.toHaveBeenCalled();
		expect(native.runNativeDecompiler).not.toHaveBeenCalled();
	});

	it("routes PE without Electron resources to a mocked native adapter and reports absent tools accurately", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "plain.dll");
		await writeFile(path, toyPe());
		const report = await runResearchDecompile({ path }, output);
		expect(report).toMatchObject({ method: "native", status: "partial", native: { status: "toolMissing" } });
		expect(native.runNativeDecompiler).toHaveBeenCalledWith(
			{
				cwd: await realpath(input),
				path: await realpath(path),
				outputCwd: output,
				timeoutMs: undefined,
				maxFunctions: 100,
			},
			undefined,
		);
		expect(bytecode.runBytecodeDecompiler).not.toHaveBeenCalled();
		expect(await readdir(output)).toEqual([]);
	});

	it("rejects unsafe URLs, alternate streams, unsupported formats, unknown args, directories and selected links", async () => {
		const root = await workspace();
		for (const path of [
			"https://example.invalid/toy.exe",
			"file://remote/toy.exe",
			"file:///toy.exe?download=1",
			"file:///toy.exe#fragment",
			"\\\\server\\share\\toy.exe",
			"\\\\?\\C:\\toy.exe",
			"C:\\toy.exe:stream",
			"toy.js:stream",
			"toy.exe\0",
			"toy.txt",
		]) {
			await expect(runResearchDecompile({ path }, root)).rejects.toThrow();
		}
		for (const value of [{}, { path: "toy.exe", command: "never" }, { path: "toy.exe", engine: "execute" }]) {
			await expect(runResearchDecompile(value, root)).rejects.toThrow();
		}
		const path = join(root, "directory.exe");
		await mkdir(path);
		await expect(runResearchDecompile({ path }, root)).rejects.toThrow("普通文件");
		const link = join(root, "link.exe");
		await symlink(path, link, process.platform === "win32" ? "junction" : "dir");
		await expect(runResearchDecompile({ path: link }, root)).rejects.toThrow("链接");
		expect(bytecode.runBytecodeDecompiler).not.toHaveBeenCalled();
		expect(native.runNativeDecompiler).not.toHaveBeenCalled();
	});

	it("rejects incompatible engines and prevents extra names for single selected JS or JSC", async () => {
		const input = await workspace();
		const output = await workspace();
		const js = join(input, "toy.js");
		const jsc = join(input, "toy.jsc");
		await writeFile(js, "const x=1;");
		await writeFile(jsc, "public toy never load");
		for (const value of [
			{ path: js, engine: "bytecode" },
			{ path: jsc, engine: "javascript" },
			{ path: js, names: ["another.js"] },
			{ path: jsc, names: ["another.jsc"] },
		]) {
			await expect(runResearchDecompile(value, output)).rejects.toThrow();
		}
		expect(await readdir(output)).toEqual([]);
	});

	it("propagates cancellation before any selected file read or adapter and leaves output untouched", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.jsc");
		await writeFile(path, "public cached data never loaded");
		const controller = new AbortController();
		controller.abort(new Error("public fixture cancellation"));
		await expect(runResearchDecompile({ path }, output, controller.signal)).rejects.toThrow("fixture cancellation");
		expect(bytecode.runBytecodeDecompiler).not.toHaveBeenCalled();
		expect(native.runNativeDecompiler).not.toHaveBeenCalled();
		expect(await readdir(output)).toEqual([]);
	});

	it("uses inventory without a workspace or adapter process and emits standard normalized result details for actual JS", async () => {
		const tool = createResearchDecompileTool();
		expect(tool.name).toBe(RESEARCH_DECOMPILE_TOOL);
		expect(tool.executionMode).toBe("sequential");
		const inventory = await tool.execute(
			"inventory",
			{ action: "inventory" },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(inventory.details).toMatchObject({
			decompilerInventory: { bytecode: { status: "toolMissing" }, native: { status: "toolMissing" } },
		});
		expect(bytecode.runBytecodeDecompiler).not.toHaveBeenCalled();
		expect(native.runNativeDecompiler).not.toHaveBeenCalled();
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.js");
		await writeFile(path, "export const getDevice=()=>1;");
		await expect(
			tool.execute("missing-workspace", { path }, undefined, undefined, {} as ExtensionToolContext),
		).rejects.toThrow("工作区");
		const result = await tool.execute("js", { path }, undefined, undefined, { cwd: output } as ExtensionToolContext);
		const details = result.details as { researchDecompile: ResearchDecompileReport; researchResult: ResearchResult };
		expect(details.researchDecompile.targetExecuted).toBe(false);
		const { id, createdAt, ...card } = details.researchResult;
		expect(id).toMatch(/^[a-f0-9-]{36}$/);
		expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
		expect(normalizeResearchResult(card)).toMatchObject({ status: "complete", mode: "binary" });
		expect(card.rows).toHaveLength(1);
		expect(card.sources.every((source) => source.url === undefined)).toBe(true);
		expect(card.findings.every((finding) => finding.kind !== "fact" || finding.sourceIds.length > 0)).toBe(true);
	});

	it("keeps exact pending paths visible to the Agent even when internal toolchain metadata is large", async () => {
		const input = await workspace();
		const output = await workspace();
		const app = await toyApplication(input);
		const names = Array.from({ length: 9 }, (_, index) => `out/renderer/batch-${index}.js`);
		for (const name of names) await writeFile(join(app.app, name), "const config=1;");
		vi.mocked(bytecode.runBytecodeDecompiler).mockImplementationOnce(async (args) => ({
			...(await toyBytecode(args)),
			toolchain: {
				status: "available",
				engine: "12.6.228.30",
				toolchainHome: "public-fixture",
				reason: "INTERNAL_METADATA".repeat(10000),
			},
		}));
		const result = await createResearchDecompileTool().execute(
			"pending",
			{ path: app.exe, names: ["out/main/index.jsc", ...names] },
			undefined,
			undefined,
			{ cwd: output } as ExtensionToolContext,
		);
		const text = result.content.find((block) => block.type === "text");
		if (!text || text.type !== "text") throw new Error("Missing Agent-facing observations");
		expect(text.text).toContain('"pendingPaths":["out/renderer/batch-8.js"]');
		expect(text.text).not.toContain("INTERNAL_METADATA");
		expect(text.text.length).toBeLessThan(64000);
	});
});
