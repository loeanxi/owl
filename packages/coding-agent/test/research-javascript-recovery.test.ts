import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverJavascriptSources } from "../src/core/research/javascript-recovery.ts";

const temporary: string[] = [];

async function workspace(): Promise<{ root: string; inputRoot: string; outputCwd: string }> {
	const root = await mkdtemp(join(tmpdir(), "owl-javascript-recovery-"));
	temporary.push(root);
	const inputRoot = join(root, "app");
	const outputCwd = join(root, "workspace");
	await Promise.all([mkdir(inputRoot), mkdir(outputCwd)]);
	return { root, inputRoot, outputCwd };
}

afterEach(async () => {
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("static JavaScript source recovery", () => {
	it("uses the real installed parser to produce readable code, hashes and provenance without evaluating the sample", async () => {
		const { inputRoot, outputCwd } = await workspace();
		await mkdir(join(inputRoot, "out"));
		const source = Buffer.from(
			'throw new Error("SAMPLE_MUST_NOT_EXECUTE");const electron=require("electron");module.exports.getDevice=()=>electron.ipcRenderer.invoke("getUsbDeviceDescriptor");const password="PRIVATE_SOURCE_VALUE";',
		);
		const path = join(inputRoot, "out", "preload.cjs");
		await writeFile(path, source);
		const report = await recoverJavascriptSources({ inputRoot, outputCwd, names: ["out/preload.cjs"] });
		expect(report.status).toBe("recovered");
		expect(report.method).toBe("static-source-normalization");
		expect(report.normalizer).toMatchObject({ name: "esbuild", available: true });
		expect(report.normalizer.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(report.outputDirectory).toMatch(/\.owl[\\/]research[\\/]recovered[\\/][a-f0-9-]{36}$/);
		expect(report.outputDirectory.startsWith(outputCwd)).toBe(true);
		const file = report.files[0];
		expect(file.normalization).toBe("readable");
		expect(file.sha256).toBe(createHash("sha256").update(source).digest("hex"));
		expect(file.bytes).toBe(source.length);
		expect(await readFile(file.originalPath)).toEqual(source);
		expect(await readFile(path)).toEqual(source);
		const readable = await readFile(file.readablePath!, "utf8");
		expect(readable).toContain('\nconst electron = require("electron");\n');
		expect(readable).toContain("SAMPLE_MUST_NOT_EXECUTE");
		expect(file.readableSha256).toBe(createHash("sha256").update(readable).digest("hex"));
		expect(file.clues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "module", value: "electron" }),
				expect.objectContaining({ kind: "ipc", value: "getUsbDeviceDescriptor" }),
				expect.objectContaining({ kind: "export", value: "getDevice" }),
			]),
		);
		expect(JSON.stringify(report)).not.toContain("PRIVATE_SOURCE_VALUE");
		expect(JSON.parse(await readFile(report.manifestPath, "utf8"))).toEqual(report);
		expect(await readdir(inputRoot)).toEqual(["out"]);
	});

	it("keeps malformed source but reports partial and never creates a fake readable result", async () => {
		const { inputRoot, outputCwd } = await workspace();
		await writeFile(join(inputRoot, "bad.js"), "const broken = (; // PRIVATE_FAILURE_TEXT");
		const report = await recoverJavascriptSources({ inputRoot, outputCwd, names: ["bad.js"] });
		expect(report.status).toBe("partial");
		expect(report.files[0].normalization).toBe("parseError");
		expect(report.files[0].readablePath).toBeUndefined();
		expect(await readFile(report.files[0].originalPath, "utf8")).toContain("PRIVATE_FAILURE_TEXT");
		expect(JSON.stringify(report)).not.toContain("PRIVATE_FAILURE_TEXT");
		expect(await readdir(report.outputDirectory)).toEqual(["manifest.json", "original"]);
	});

	it("creates fresh separate output each time, preserves full source bytes and supports CJS/MJS syntax", async () => {
		const { inputRoot, outputCwd } = await workspace();
		const source = Buffer.from("\ufeff// 中文说明\r\nexport const deviceConfig={getConfig:()=>1};\r\n");
		await writeFile(join(inputRoot, "source.mjs"), source);
		const first = await recoverJavascriptSources({ inputRoot, outputCwd, names: ["source.mjs"] });
		const second = await recoverJavascriptSources({ inputRoot, outputCwd, names: ["source.mjs"] });
		expect(first.outputDirectory).not.toBe(second.outputDirectory);
		expect(await readFile(first.files[0].originalPath)).toEqual(source);
		expect(await readFile(join(inputRoot, "source.mjs"))).toEqual(source);
		const clue = first.files[0].clues.find((entry) => entry.kind === "export")!;
		expect(clue.offset).toBe(source.indexOf(Buffer.from("export const")));
		expect(first.files[0].clues.some((entry) => entry.kind === "feature" && entry.value === "getConfig")).toBe(true);
	});

	it("requires explicit source selections and rejects traversal, absolute paths, reserved names and other formats before writes", async () => {
		const { inputRoot, outputCwd } = await workspace();
		for (const names of [
			[],
			["../outside.js"],
			["/absolute.js"],
			["C:/absolute.js"],
			["out\\source.js"],
			["source.jsc"],
			["CON.js"],
			["a./source.js"],
			["source.js", "source.js"],
			Array.from({ length: 9 }, (_, index) => `${index}.js`),
		]) {
			await expect(recoverJavascriptSources({ inputRoot, outputCwd, names })).rejects.toThrow();
		}
		expect(await readdir(outputCwd)).toEqual([]);
	});

	it("bounds each input file and aggregate reads before creating outputs", async () => {
		const { inputRoot, outputCwd } = await workspace();
		await writeFile(join(inputRoot, "huge.js"), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
		await expect(recoverJavascriptSources({ inputRoot, outputCwd, names: ["huge.js"] })).rejects.toThrow(
			"单个源文件",
		);
		for (let index = 0; index < 4; index++) {
			await writeFile(join(inputRoot, `${index}.js`), Buffer.alloc(7 * 1024 * 1024, 32));
		}
		await expect(
			recoverJavascriptSources({ inputRoot, outputCwd, names: ["0.js", "1.js", "2.js", "3.js"] }),
		).rejects.toThrow("总大小");
		expect(await readdir(outputCwd)).toEqual([]);
	});

	it("rejects binary or invalid UTF-8 disguised as JavaScript and rejects directories", async () => {
		const { inputRoot, outputCwd } = await workspace();
		await writeFile(join(inputRoot, "nul.js"), "const x=1;\0");
		await writeFile(join(inputRoot, "bad-encoding.js"), Buffer.from([0xff, 0xfe, 0x61]));
		await mkdir(join(inputRoot, "directory.js"));
		for (const name of ["nul.js", "bad-encoding.js", "directory.js"]) {
			await expect(recoverJavascriptSources({ inputRoot, outputCwd, names: [name] })).rejects.toThrow();
		}
		expect(await readdir(outputCwd)).toEqual([]);
	});

	it("refuses source junctions and output junctions without modifying external directories", async () => {
		const { root, inputRoot, outputCwd } = await workspace();
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "source.js"), "const x = 1;");
		await symlink(outside, join(inputRoot, "linked"), "junction");
		await expect(recoverJavascriptSources({ inputRoot, outputCwd, names: ["linked/source.js"] })).rejects.toThrow(
			"符号链接",
		);
		await writeFile(join(inputRoot, "source.js"), "const x = 1;");
		await symlink(outside, join(outputCwd, ".owl"), "junction");
		await expect(recoverJavascriptSources({ inputRoot, outputCwd, names: ["source.js"] })).rejects.toThrow(
			"符号链接",
		);
		expect(await readdir(outside)).toEqual(["source.js"]);
	});

	it("reports bounded lexical evidence as truncated instead of implying complete analysis", async () => {
		const { inputRoot, outputCwd } = await workspace();
		const source = Array.from({ length: 500 }, (_, index) => `ipcRenderer.invoke("device:${index}");`).join("");
		await writeFile(join(inputRoot, "many.js"), source);
		const report = await recoverJavascriptSources({ inputRoot, outputCwd, names: ["many.js"] });
		expect(report.files[0].clues).toHaveLength(300);
		expect(report.files[0].cluesTruncated).toBe(true);
		expect(report.warnings.some((warning) => warning.includes("词法"))).toBe(true);
	});

	it("propagates cancellation before reading and during chunked reads without retaining partial outputs", async () => {
		const { inputRoot, outputCwd } = await workspace();
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			recoverJavascriptSources({ inputRoot, outputCwd, names: ["missing.js"] }, cancelled.signal),
		).rejects.toThrow();
		await writeFile(join(inputRoot, "large.js"), Buffer.alloc(8 * 1024 * 1024, 32));
		const duringRead = new AbortController();
		const recovery = recoverJavascriptSources({ inputRoot, outputCwd, names: ["large.js"] }, duringRead.signal);
		const timer = setTimeout(() => duringRead.abort(), 2);
		try {
			await expect(recovery).rejects.toThrow();
		} finally {
			clearTimeout(timer);
		}
		expect(await readdir(outputCwd)).toEqual([]);
	});
});
