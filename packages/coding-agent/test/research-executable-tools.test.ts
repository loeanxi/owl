import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { normalizeResearchResult } from "../src/core/research/agent.ts";
import * as containers from "../src/core/research/container.ts";
import {
	buildResearchExecutableResult,
	createResearchExecutableTool,
	RESEARCH_EXECUTABLE_TOOL,
	type ResearchExecutableReport,
	runResearchExecutable,
} from "../src/core/research/executable-tools.ts";
import type { ResearchResult } from "../src/core/research/types.ts";

// This wrapper suite only performs static reads and ASAR extraction; no target or adapter process may start.
vi.mock("node:child_process", () => ({
	execFile: vi.fn(() => {
		throw new Error("No process execution permitted in executable wrapper tests");
	}),
}));

const temporary: string[] = [];

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "owl-research-wrapper-"));
	temporary.push(root);
	return root;
}

// A small synthetic PE32+ with one .text section. The bytes are never executed.
function syntheticPe(): Buffer {
	const bytes = Buffer.alloc(0x400);
	bytes.writeUInt16LE(0x5a4d, 0);
	bytes.writeUInt32LE(0x80, 0x3c);
	bytes.writeUInt32LE(0x4550, 0x80);
	bytes.writeUInt16LE(0x8664, 0x84);
	bytes.writeUInt16LE(1, 0x86);
	bytes.writeUInt16LE(240, 0x94);
	bytes.writeUInt16LE(0x22, 0x96);
	const optional = 0x98;
	bytes.writeUInt16LE(0x20b, optional);
	bytes.writeUInt32LE(0x200, optional + 4);
	bytes.writeUInt32LE(0x1000, optional + 16);
	bytes.writeUInt32LE(0x1000, optional + 20);
	bytes.writeBigUInt64LE(0x140000000n, optional + 24);
	bytes.writeUInt32LE(0x1000, optional + 32);
	bytes.writeUInt32LE(0x200, optional + 36);
	bytes.writeUInt32LE(0x2000, optional + 56);
	bytes.writeUInt32LE(0x200, optional + 60);
	bytes.writeUInt16LE(3, optional + 68);
	bytes.writeUInt32LE(16, optional + 108);
	const section = optional + 240;
	bytes.write(".text", section, "ascii");
	bytes.writeUInt32LE(0x200, section + 8);
	bytes.writeUInt32LE(0x1000, section + 12);
	bytes.writeUInt32LE(0x200, section + 16);
	bytes.writeUInt32LE(0x200, section + 20);
	bytes.writeUInt32LE(0x60000020, section + 36);
	bytes.write("owl public synthetic PE fixture", 0x220, "ascii");
	return bytes;
}

async function syntheticArchive(root: string): Promise<{ path: string; code: Buffer }> {
	const metadata = Buffer.from(JSON.stringify({ name: "owl-public-toy-app", version: "1.2.3", main: "out/main.js" }));
	const code = Buffer.from('const { ipcMain } = require("electron"); ipcMain.handle("public-note", () => 1);');
	const unused = Buffer.from("public unused fixture");
	const json = Buffer.from(
		JSON.stringify({
			files: {
				"package.json": { size: metadata.length, offset: "0" },
				out: { files: { "main.js": { size: code.length, offset: String(metadata.length) } } },
				"unused.txt": { size: unused.length, offset: String(metadata.length + code.length) },
				"code-link": { link: "out/main.js" },
			},
		}),
	);
	const paddedLength = Math.ceil(json.length / 4) * 4;
	const header = Buffer.alloc(8 + paddedLength);
	header.writeUInt32LE(4 + paddedLength, 0);
	header.writeInt32LE(json.length, 4);
	json.copy(header, 8);
	const size = Buffer.alloc(8);
	size.writeUInt32LE(4, 0);
	size.writeUInt32LE(header.length, 4);
	const path = join(root, "app.asar");
	await writeFile(path, Buffer.concat([size, header, metadata, code, unused]));
	return { path, code };
}

afterEach(async () => {
	expect(execFile).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const root of temporary.splice(0)) {
		const absolute = resolve(root);
		if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-research-wrapper-")) {
			throw new Error("Unsafe executable wrapper fixture cleanup target");
		}
		await rm(absolute, { recursive: true, force: true });
	}
});

