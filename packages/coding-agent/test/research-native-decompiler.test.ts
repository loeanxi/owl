import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type NativeDecompilerInventory,
	type NativeDecompilerProcessOptions,
	type NativeDecompilerRuntime,
	type NativeFunction,
	runNativeDecompiler,
} from "../src/core/research/native-decompiler.ts";

const temporary: string[] = [];

interface ExportFixture {
	schemaVersion: number;
	inputSha256: string;
	languageId: string;
	analysisTimedOut: boolean;
	truncated: boolean;
	functions: NativeFunction[];
	strings: { address: string; value: string; truncated: boolean }[];
	crossReferences: { from: string; to: string; type: string }[];
}

interface Fixture {
	root: string;
	inputRoot: string;
	outputRoot: string;
	path: string;
	bytes: Buffer;
	tool: NativeDecompilerInventory;
}

function pe(managed = false): Buffer {
	const bytes = Buffer.alloc(1024);
	bytes.write("MZ", 0, "ascii");
	bytes.writeUInt32LE(128, 60);
	bytes.writeUInt32LE(0x4550, 128);
	bytes.writeUInt16LE(0x8664, 132);
	bytes.writeUInt16LE(1, 134);
	bytes.writeUInt16LE(240, 148);
	bytes.writeUInt16LE(0x20b, 152);
	if (managed) bytes.writeUInt32LE(0x2000, 152 + 112 + 14 * 8);
	return bytes;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "owl-native-decompiler-test-"));
	temporary.push(root);
	const inputRoot = join(root, "input");
	const outputRoot = join(root, "output");
	const toolRoot = join(root, "tool");
	await Promise.all([mkdir(inputRoot), mkdir(outputRoot), mkdir(toolRoot)]);
	const path = join(inputRoot, "sample.exe");
	const bytes = pe();
	const launcherPath = join(toolRoot, process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless");
	const launcherBytes = Buffer.from("fixture launcher; never execute");
	await Promise.all([writeFile(path, bytes), writeFile(launcherPath, launcherBytes)]);
	return {
		root,
		inputRoot,
		outputRoot,
		path,
		bytes,
		tool: {
			status: "available",
			engine: "ghidra",
			launcherPath,
			launcherSha256: sha256(launcherBytes),
			message: "Fake adapter for deterministic tests",
		},
	};
}

function exportFixture(inputSha256: string): ExportFixture {
	return {
		schemaVersion: 1,
		inputSha256,
		languageId: "x86:LE:64:default",
		analysisTimedOut: false,
		truncated: false,
		functions: [
			{
				address: "140001000",
				name: "entry",
				signature: "int entry(void)",
				decompiled: true,
				truncated: false,
				pseudocode: "int entry(void) { return 7; }",
				error: "",
			},
		],
		strings: [{ address: "140002000", value: "local fixture", truncated: false }],
		crossReferences: [{ from: "140001010", to: "140002000", type: "DATA" }],
	};
}

function fakeRuntime(
	data: Fixture,
	transform?: (
		report: ExportFixture,
		args: string[],
		options: NativeDecompilerProcessOptions,
	) => Promise<unknown> | unknown,
): NativeDecompilerRuntime {
	return {
		inventory: async () => data.tool,
		run: async (launcher, args, options) => {
			expect(launcher).toBe(data.tool.launcherPath);
			expect(launcher).not.toBe(data.path);
			const snapshot = args[args.indexOf("-import") + 1];
			expect(snapshot).not.toBe(data.path);
			const destination = args[args.indexOf("-postScript") + 2];
			const report = exportFixture(sha256(await readFile(snapshot)));
			const exported = transform ? await transform(report, args, options) : report;
			await writeFile(destination, typeof exported === "string" ? exported : JSON.stringify(exported));
			return { exitCode: 0, stdout: "fixture exported", stderr: "" };
		},
	};
}

afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("native Ghidra adapter with a fake process boundary", () => {
	it("reports missing tools without creating outputs or launching a sample", async () => {
		const data = await fixture();
		let invoked = false;
		const runtime: NativeDecompilerRuntime = {
			inventory: async () => ({ status: "toolMissing", engine: "ghidra", message: "Not configured" }),
			run: async () => {
				invoked = true;
				throw new Error("must not run");
			},
		};
		const result = await runNativeDecompiler(
			{ cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot },
			undefined,
			runtime,
		);
		expect(result.status).toBe("toolMissing");
		expect(result.artifacts).toEqual([]);
		expect(result.functions).toEqual([]);
		expect(invoked).toBe(false);
		expect(await readdir(data.outputRoot)).toEqual([]);
	});

	it("distinguishes unsupported managed IL and invalid PE inputs before invoking Ghidra", async () => {
		const data = await fixture();
		const runtime: NativeDecompilerRuntime = {
			inventory: async () => data.tool,
			run: async () => {
				throw new Error("must not run");
			},
		};
		await writeFile(data.path, pe(true));
		const managed = await runNativeDecompiler(
			{ cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot },
			undefined,
			runtime,
		);
		expect(managed.status).toBe("unsupported");
		expect(managed.message).toContain("CLR");
		await writeFile(data.path, "not an executable");
		const invalid = await runNativeDecompiler(
			{ cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot },
			undefined,
			runtime,
		);
		expect(invalid.status).toBe("unsupported");
		expect(invalid.message).toContain("MZ");
		expect(await readdir(data.outputRoot)).toEqual([]);
	});

	it("uses fixed static import switches and exports pseudocode with input and artifact hashes", async () => {
		const data = await fixture();
		const runtime = fakeRuntime(data, async (report, args, options) => {
			expect(args).toContain("-readOnly");
			expect(args).toContain("-deleteProject");
			expect(args[args.indexOf("-loader") + 1]).toBe("PeLoader");
			expect(args[args.indexOf("-loader-loadLibraries") + 1]).toBe("false");
			expect(args[args.indexOf("-loader-linkExistingProjectLibraries") + 1]).toBe("false");
			expect(args[args.indexOf("-postScript") + 1]).toBe("OwlNativeExport.java");
			expect(options.timeoutMs).toBe(20_000);
			expect(options.maxBuffer).toBe(1024 * 1024);
			const exporter = await readFile(join(args[args.indexOf("-scriptPath") + 1], "OwlNativeExport.java"), "utf8");
			expect(exporter).toContain("decompileFunction");
			expect(exporter).not.toContain("ProcessBuilder");
			return report;
		});
		const result = await runNativeDecompiler(
			{
				cwd: data.inputRoot,
				path: basename(data.path),
				outputCwd: data.outputRoot,
				timeoutMs: 20_000,
				maxFunctions: 2,
			},
			undefined,
			runtime,
		);
		expect(result.status).toBe("complete");
		expect(result.outputKind).toBe("decompiled-pseudocode");
		expect(result.inputSha256).toBe(sha256(data.bytes));
		expect(result.originalUnchanged).toBe(true);
		expect(result.snapshotUnchanged).toBe(true);
		expect(result.functions[0].pseudocode).toContain("return 7");
		expect(result.strings).toHaveLength(1);
		expect(result.crossReferences).toHaveLength(1);
		expect(result.artifacts.map((item) => item.kind)).toEqual(["report", "pseudocode", "log", "exporter"]);
		for (const artifact of result.artifacts) {
			const bytes = await readFile(artifact.path);
			expect(artifact.sha256).toBe(sha256(bytes));
			expect(artifact.bytes).toBe(bytes.length);
			expect(artifact.path.startsWith(data.outputRoot)).toBe(true);
		}
		expect(await readFile(data.path)).toEqual(data.bytes);
		expect(result.warnings.join(" ")).toContain("原始源码");
	});

	it("creates distinct fresh output directories for successive analyses", async () => {
		const data = await fixture();
		const input = { cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot };
		const first = await runNativeDecompiler(input, undefined, fakeRuntime(data));
		const second = await runNativeDecompiler(input, undefined, fakeRuntime(data));
		expect(first.outputDirectory).not.toBe(second.outputDirectory);
		expect(first.outputDirectory).toMatch(/\.owl[\\/]research[\\/]native[\\/][a-f0-9-]{36}$/);
		expect(await readFile(first.artifacts[0].path)).toEqual(await readFile(second.artifacts[0].path));
	});

	it("preserves successful functions and errors when analysis only partially succeeds", async () => {
		const data = await fixture();
		const runtime = fakeRuntime(data, (report) => {
			report.analysisTimedOut = true;
			report.functions.push({
				address: "140001100",
				name: "failed",
				signature: "void failed(void)",
				decompiled: false,
				truncated: false,
				pseudocode: "",
				error: "function timeout",
			});
			return report;
		});
		const result = await runNativeDecompiler(
			{ cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot },
			undefined,
			runtime,
		);
		expect(result.status).toBe("partial");
		expect(result.analysisTimedOut).toBe(true);
		expect(result.functions).toHaveLength(2);
		expect(result.functions[1].error).toBe("function timeout");
		expect(result.artifacts).toHaveLength(4);
		expect(await readFile(result.artifacts[1].path, "utf8")).toContain("return 7");
	});

	it("does not call empty or truncated pseudocode a complete source recovery", async () => {
		const data = await fixture();
		const input = { cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot };
		const empty = await runNativeDecompiler(
			input,
			undefined,
			fakeRuntime(data, (report) => ({ ...report, functions: [] })),
		);
		expect(empty.status).toBe("partial");
		expect(empty.warnings.join(" ")).toContain("没有函数");
		expect(empty.artifacts.find((artifact) => artifact.kind === "pseudocode")?.bytes).toBe(0);
		const truncated = await runNativeDecompiler(
			input,
			undefined,
			fakeRuntime(data, (report) => {
				report.functions[0].truncated = true;
				return report;
			}),
		);
		expect(truncated.status).toBe("partial");
		expect(truncated.truncated).toBe(true);
	});

	it("rejects malformed reports, wrong provenance, unsafe paths, duplicate addresses and false success flags", async () => {
		const data = await fixture();
		const input = { cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot, maxFunctions: 1 };
		const transforms: ((report: ExportFixture) => unknown)[] = [
			() => "{bad JSON",
			(report) => ({ ...report, inputSha256: "0".repeat(64) }),
			(report) => ({ ...report, pseudocodePath: "../../escape.c" }),
			(report) => ({ ...report, functions: [{ ...report.functions[0], address: "../../escape" }] }),
			(report) => ({ ...report, functions: [{ ...report.functions[0], pseudocode: "" }] }),
			(report) => ({ ...report, functions: [{ ...report.functions[0], decompiled: false }] }),
			(report) => ({ ...report, functions: [...report.functions, report.functions[0]] }),
			(report) => ({ ...report, functions: [{ ...report.functions[0], pseudocode: "x".repeat(16_385) }] }),
		];
		for (const transform of transforms) {
			const result = await runNativeDecompiler(input, undefined, fakeRuntime(data, transform));
			expect(result.status).toBe("failed");
			expect(result.functions).toEqual([]);
			expect(result.artifacts).toEqual([]);
		}
	});

	it("does not publish any adapter result when the original or copied input changes", async () => {
		const data = await fixture();
		const input = { cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot };
		const changedOriginal = await runNativeDecompiler(
			input,
			undefined,
			fakeRuntime(data, async (report) => {
				await writeFile(data.path, Buffer.alloc(data.bytes.length));
				return report;
			}),
		);
		expect(changedOriginal.status).toBe("failed");
		expect(changedOriginal.originalUnchanged).toBe(false);
		expect(changedOriginal.artifacts).toEqual([]);
		await writeFile(data.path, data.bytes);
		const changedSnapshot = await runNativeDecompiler(
			input,
			undefined,
			fakeRuntime(data, async (report, args) => {
				await writeFile(args[args.indexOf("-import") + 1], Buffer.alloc(data.bytes.length));
				return report;
			}),
		);
		expect(changedSnapshot.status).toBe("failed");
		expect(changedSnapshot.originalUnchanged).toBe(true);
		expect(changedSnapshot.snapshotUnchanged).toBe(false);
		expect(changedSnapshot.functions).toEqual([]);
	});

	it("reports whole-process timeout and nonzero exits without fabricated functions", async () => {
		const data = await fixture();
		for (const timedOut of [true, false]) {
			const runtime: NativeDecompilerRuntime = {
				inventory: async () => data.tool,
				run: async () => ({ exitCode: timedOut ? null : 1, timedOut, stdout: "", stderr: "fixture failure" }),
			};
			const result = await runNativeDecompiler(
				{ cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot },
				undefined,
				runtime,
			);
			expect(result.status).toBe("failed");
			expect(result.analysisTimedOut).toBe(timedOut);
			expect(result.functions).toEqual([]);
			expect(result.artifacts).toEqual([]);
		}
	});

	it("rejects input traversal and output junctions without altering outside directories", async () => {
		const data = await fixture();
		const outside = join(data.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "sample.exe"), data.bytes);
		await expect(
			runNativeDecompiler(
				{ cwd: data.inputRoot, path: join("..", "outside", "sample.exe"), outputCwd: data.outputRoot },
				undefined,
				fakeRuntime(data),
			),
		).rejects.toThrow("超出");
		await symlink(outside, join(data.outputRoot, ".owl"), process.platform === "win32" ? "junction" : "dir");
		await expect(
			runNativeDecompiler(
				{ cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot },
				undefined,
				fakeRuntime(data),
			),
		).rejects.toThrow("链接");
		expect(await readdir(outside)).toEqual(["sample.exe"]);
	});

	it("propagates cancellation before reading or after the adapter returns", async () => {
		const data = await fixture();
		const input = { cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot };
		const before = new AbortController();
		before.abort(new Error("cancel before read"));
		await expect(runNativeDecompiler(input, before.signal, fakeRuntime(data))).rejects.toThrow("cancel before read");
		expect(await readdir(data.outputRoot)).toEqual([]);
		const during = new AbortController();
		await expect(
			runNativeDecompiler(
				input,
				during.signal,
				fakeRuntime(data, (report) => {
					during.abort(new Error("cancel adapter"));
					return report;
				}),
			),
		).rejects.toThrow("cancel adapter");
	});

	it("enforces file and call limits before invoking the analyzer", async () => {
		const data = await fixture();
		const input = { cwd: data.inputRoot, path: data.path, outputCwd: data.outputRoot };
		for (const limits of [
			{ maxFunctions: 201 },
			{ timeoutMs: 999 },
			{ maxStrings: -1 },
			{ maxFileBytes: data.bytes.length - 1 },
		]) {
			await expect(runNativeDecompiler({ ...input, ...limits }, undefined, fakeRuntime(data))).rejects.toThrow();
		}
		expect(await readdir(data.outputRoot)).toEqual([]);
	});
});
