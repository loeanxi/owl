import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	EXECUTABLE_INSPECTION_LIMITS,
	ExecutableInspectionError,
	type InspectExecutableOptions,
	inspectExecutable,
} from "../src/core/research/executable.ts";

const MIB = 1024 * 1024;
const DOS_PE_OFFSET = 0x80;
const OPTIONAL_OFFSET = DOS_PE_OFFSET + 24;
const RAW_RDATA_OFFSET = 0x600;
const RDATA_RVA = 0x2000;

interface Fixture {
	buffer: Buffer;
	optionalSize: number;
	sectionsOffset: number;
	directoryOffset: number;
	raw(rva: number): number;
	directory(index: number, rva: number, size: number): void;
}

/** Synthetic bytes only. No fixture contains an executable program or uses a real model. */
function createPe(plus = false): Fixture {
	const buffer = Buffer.alloc(0x1640);
	const optionalSize = plus ? 240 : 224;
	const directoryOffset = OPTIONAL_OFFSET + (plus ? 112 : 96);
	const sectionsOffset = OPTIONAL_OFFSET + optionalSize;
	const raw = (rva: number) => RAW_RDATA_OFFSET + rva - RDATA_RVA;
	const directory = (index: number, rva: number, size: number) => {
		buffer.writeUInt32LE(rva, directoryOffset + index * 8);
		buffer.writeUInt32LE(size, directoryOffset + index * 8 + 4);
	};
	buffer.write("MZ", 0, "ascii");
	buffer.writeUInt32LE(DOS_PE_OFFSET, 0x3c);
	buffer.write("PE\0\0", DOS_PE_OFFSET, "ascii");
	buffer.writeUInt16LE(plus ? 0x8664 : 0x14c, DOS_PE_OFFSET + 4);
	buffer.writeUInt16LE(2, DOS_PE_OFFSET + 6);
	buffer.writeUInt32LE(1700000000, DOS_PE_OFFSET + 8);
	buffer.writeUInt16LE(optionalSize, DOS_PE_OFFSET + 20);
	buffer.writeUInt16LE(0x22, DOS_PE_OFFSET + 22);
	buffer.writeUInt16LE(plus ? 0x20b : 0x10b, OPTIONAL_OFFSET);
	buffer.writeUInt32LE(0x1000, OPTIONAL_OFFSET + 16);
	if (plus) buffer.writeBigUInt64LE(0x140000000n, OPTIONAL_OFFSET + 24);
	else buffer.writeUInt32LE(0x400000, OPTIONAL_OFFSET + 28);
	buffer.writeUInt32LE(0x1000, OPTIONAL_OFFSET + 32);
	buffer.writeUInt32LE(0x200, OPTIONAL_OFFSET + 36);
	buffer.writeUInt32LE(0x4000, OPTIONAL_OFFSET + 56);
	buffer.writeUInt32LE(0x400, OPTIONAL_OFFSET + 60);
	buffer.writeUInt16LE(3, OPTIONAL_OFFSET + 68);
	buffer.writeUInt32LE(16, directoryOffset - 4);
	buffer.write(".text", sectionsOffset, "ascii");
	buffer.writeUInt32LE(0x200, sectionsOffset + 8);
	buffer.writeUInt32LE(0x1000, sectionsOffset + 12);
	buffer.writeUInt32LE(0x200, sectionsOffset + 16);
	buffer.writeUInt32LE(0x400, sectionsOffset + 20);
	buffer.writeUInt32LE(0x60000020, sectionsOffset + 36);
	buffer.fill(0x90, 0x400, 0x600);
	buffer.write(".rdata", sectionsOffset + 40, "ascii");
	buffer.writeUInt32LE(0x1000, sectionsOffset + 48);
	buffer.writeUInt32LE(RDATA_RVA, sectionsOffset + 52);
	buffer.writeUInt32LE(0x1000, sectionsOffset + 56);
	buffer.writeUInt32LE(RAW_RDATA_OFFSET, sectionsOffset + 60);
	buffer.writeUInt32LE(0x40000040, sectionsOffset + 76);

	directory(1, 0x2000, 40);
	buffer.writeUInt32LE(0x2100, raw(0x2000));
	buffer.writeUInt32LE(0x2080, raw(0x2000) + 12);
	buffer.writeUInt32LE(0x2120, raw(0x2000) + 16);
	buffer.write("KERNEL32.dll\0", raw(0x2080), "ascii");
	if (plus) {
		buffer.writeBigUInt64LE(0x2150n, raw(0x2100));
		buffer.writeBigUInt64LE(0x8000000000000011n, raw(0x2100) + 8);
	} else {
		buffer.writeUInt32LE(0x2150, raw(0x2100));
		buffer.writeUInt32LE(0x80000011, raw(0x2100) + 4);
	}
	buffer.writeUInt16LE(9, raw(0x2150));
	buffer.write("CreateFileW\0", raw(0x2150) + 2, "ascii");

	directory(0, 0x2200, 0x100);
	buffer.writeUInt32LE(0x2270, raw(0x2200) + 12);
	buffer.writeUInt32LE(3, raw(0x2200) + 16);
	buffer.writeUInt32LE(2, raw(0x2200) + 20);
	buffer.writeUInt32LE(1, raw(0x2200) + 24);
	buffer.writeUInt32LE(0x2240, raw(0x2200) + 28);
	buffer.writeUInt32LE(0x2250, raw(0x2200) + 32);
	buffer.writeUInt32LE(0x2258, raw(0x2200) + 36);
	buffer.writeUInt32LE(0x1100, raw(0x2240));
	buffer.writeUInt32LE(0x2280, raw(0x2240) + 4);
	buffer.writeUInt32LE(0x2260, raw(0x2250));
	buffer.writeUInt16LE(0, raw(0x2258));
	buffer.write("SampleExport\0", raw(0x2260), "ascii");
	buffer.write("sample.dll\0", raw(0x2270), "ascii");
	buffer.write("OTHER.Forwarded\0", raw(0x2280), "ascii");

	directory(14, 0x2300, 72);
	buffer.writeUInt32LE(72, raw(0x2300));
	buffer.writeUInt16LE(2, raw(0x2300) + 4);
	buffer.writeUInt16LE(5, raw(0x2300) + 6);
	buffer.writeUInt32LE(0x2400, raw(0x2300) + 8);
	buffer.writeUInt32LE(0x40, raw(0x2300) + 12);
	buffer.writeUInt32LE(1, raw(0x2300) + 16);
	buffer.writeUInt32LE(0x06000001, raw(0x2300) + 20);
	buffer.writeUInt32LE(0x424a5342, raw(0x2400));
	buffer.writeUInt16LE(1, raw(0x2400) + 4);
	buffer.writeUInt16LE(1, raw(0x2400) + 6);
	buffer.writeUInt32LE(12, raw(0x2400) + 12);
	buffer.write("v4.0.30319\0", raw(0x2400) + 16, "ascii");
	buffer.write("Sample URL http://example.test/a\0", raw(0x2600), "ascii");
	buffer.write("你好样本 https://wide.test/path\0", raw(0x2701), "utf16le");
	buffer.write("OVERLAY-FIXTURE", 0x1600, "ascii");
	return { buffer, optionalSize, sectionsOffset, directoryOffset, raw, directory };
}