describe("research executable tool wrapper", () => {
	it("statically inspects an explicitly selected EXE outside the workspace and preserves its original bytes", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "public-synthetic.exe");
		const original = syntheticPe();
		await writeFile(path, original);
		const report = await runResearchExecutable({ path }, output);
		expect(report).toMatchObject({
			action: "inspect",
			status: "inspected",
			executedTarget: false,
			selectedPath: await realpath(path),
			inputDirectory: await realpath(input),
		});
		expect(report.executable).toMatchObject({
			format: "PE32+",
			architecture: "x64",
			sections: [expect.objectContaining({ name: ".text" })],
		});
		expect(report.executable?.file.sha256).toBe(createHash("sha256").update(original).digest("hex"));
		expect(await readFile(path)).toEqual(original);
		expect(await readdir(output)).toEqual([]);
	});

	it("accepts a local file URL or quoted selected path without treating HTTP URLs as local files", async () => {
		const root = await workspace();
		const path = join(root, "selected toy.exe");
		await writeFile(path, syntheticPe());
		for (const selected of [pathToFileURL(path).href, `"${path}"`]) {
			expect((await runResearchExecutable({ path: selected, includeStrings: false }, root)).selectedPath).toBe(
				await realpath(path),
			);
		}
	});

	it("rejects remote URLs, UNC/device paths, alternate streams and malformed parameters before reads", async () => {
		const root = await workspace();
		for (const path of [
			"https://example.invalid/app.exe",
			"file://remote/app.exe",
			"\\\\server\\share\\app.exe",
			"\\\\?\\C:\\app.exe",
			"//server/share/app.exe",
			"C:\\lab\\app.exe:stream",
			"app.exe:stream",
			"app.exe\0",
			"public.txt",
		]) {
			await expect(runResearchExecutable({ path }, root)).rejects.toThrow();
		}
		await expect(runResearchExecutable({ path: "x.exe", action: "run" }, root)).rejects.toThrow("参数无效");
		await expect(runResearchExecutable({ path: "x.exe", command: "never" }, root)).rejects.toThrow("参数无效");
		expect(await readdir(root)).toEqual([]);
	});

	it("rejects directories and selected symbolic entries without opening their targets", async () => {
		const root = await workspace();
		const directory = join(root, "directory.exe");
		await mkdir(directory);
		await expect(runResearchExecutable({ path: directory }, root)).rejects.toThrow("普通文件");
		const link = join(root, "linked.exe");
		await symlink(directory, link, process.platform === "win32" ? "junction" : "dir");
		await expect(runResearchExecutable({ path: link }, root)).rejects.toThrow("符号链接");
		expect(await readdir(directory)).toEqual([]);
	});

	it("locates only fixed adjacent application resources for an external user-selected EXE", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.exe");
		await writeFile(path, syntheticPe());
		const resources = join(input, "resources");
		await mkdir(resources);
		await syntheticArchive(resources);
		const report = await runResearchExecutable({ path }, output);
		expect(report.container).toMatchObject({
			container: "asar",
			package: { name: "owl-public-toy-app", main: "out/main.js" },
		});
		expect(report.container?.containerPath).toBe(await realpath(join(resources, "app.asar")));
		expect(report.container?.javascript.some((item) => item.path === "out/main.js")).toBe(true);
		expect(report.extraction).toBeUndefined();
		expect(await readdir(output)).toEqual([]);
	});

	it("extracts explicit ASAR names into fresh workspace directories while retaining the source and omitted entries", async () => {
		const input = await workspace();
		const output = await workspace();
		const archive = await syntheticArchive(input);
		const original = await readFile(archive.path);
		const first = await runResearchExecutable(
			{ action: "extract", path: archive.path, names: ["out/main.js"] },
			output,
		);
		const second = await runResearchExecutable(
			{ action: "extract", path: archive.path, names: ["out/main.js"] },
			output,
		);
		expect(first).toMatchObject({
			status: "extracted",
			executedTarget: false,
			extraction: { totalBytes: archive.code.length },
		});
		if (!first.extraction || !second.extraction) throw new Error("Missing actual extraction records");
		expect(first.extraction.outputDirectory).not.toBe(second.extraction.outputDirectory);
		for (const report of [first, second]) {
			if (!report.extraction) throw new Error("Missing extraction");
			const local = relative(await realpath(output), report.extraction.outputDirectory);
			expect(isAbsolute(local)).toBe(false);
			expect(local).not.toBe("..");
			expect(local.startsWith(`..${sep}`)).toBe(false);
			expect(local).toMatch(/^\.owl[\\/]research[\\/]extracted[\\/][a-f0-9-]{36}$/);
			expect(report.extraction.files.map((file) => file.path)).toEqual(["out/main.js"]);
			expect(await readFile(report.extraction.files[0].outputPath)).toEqual(archive.code);
			expect(await readdir(report.extraction.outputDirectory)).toEqual(["out"]);
		}
		expect(await readFile(archive.path)).toEqual(original);
		expect(await readdir(input)).toEqual(["app.asar"]);
	});

	it("requires extraction names and rejects traversal, archive links or names for inspect without output writes", async () => {
		const input = await workspace();
		const output = await workspace();
		const { path } = await syntheticArchive(input);
		await expect(runResearchExecutable({ action: "extract", path }, output)).rejects.toThrow("明确提供");
		await expect(runResearchExecutable({ path, names: ["package.json"] }, output)).rejects.toThrow("只用于");
		for (const name of ["../escape", "/absolute", "out\\main.js", "code-link", "missing.txt"]) {
			await expect(runResearchExecutable({ action: "extract", path, names: [name] }, output)).rejects.toThrow();
		}
		expect(await readdir(output)).toEqual([]);
	});

	it("propagates cancellation before static reads and extraction, leaving input and output unchanged", async () => {
		const input = await workspace();
		const output = await workspace();
		const archive = await syntheticArchive(input);
		const original = await readFile(archive.path);
		const controller = new AbortController();
		controller.abort(new Error("synthetic cancellation"));
		for (const action of ["inspect", "extract"] as const) {
			await expect(
				runResearchExecutable(
					{ action, path: archive.path, ...(action === "extract" ? { names: ["out/main.js"] } : {}) },
					output,
					controller.signal,
				),
			).rejects.toThrow("synthetic cancellation");
		}
		expect(await readFile(archive.path)).toEqual(original);
		expect(await readdir(output)).toEqual([]);
	});

	it("verifies a mocked UPX output as a different valid PE and retains both fingerprints", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.exe");
		const outputPath = join(output, "unpacked.exe");
		const original = syntheticPe();
		const unpacked = Buffer.from(original);
		unpacked.write("public unpacked fixture", 0x300, "ascii");
		await writeFile(path, original);
		await writeFile(outputPath, unpacked);
		const adapter = vi.spyOn(containers, "decompressUpx").mockResolvedValue({
			status: "decompressed",
			inputPath: path,
			outputPath,
			bytes: unpacked.length,
			evidence: ["Synthetic adapter only; no process."],
		});
		const report = await runResearchExecutable({ action: "unpack", path }, output);
		expect(adapter).toHaveBeenCalledWith(
			{ cwd: await realpath(input), path: await realpath(path), outputCwd: output },
			undefined,
		);
		expect(report.status).toBe("decompressed");
		expect(report.outputInspection?.file.sha256).toBe(createHash("sha256").update(unpacked).digest("hex"));
		expect(report.executable?.file.sha256).toBe(createHash("sha256").update(original).digest("hex"));
		expect(await readFile(path)).toEqual(original);
	});

	it("does not certify unchanged or malformed UPX output just because an adapter reports success", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.exe");
		const outputPath = join(output, "unpacked.exe");
		const original = syntheticPe();
		await writeFile(path, original);
		vi.spyOn(containers, "decompressUpx").mockResolvedValue({
			status: "decompressed",
			inputPath: path,
			outputPath,
			evidence: ["Synthetic adapter only; no process."],
		});
		for (const [bytes, warning] of [
			[original, "哈希相同"],
			[Buffer.from("MZ"), "未通过 PE 再解析"],
		] as const) {
			await writeFile(outputPath, bytes);
			const report = await runResearchExecutable({ action: "unpack", path }, output);
			expect(report.status).toBe("unsupported");
			expect(report.warnings.join(" ")).toContain(warning);
			expect(
				buildResearchExecutableResult(report).findings.some((finding) =>
					finding.text.includes("本次未确认完成脱壳"),
				),
			).toBe(true);
		}
	});

	it("returns a standard source-linked binary research card through ToolDefinition execution", async () => {
		const input = await workspace();
		const output = await workspace();
		const path = join(input, "toy.exe");
		await writeFile(path, syntheticPe());
		const report = await runResearchExecutable({ path }, output);
		const result = buildResearchExecutableResult(report);
		const { id, createdAt, ...card } = result;
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
		expect(normalizeResearchResult(card)).toMatchObject({ mode: "binary", status: "partial" });
		expect(card.findings.filter((item) => item.kind === "fact").every((item) => item.sourceIds.length > 0)).toBe(
			true,
		);
		expect(card.sources.every((source) => source.url === undefined && (source.note?.length ?? 0) <= 2000)).toBe(true);
		const tool = createResearchExecutableTool();
		expect(tool.name).toBe(RESEARCH_EXECUTABLE_TOOL);
		expect(tool.executionMode).toBe("sequential");
		await expect(
			tool.execute("missing-context", { path }, undefined, undefined, {} as ExtensionToolContext),
		).rejects.toThrow("工作区");
		const executed = await tool.execute("static", { path }, undefined, undefined, {
			cwd: output,
		} as ExtensionToolContext);
		const details = executed.details as {
			researchExecutable: ResearchExecutableReport;
			researchResult: ResearchResult;
		};
		expect(details.researchExecutable.executedTarget).toBe(false);
		expect(details.researchResult.mode).toBe("binary");
		expect(executed.content).toContainEqual({ type: "text", text: expect.stringContaining("静态工具观测") });
	});
});