describe("workspace-only executable static inspection", () => {
	const directories: string[] = [];
	const writeFixture = (buffer: Buffer, filename = "sample.exe") => {
		const cwd = mkdtempSync(join(tmpdir(), "owl-executable-test-"));
		directories.push(cwd);
		const path = join(cwd, filename);
		writeFileSync(path, buffer);
		return { cwd, path };
	};
	const inspectFixture = async (fixture: Fixture, options: Partial<InspectExecutableOptions> = {}) => {
		const input = writeFixture(fixture.buffer);
		return inspectExecutable({ ...input, ...options });
	};

	afterEach(() => {
		for (const directory of directories.splice(0)) {
			const full = resolve(directory);
			const withinTemp = relative(resolve(tmpdir()), full);
			if (
				isAbsolute(withinTemp) ||
				withinTemp === ".." ||
				withinTemp.startsWith(`..${sep}`) ||
				!full.includes("owl-executable-test-")
			) {
				throw new Error("Refusing to remove an unexpected test path");
			}
			rmSync(full, { recursive: true, force: true });
		}
	});

	it.each([false, true])(
		"reads PE32/PE32+ headers, imports, exports, CLR, strings and overlay (plus=%s)",
		async (plus) => {
			const fixture = createPe(plus);
			const input = writeFixture(fixture.buffer);
			const before = readFileSync(input.path);
			const report = await inspectExecutable({ ...input });
			expect(report.format).toBe(plus ? "PE32+" : "PE32");
			expect(report.architecture).toBe(plus ? "x64" : "x86");
			expect(report.imageBase).toBe(plus ? "0x140000000" : "0x400000");
			expect(report.file.sha256).toBe(createHash("sha256").update(fixture.buffer).digest("hex"));
			expect(report.file.size).toBe(fixture.buffer.length);
			expect(report.entryPoint).toEqual({ rva: 0x1000, fileOffset: 0x400, section: ".text" });
			expect(report.subsystem.name).toBe("windows-console");
			expect(report.sections.map((section) => section.name)).toEqual([".text", ".rdata"]);
			expect(report.sections[0]).toMatchObject({
				entropy: 0,
				entropySampleBytes: 512,
				entropyIsSampled: false,
				rawRangeValid: true,
			});
			expect(report.imports).toEqual([
				{ dll: "KERNEL32.dll", functions: [{ name: "CreateFileW", hint: 9 }, { ordinal: 17 }] },
			]);
			expect(report.exports).toEqual([
				{ ordinal: 3, rva: 0x1100, name: "SampleExport" },
				{ ordinal: 4, rva: 0x2280, forwarder: "OTHER.Forwarded" },
			]);
			expect(report.clr).toMatchObject({
				present: true,
				valid: true,
				runtimeVersion: "2.5",
				flags: 1,
				entryPointToken: 0x06000001,
				metadata: { signatureValid: true, version: "v4.0.30319" },
			});
			expect(report.strings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						encoding: "ascii",
						value: "Sample URL http://example.test/a",
						offset: fixture.raw(0x2600),
					}),
					expect.objectContaining({
						encoding: "utf16le",
						value: "你好样本 https://wide.test/path",
						offset: fixture.raw(0x2701),
					}),
				]),
			);
			expect(report.urls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ url: "http://example.test/a", encoding: "ascii" }),
					expect.objectContaining({ url: "https://wide.test/path", encoding: "utf16le" }),
				]),
			);
			expect(report.overlay).toEqual({ offset: 0x1600, size: 64, certificateTableBytes: 0, estimated: false });
			expect(report.stringsScan).toMatchObject({ scannedBytes: fixture.buffer.length, truncated: false });
			expect(report.warnings).toEqual([]);
			expect(readFileSync(input.path)).toEqual(before);
		},
	);

	it("supports workspace relative paths and local file URLs", async () => {
		const input = writeFixture(createPe().buffer);
		const relativeReport = await inspectExecutable({ cwd: input.cwd, path: "sample.exe", includeStrings: false });
		const urlReport = await inspectExecutable({
			cwd: input.cwd,
			path: pathToFileURL(input.path).href,
			includeStrings: false,
		});
		expect(urlReport.file).toEqual(relativeReport.file);
		expect(relativeReport.strings).toEqual([]);
		expect(relativeReport.urls.length).toBeGreaterThan(0);
	});

	it("requires copying external files into the workspace and rejects traversal", async () => {
		const inside = writeFixture(createPe().buffer);
		const outside = writeFixture(createPe().buffer);
		await expect(inspectExecutable({ cwd: inside.cwd, path: outside.path })).rejects.toMatchObject({
			code: "PATH_OUTSIDE_WORKSPACE",
		});
		await expect(
			inspectExecutable({ cwd: inside.cwd, path: relative(inside.cwd, outside.path) }),
		).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
	});

	it("rejects symlink/junction traversal after realpath", async () => {
		const inside = writeFixture(createPe().buffer);
		const outside = writeFixture(createPe().buffer);
		const link = join(inside.cwd, "external-directory");
		symlinkSync(outside.cwd, link, process.platform === "win32" ? "junction" : "dir");
		await expect(inspectExecutable({ cwd: inside.cwd, path: join(link, "sample.exe") })).rejects.toMatchObject({
			code: "PATH_OUTSIDE_WORKSPACE",
		});
	});

	it.each([
		"https://example.test/file.exe",
		"file://remote-host/share/file.exe",
		"file:///tmp/a.exe?download=1",
		"\\\\server\\share\\file.exe",
		"\\\\?\\C:\\file.exe",
		"sample.exe:secret",
		"C:sample.exe",
		"",
		"sample\0.exe",
	])("rejects non-local or ambiguous path %s", async (path) => {
		const input = writeFixture(createPe().buffer);
		await expect(inspectExecutable({ cwd: input.cwd, path })).rejects.toMatchObject({ code: "INVALID_PATH" });
	});

	it("rejects a relative cwd, a directory and a missing file with typed errors", async () => {
		const input = writeFixture(createPe().buffer);
		await expect(inspectExecutable({ cwd: ".", path: input.path })).rejects.toMatchObject({ code: "INVALID_PATH" });
		await expect(inspectExecutable({ cwd: input.cwd, path: input.cwd })).rejects.toMatchObject({
			code: "NOT_A_FILE",
		});
		await expect(inspectExecutable({ cwd: input.cwd, path: "missing.exe" })).rejects.toMatchObject({
			code: "FILE_UNAVAILABLE",
		});
	});

	it.each([0, 2, 63, 0x80, 0x98, 0x100, 0x190])("rejects a truncated core PE structure of %s bytes", async (size) => {
		const input = writeFixture(createPe().buffer.subarray(0, size));
		await expect(inspectExecutable(input)).rejects.toMatchObject({ code: "INVALID_PE" });
	});

	it.each(["mz", "pe", "offset", "overlap", "magic", "optional-size"])(
		"rejects malformed mandatory header %s",
		async (kind) => {
			const fixture = createPe();
			if (kind === "mz") fixture.buffer.writeUInt16LE(0, 0);
			if (kind === "pe") fixture.buffer.writeUInt32LE(0, DOS_PE_OFFSET);
			if (kind === "offset") fixture.buffer.writeUInt32LE(0xfffffff0, 0x3c);
			if (kind === "overlap") fixture.buffer.writeUInt32LE(0x20, 0x3c);
			if (kind === "magic") fixture.buffer.writeUInt16LE(0x107, OPTIONAL_OFFSET);
			if (kind === "optional-size") fixture.buffer.writeUInt16LE(90, DOS_PE_OFFSET + 20);
			await expect(inspectFixture(fixture)).rejects.toMatchObject({ code: "INVALID_PE" });
		},
	);

	it("enforces file and option resource limits before parsing or allocation", async () => {
		const input = writeFixture(createPe().buffer);
		await expect(inspectExecutable({ ...input, maxFileBytes: 64 })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
		truncateSync(input.path, EXECUTABLE_INSPECTION_LIMITS.maxFileBytes + 1);
		await expect(inspectExecutable(input)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
		for (const options of [
			{ maxFileBytes: 257 * MIB },
			{ maxStringScanBytes: 65 * MIB },
			{ maxImports: 4097 },
			{ maxExports: 4097 },
			{ maxStrings: -1 },
			{ minStringLength: 201 },
			{ maxStringLength: 2.5 },
			{ maxUrls: Number.NaN },
		]) {
			await expect(inspectExecutable({ ...input, ...options })).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
		}
	});

	it("permits a large local file while independently bounding string scan and entropy work", async () => {
		const fixture = createPe();
		const input = writeFixture(fixture.buffer);
		truncateSync(input.path, 70 * MIB);
		const report = await inspectExecutable({ ...input, includeStrings: false, maxStringScanBytes: 0 });
		expect(report.file.size).toBe(70 * MIB);
		expect(report.stringsScan).toMatchObject({ scannedBytes: 0, totalBytes: 70 * MIB, truncated: true });
		expect(report.strings).toEqual([]);
		expect(report.urls).toEqual([]);
		expect(report.overlay.size).toBe(70 * MIB - 0x1600);
	});

	it("rejects excessive sections without allocating from their count", async () => {
		const fixture = createPe();
		fixture.buffer.writeUInt16LE(0xffff, DOS_PE_OFFSET + 6);
		await expect(inspectFixture(fixture)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
	});

	it.each([0xfffffff0, 0x3500, 0x2000])("reports malformed import RVA/size %s without unsafe reads", async (rva) => {
		const fixture = createPe();
		fixture.buffer.writeUInt32LE(0x3000, fixture.sectionsOffset + 48);
		fixture.directory(1, rva, rva === 0x2000 ? 0xfffffff0 : 40);
		const report = await inspectFixture(fixture);
		expect(report.imports).toEqual([]);
		expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DIRECTORY_RANGE" })]));
	});

	it("does not map invalid raw sections, wrapped RVA ranges or overlapping section RVAs", async () => {
		const fixture = createPe();
		fixture.buffer.writeUInt32LE(0xfffffff0, fixture.sectionsOffset + 56);
		fixture.buffer.writeUInt32LE(0xfffffff0, fixture.sectionsOffset + 52);
		const invalid = await inspectFixture(fixture);
		expect(invalid.sections[1]).toMatchObject({ rawRangeValid: false, entropy: null, entropySampleBytes: 0 });
		expect(invalid.warnings.map((warning) => warning.code)).toEqual(
			expect.arrayContaining(["SECTION_RAW_RANGE", "SECTION_RVA_RANGE", "DIRECTORY_RANGE"]),
		);
		const overlapping = createPe();
		overlapping.buffer.writeUInt32LE(0x1000, overlapping.sectionsOffset + 52);
		const report = await inspectFixture(overlapping);
		expect(report.entryPoint.fileOffset).toBeNull();
		expect(report.warnings.map((warning) => warning.code)).toEqual(
			expect.arrayContaining(["SECTION_RVA_OVERLAP", "ENTRY_POINT_RVA"]),
		);
	});

	it("honors optional-header directory count rather than reading section headers as directories", async () => {
		const fixture = createPe();
		fixture.buffer.writeUInt32LE(0, fixture.directoryOffset - 4);
		const report = await inspectFixture(fixture);
		expect(report.imports).toEqual([]);
		expect(report.exports).toEqual([]);
		expect(report.clr).toEqual({ present: false, valid: false });
		fixture.buffer.writeUInt32LE(0xffffffff, fixture.directoryOffset - 4);
		expect((await inspectFixture(fixture)).warnings.map((warning) => warning.code)).toContain("DIRECTORY_COUNT");
	});

	it("uses FirstThunk fallback and rejects PE32+ name pointers outside the RVA address space", async () => {
		const fixture = createPe(true);
		fixture.buffer.writeUInt32LE(0, fixture.raw(0x2000));
		fixture.buffer.writeBigUInt64LE(0x2150n, fixture.raw(0x2120));
		fixture.buffer.writeBigUInt64LE(0x100000000n, fixture.raw(0x2120) + 8);
		const report = await inspectFixture(fixture);
		expect(report.imports[0].functions).toEqual([{ name: "CreateFileW", hint: 9 }]);
		expect(report.warnings.map((warning) => warning.code)).toContain("IMPORT_NAME_RVA");
	});

	it("bounds unterminated table strings to their mapped section", async () => {
		const fixture = createPe();
		fixture.buffer.writeUInt32LE(0x2ffe, fixture.raw(0x2000) + 12);
		fixture.buffer.write("AB", fixture.raw(0x2ffe), "ascii");
		// The zero byte in the overlay must not terminate this DLL name.
		const report = await inspectFixture(fixture);
		expect(report.imports[0].dll).toContain("invalid DLL RVA");
		expect(report.warnings.map((warning) => warning.code)).toContain("UNTERMINATED_STRING");
	});

	it("bounds non-terminated import tables and adversarial export counts", async () => {
		const fixture = createPe();
		for (let index = 0; index < 16; index++)
			fixture.buffer.writeUInt32LE(0x80000001, fixture.raw(0x2100) + index * 4);
		fixture.buffer.writeUInt32LE(0xffffffff, fixture.raw(0x2200) + 20);
		fixture.buffer.writeUInt32LE(0xffffffff, fixture.raw(0x2200) + 24);
		const report = await inspectFixture(fixture, { maxImports: 3, maxExports: 2 });
		expect(report.imports[0].functions).toHaveLength(3);
		expect(report.exports.length).toBeLessThanOrEqual(2);
		expect(report.truncated.imports).toBe(true);
		expect(report.truncated.exports).toBe(true);
		const zero = await inspectFixture(createPe(), { maxImports: 0, maxExports: 0 });
		expect(zero.imports[0].functions).toEqual([]);
		expect(zero.exports).toEqual([]);
		expect(zero.truncated).toMatchObject({ imports: true, exports: true });
	});

	it("continues listing DLL descriptors after exhausting the import-function budget", async () => {
		const fixture = createPe();
		fixture.directory(1, 0x2000, 60);
		const second = fixture.raw(0x2000) + 20;
		fixture.buffer.writeUInt32LE(0x2140, second);
		fixture.buffer.writeUInt32LE(0x20c0, second + 12);
		fixture.buffer.writeUInt32LE(0x2140, second + 16);
		fixture.buffer.write("SECOND.dll\0", fixture.raw(0x20c0), "ascii");
		fixture.buffer.writeUInt32LE(0x2150, fixture.raw(0x2140));
		const report = await inspectFixture(fixture, { maxImports: 1 });
		expect(report.imports).toEqual([
			{ dll: "KERNEL32.dll", functions: [{ name: "CreateFileW", hint: 9 }] },
			{ dll: "SECOND.dll", functions: [] },
		]);
		expect(report.truncated.imports).toBe(true);
		expect(report.warnings.map((warning) => warning.code)).not.toContain("IMPORT_TABLE_INCOMPLETE");
	});

	it("caps warning output even when thousands of export addresses are invalid", async () => {
		const fixture = createPe();
		fixture.directory(14, 0, 0);
		fixture.buffer.writeUInt32LE(400, fixture.raw(0x2200) + 20);
		fixture.buffer.writeUInt32LE(0, fixture.raw(0x2200) + 24);
		fixture.buffer.writeUInt32LE(0x2500, fixture.raw(0x2200) + 28);
		for (let index = 0; index < 400; index++)
			fixture.buffer.writeUInt32LE(0xfffffff0, fixture.raw(0x2500) + index * 4);
		const report = await inspectFixture(fixture, { maxExports: 400 });
		expect(report.warnings).toHaveLength(128);
		expect(report.truncated.warnings).toBe(true);
	});

	it("keeps malformed CLR metadata as a warning and distinguishes a native CLR entry RVA", async () => {
		const fixture = createPe();
		fixture.buffer.writeUInt32LE(0x10, fixture.raw(0x2300) + 16);
		fixture.buffer.writeUInt32LE(0x1000, fixture.raw(0x2300) + 20);
		fixture.buffer.writeUInt32LE(0xfffffff0, fixture.raw(0x2300) + 8);
		const report = await inspectFixture(fixture);
		expect(report.clr).toMatchObject({
			present: true,
			valid: false,
			nativeEntryPointRva: 0x1000,
			metadata: { signatureValid: false },
		});
		expect(report.clr.entryPointToken).toBeUndefined();
		expect(report.warnings.map((warning) => warning.code)).toContain("CLR_METADATA");
		fixture.directory(14, 0xfffffff0, 72);
		expect((await inspectFixture(fixture)).clr).toMatchObject({ present: true, valid: false });
	});

	it("recognizes certificate file offsets separately from section RVAs without asserting trust", async () => {
		const fixture = createPe();
		fixture.directory(4, 0x1600, 32);
		const report = await inspectFixture(fixture);
		expect(report.certificateTable).toEqual({ offset: 0x1600, size: 32, valid: true });
		expect(report.overlay).toMatchObject({ offset: 0x1600, size: 64, certificateTableBytes: 32 });
		expect(report.limitations.some((limitation) => limitation.includes("signature trust"))).toBe(true);
		fixture.directory(4, 0xfffffff0, 32);
		expect((await inspectFixture(fixture)).warnings.map((warning) => warning.code)).toContain("CERTIFICATE_RANGE");
	});

	it("reports bounded strings, bounded URL clues and a partial scan explicitly", async () => {
		const fixture = createPe();
		const report = await inspectFixture(fixture, {
			maxStrings: 2,
			maxStringLength: 8,
			maxStringScanBytes: 0x800,
			maxUrls: 0,
		});
		expect(report.strings.length).toBeLessThanOrEqual(2);
		expect(report.strings.every((value) => value.value.length <= 8)).toBe(true);
		expect(report.truncated.strings).toBe(true);
		expect(report.stringsScan).toMatchObject({ scannedBytes: 0x800, truncated: true });
		expect(report.urls).toEqual([]);
		const urlLimited = await inspectFixture(fixture, { maxUrls: 1 });
		expect(urlLimited.urls).toHaveLength(1);
		expect(urlLimited.truncated.urls).toBe(true);
		const noStrings = await inspectFixture(fixture, { maxStrings: 0 });
		expect(noStrings.strings).toEqual([]);
		expect(noStrings.urls.length).toBeGreaterThan(0);
		expect(noStrings.truncated.strings).toBe(true);
	});

	it("marks a string cut by the scan boundary as truncated", async () => {
		const fixture = createPe();
		const scanBytes = fixture.raw(0x2600) + 10;
		const report = await inspectFixture(fixture, { maxStringScanBytes: scanBytes });
		expect(report.strings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ offset: fixture.raw(0x2600), value: "Sample URL", truncated: true }),
			]),
		);
	});

	it("labels section-name and sampled entropy indicators as heuristics", async () => {
		const fixture = createPe();
		const large = Buffer.alloc(0x400 + 2 * 65536);
		fixture.buffer.copy(large, 0, 0, 0x400);
		large.writeUInt16LE(1, DOS_PE_OFFSET + 6);
		large.fill(0, fixture.directoryOffset, fixture.directoryOffset + 16 * 8);
		large.fill(0, fixture.sectionsOffset, fixture.sectionsOffset + 8);
		large.write("UPX1", fixture.sectionsOffset, "ascii");
		large.writeUInt32LE(2 * 65536, fixture.sectionsOffset + 8);
		large.writeUInt32LE(2 * 65536, fixture.sectionsOffset + 16);
		large.writeUInt32LE(0xe0000020, fixture.sectionsOffset + 36);
		for (let index = 0; index < 2 * 65536; index++) large[0x400 + index] = Math.floor(index / 2) % 256;
		const input = writeFixture(large);
		const report = await inspectExecutable({ ...input, maxStringScanBytes: 0 });
		expect(report.sections[0]).toMatchObject({ entropy: 8, entropySampleBytes: 65536, entropyIsSampled: true });
		expect(report.packerIndicators.map((indicator) => indicator.code)).toEqual(
			expect.arrayContaining(["PACKER_SECTION_NAME", "HIGH_ENTROPY_SECTION", "WRITABLE_EXECUTABLE_SECTION"]),
		);
		expect(report.packerIndicators.every((indicator) => indicator.kind === "heuristic")).toBe(true);
		expect(report.limitations.some((limitation) => limitation.includes("not a confirmed"))).toBe(true);
	});

	it("allows internal directories and supports unknown machines without guessing", async () => {
		const fixture = createPe();
		fixture.buffer.writeUInt16LE(0xf00d, DOS_PE_OFFSET + 4);
		fixture.buffer.writeUInt32LE(0, OPTIONAL_OFFSET + 16);
		const input = writeFixture(fixture.buffer);
		const nested = join(input.cwd, "nested", "copy.exe");
		mkdirSync(dirname(nested), { recursive: true });
		writeFileSync(nested, fixture.buffer);
		const report = await inspectExecutable({ cwd: input.cwd, path: "nested/copy.exe" });
		expect(report.architecture).toBe("unknown-0xf00d");
		expect(report.entryPoint).toEqual({ rva: 0, fileOffset: null, section: null });
	});

	it("cancels before IO and during asynchronous inspection", async () => {
		const input = writeFixture(createPe().buffer);
		const controller = new AbortController();
		controller.abort();
		await expect(inspectExecutable(input, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
		const during = new AbortController();
		const promise = inspectExecutable(input, during.signal);
		const timer = setTimeout(() => during.abort(), 0);
		try {
			await expect(promise).rejects.toBeInstanceOf(ExecutableInspectionError);
			await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
		} finally {
			clearTimeout(timer);
		}
	});
});
