import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const MIB = 1024 * 1024;
const MAX_SECTIONS = 96;
const MAX_IMPORT_DLLS = 256;
const MAX_WARNINGS = 128;
const ENTROPY_SAMPLE_BYTES = 64 * 1024;
const MAX_TABLE_STRING_BYTES = 1024;

export const EXECUTABLE_INSPECTION_LIMITS = {
	maxFileBytes: 256 * MIB,
	maxStringScanBytes: 64 * MIB,
	defaultStringScanBytes: 16 * MIB,
	maxStrings: 1024,
	maxStringLength: 1024,
	maxImports: 4096,
	maxExports: 4096,
	maxUrls: 128,
	maxSections: MAX_SECTIONS,
	entropySampleBytesPerSection: ENTROPY_SAMPLE_BYTES,
} as const;

export interface InspectExecutableOptions {
	/** Absolute, local workspace root. Symlinks are resolved before checking containment. */
	cwd: string;
	/** Workspace-relative/absolute local path or local file: URL. External files must first be copied into cwd. */
	path: string;
	includeStrings?: boolean;
	maxFileBytes?: number;
	maxStringScanBytes?: number;
	maxStrings?: number;
	maxStringLength?: number;
	minStringLength?: number;
	maxImports?: number;
	maxExports?: number;
	maxUrls?: number;
}

export type ExecutableInspectionErrorCode =
	| "INVALID_PATH"
	| "PATH_OUTSIDE_WORKSPACE"
	| "NOT_A_FILE"
	| "FILE_UNAVAILABLE"
	| "FILE_CHANGED"
	| "FILE_TOO_LARGE"
	| "INVALID_PE"
	| "RESOURCE_LIMIT"
	| "ABORTED";

export class ExecutableInspectionError extends Error {
	readonly code: ExecutableInspectionErrorCode;

	constructor(code: ExecutableInspectionErrorCode, message: string) {
		super(message);
		this.name = "ExecutableInspectionError";
		this.code = code;
	}
}

export interface ExecutableWarning {
	code: string;
	message: string;
	offset?: number;
	rva?: number;
}

export interface ExecutableSection {
	name: string;
	virtualAddress: number;
	virtualSize: number;
	rawOffset: number;
	rawSize: number;
	characteristics: number;
	executable: boolean;
	readable: boolean;
	writable: boolean;
	rawRangeValid: boolean;
	entropy: number | null;
	entropySampleBytes: number;
	entropyIsSampled: boolean;
}

export interface ExecutableImport {
	dll: string;
	functions: Array<{ name?: string; ordinal?: number; hint?: number }>;
}

export interface ExecutableExport {
	ordinal: number;
	rva: number;
	name?: string;
	forwarder?: string;
}

export interface ExecutableString {
	offset: number;
	encoding: "ascii" | "utf16le";
	value: string;
	truncated: boolean;
}

export interface ExecutableClrInfo {
	present: boolean;
	valid: boolean;
	rva?: number;
	size?: number;
	runtimeVersion?: string;
	flags?: number;
	entryPointToken?: number;
	nativeEntryPointRva?: number;
	metadata?: { rva: number; size: number; signatureValid: boolean; version?: string };
}

export interface ExecutableInspectionReport {
	file: { path: string; size: number; sha256: string };
	format: "PE32" | "PE32+";
	architecture: string;
	machine: number;
	imageBase: string;
	entryPoint: { rva: number; fileOffset: number | null; section: string | null };
	coff: { timestamp: number; characteristics: number; isDll: boolean };
	subsystem: { value: number; name: string };
	sections: ExecutableSection[];
	imports: ExecutableImport[];
	exports: ExecutableExport[];
	clr: ExecutableClrInfo;
	certificateTable: { offset: number; size: number; valid: boolean } | null;
	overlay: { offset: number; size: number; certificateTableBytes: number; estimated: boolean };
	strings: ExecutableString[];
	urls: Array<{ url: string; offset: number; encoding: ExecutableString["encoding"] }>;
	stringsScan: {
		scannedBytes: number;
		totalBytes: number;
		truncated: boolean;
		includesStrings: boolean;
		utf16Policy: string;
	};
	packerIndicators: Array<{ kind: "heuristic"; code: string; message: string; section?: string }>;
	warnings: ExecutableWarning[];
	truncated: { imports: boolean; exports: boolean; strings: boolean; urls: boolean; warnings: boolean };
	limits: Required<Omit<InspectExecutableOptions, "cwd" | "path">>;
	limitations: string[];
}

interface DataDirectory {
	rva: number;
	size: number;
}

interface MappedSpan {
	offset: number;
	available: number;
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ExecutableInspectionError("ABORTED", "Executable inspection was cancelled.");
}

function boundedOption(value: number | undefined, fallback: number, maximum: number, name: string, minimum = 1): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new ExecutableInspectionError("RESOURCE_LIMIT", `${name} must be an integer between ${minimum} and ${maximum}.`);
	}
	return value;
}

function normalizeLimits(options: InspectExecutableOptions): ExecutableInspectionReport["limits"] {
	const maxStringLength = boundedOption(options.maxStringLength, 200, 1024, "maxStringLength");
	return {
		includeStrings: options.includeStrings !== false,
		maxFileBytes: boundedOption(options.maxFileBytes, 256 * MIB, 256 * MIB, "maxFileBytes"),
		maxStringScanBytes: boundedOption(options.maxStringScanBytes, 16 * MIB, 64 * MIB, "maxStringScanBytes", 0),
		maxStrings: boundedOption(options.maxStrings, 256, 1024, "maxStrings", 0),
		maxStringLength,
		minStringLength: boundedOption(options.minStringLength, Math.min(4, maxStringLength), maxStringLength, "minStringLength"),
		maxImports: boundedOption(options.maxImports, 2048, 4096, "maxImports", 0),
		maxExports: boundedOption(options.maxExports, 2048, 4096, "maxExports", 0),
		maxUrls: boundedOption(options.maxUrls, 64, 128, "maxUrls", 0),
	};
}

function localPath(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new ExecutableInspectionError("INVALID_PATH", "A non-empty local file path is required.");
	}
	let path = value;
	if (/^file:/i.test(path)) {
		try {
			const url = new URL(path);
			if (url.hostname && url.hostname !== "localhost") throw new Error("Remote file URL");
			if (url.search || url.hash) throw new Error("File URL has query or fragment");
			path = fileURLToPath(url);
		} catch {
			throw new ExecutableInspectionError("INVALID_PATH", "Only local file: URLs without a query or fragment are allowed.");
		}
	} else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
		throw new ExecutableInspectionError("INVALID_PATH", "URLs and drive-relative paths are not executable inputs.");
	}
	// Reject UNC/device paths and Windows alternate data streams, including on non-Windows hosts.
	if (/^[\\/]{2}/.test(path) || path.slice(/^[a-z]:/i.test(path) ? 2 : 0).includes(":")) {
		throw new ExecutableInspectionError("INVALID_PATH", "Network/device paths and alternate data streams are not supported.");
	}
	return path;
}

function assertInsideWorkspace(cwd: string, path: string): void {
	const pathFromRoot = relative(cwd, path);
	if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
		throw new ExecutableInspectionError("PATH_OUTSIDE_WORKSPACE", "Copy the executable into this workspace before inspecting it.");
	}
}

async function readWorkspaceFile(
	options: InspectExecutableOptions,
	limits: ExecutableInspectionReport["limits"],
	signal?: AbortSignal,
): Promise<{ path: string; buffer: Buffer; sha256: string }> {
	abortIfRequested(signal);
	const cwdInput = localPath(options.cwd);
	if (!isAbsolute(cwdInput)) throw new ExecutableInspectionError("INVALID_PATH", "cwd must be an absolute workspace path.");
	const input = resolve(cwdInput, localPath(options.path));
	assertInsideWorkspace(cwdInput, input);
	try {
		const cwd = await realpath(cwdInput);
		const path = await realpath(input);
		assertInsideWorkspace(cwd, path);
		const before = await stat(path);
		if (!before.isFile()) throw new ExecutableInspectionError("NOT_A_FILE", "Executable input must be a regular file.");
		if (before.size > limits.maxFileBytes) {
			throw new ExecutableInspectionError("FILE_TOO_LARGE", `Executable exceeds the ${limits.maxFileBytes}-byte read limit.`);
		}
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = await file.stat();
			const currentPath = await realpath(input);
			assertInsideWorkspace(cwd, currentPath);
			if (currentPath !== path || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
				throw new ExecutableInspectionError("FILE_CHANGED", "Executable changed while opening it; retry with a stable copy.");
			}
			if (!opened.isFile()) throw new ExecutableInspectionError("NOT_A_FILE", "Executable input must be a regular file.");
			if (opened.size > limits.maxFileBytes) throw new ExecutableInspectionError("FILE_TOO_LARGE", "Executable exceeds the read limit.");
			const buffer = Buffer.alloc(opened.size);
			const hash = createHash("sha256");
			let offset = 0;
			while (offset < buffer.length) {
				abortIfRequested(signal);
				const { bytesRead } = await file.read(buffer, offset, Math.min(MIB, buffer.length - offset), offset);
				if (bytesRead === 0) throw new ExecutableInspectionError("FILE_CHANGED", "Executable was truncated while reading it.");
				hash.update(buffer.subarray(offset, offset + bytesRead));
				offset += bytesRead;
			}
			const after = await file.stat();
			if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
				throw new ExecutableInspectionError("FILE_CHANGED", "Executable changed while reading it; retry with a stable copy.");
			}
			abortIfRequested(signal);
			return { path, buffer, sha256: hash.digest("hex") };
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof ExecutableInspectionError) throw error;
		throw new ExecutableInspectionError("FILE_UNAVAILABLE", `Cannot read executable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function rangeFits(offset: number, length: number, total: number): boolean {
	return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= total - length;
}

function entropy(buffer: Buffer, offset: number, size: number): { value: number | null; sampleBytes: number } {
	const sampleBytes = Math.min(size, ENTROPY_SAMPLE_BYTES);
	if (!sampleBytes) return { value: null, sampleBytes: 0 };
	const counts = new Uint32Array(256);
	// Spread the sample over the whole raw section rather than assuming its prefix is representative.
	for (let i = 0; i < sampleBytes; i++) counts[buffer[offset + Math.floor((i * size) / sampleBytes)]]++;
	let value = 0;
	for (const count of counts) {
		if (count) {
			const probability = count / sampleBytes;
			value -= probability * Math.log2(probability);
		}
	}
	return { value: Math.round(value * 10000) / 10000, sampleBytes };
}

class PeReader {
	readonly buffer: Buffer;
	readonly limits: ExecutableInspectionReport["limits"];
	readonly signal?: AbortSignal;
	readonly warnings: ExecutableWarning[] = [];
	readonly sections: ExecutableSection[] = [];
	readonly directories: DataDirectory[] = [];
	readonly truncated = { imports: false, exports: false, strings: false, urls: false, warnings: false };
	headerMappingSize = 0;
	peOffset = 0;
	optionalOffset = 0;
	optionalSize = 0;
	format: ExecutableInspectionReport["format"] = "PE32";
	machine = 0;
	entryPointRva = 0;
	imageBase = "0x0";
	headerEnd = 0;
	sizeOfHeaders = 0;

	constructor(buffer: Buffer, limits: ExecutableInspectionReport["limits"], signal?: AbortSignal) {
		this.buffer = buffer;
		this.limits = limits;
		this.signal = signal;
	}

	warn(code: string, message: string, location: { offset?: number; rva?: number } = {}): void {
		if (this.warnings.length < MAX_WARNINGS) this.warnings.push({ code, message, ...location });
		else this.truncated.warnings = true;
	}

	require(offset: number, length: number, field: string): void {
		if (!rangeFits(offset, length, this.buffer.length)) {
			throw new ExecutableInspectionError("INVALID_PE", `Truncated or invalid ${field} at file offset ${offset}.`);
		}
	}

	readHeaders(): void {
		this.require(0, 64, "DOS header");
		if (this.buffer.readUInt16LE(0) !== 0x5a4d) throw new ExecutableInspectionError("INVALID_PE", "Missing MZ signature.");
		this.peOffset = this.buffer.readUInt32LE(0x3c);
		if (this.peOffset < 64) throw new ExecutableInspectionError("INVALID_PE", "PE header overlaps the DOS header.");
		this.require(this.peOffset, 24, "PE/COFF header");
		if (this.buffer.readUInt32LE(this.peOffset) !== 0x00004550) {
			throw new ExecutableInspectionError("INVALID_PE", "Missing PE signature.");
		}
		const coff = this.peOffset + 4;
		this.machine = this.buffer.readUInt16LE(coff);
		const sectionCount = this.buffer.readUInt16LE(coff + 2);
		if (sectionCount > MAX_SECTIONS) {
			throw new ExecutableInspectionError("RESOURCE_LIMIT", `PE section count exceeds ${MAX_SECTIONS}.`);
		}
		this.optionalSize = this.buffer.readUInt16LE(coff + 16);
		this.optionalOffset = coff + 20;
		this.require(this.optionalOffset, this.optionalSize, "optional header");
		if (this.optionalSize < 2) throw new ExecutableInspectionError("INVALID_PE", "Missing optional header.");
		const magic = this.buffer.readUInt16LE(this.optionalOffset);
		if (magic !== 0x10b && magic !== 0x20b) {
			throw new ExecutableInspectionError("INVALID_PE", `Unsupported optional-header magic 0x${magic.toString(16)}.`);
		}
		this.format = magic === 0x20b ? "PE32+" : "PE32";
		const directoryOffset = this.format === "PE32+" ? 112 : 96;
		if (this.optionalSize < directoryOffset) throw new ExecutableInspectionError("INVALID_PE", "Truncated optional-header fields.");
		this.entryPointRva = this.buffer.readUInt32LE(this.optionalOffset + 16);
		this.imageBase = `0x${(this.format === "PE32+" ? this.buffer.readBigUInt64LE(this.optionalOffset + 24) : BigInt(this.buffer.readUInt32LE(this.optionalOffset + 28))).toString(16)}`;
		this.sizeOfHeaders = this.buffer.readUInt32LE(this.optionalOffset + 60);
		const directoryCount = this.buffer.readUInt32LE(this.optionalOffset + directoryOffset - 4);
		const availableDirectories = Math.floor((this.optionalSize - directoryOffset) / 8);
		if (directoryCount > availableDirectories || directoryCount > 16) {
			this.warn("DIRECTORY_COUNT", "Data-directory count exceeds the optional header or the 16 standard entries.");
		}
		for (let index = 0; index < Math.min(directoryCount, availableDirectories, 16); index++) {
			const offset = this.optionalOffset + directoryOffset + index * 8;
			this.directories.push({ rva: this.buffer.readUInt32LE(offset), size: this.buffer.readUInt32LE(offset + 4) });
		}
		const sectionsOffset = this.optionalOffset + this.optionalSize;
		this.require(sectionsOffset, sectionCount * 40, "section table");
		this.headerEnd = sectionsOffset + sectionCount * 40;
		if (this.sizeOfHeaders >= this.headerEnd && this.sizeOfHeaders <= this.buffer.length) {
			this.headerMappingSize = this.sizeOfHeaders;
		} else this.warn("HEADER_SIZE", "SizeOfHeaders is outside the file or smaller than the section table.");
		for (let index = 0; index < sectionCount; index++) {
			abortIfRequested(this.signal);
			const offset = sectionsOffset + index * 40;
			const name = this.buffer.subarray(offset, offset + 8).toString("ascii").split("\0", 1)[0].replace(/[^\x20-\x7e]/g, "?");
			const virtualSize = this.buffer.readUInt32LE(offset + 8);
			const virtualAddress = this.buffer.readUInt32LE(offset + 12);
			const rawSize = this.buffer.readUInt32LE(offset + 16);
			const rawOffset = this.buffer.readUInt32LE(offset + 20);
			const characteristics = this.buffer.readUInt32LE(offset + 36);
			const rawRangeValid = rawSize === 0 || (rawOffset >= this.headerEnd && rangeFits(rawOffset, rawSize, this.buffer.length));
			if (!rawRangeValid) this.warn("SECTION_RAW_RANGE", `Section ${name} has an invalid raw file range.`, { offset: rawOffset });
			if (virtualAddress + Math.max(virtualSize, rawSize) > 0x100000000) {
				this.warn("SECTION_RVA_RANGE", `Section ${name} overflows the 32-bit RVA address space.`, { rva: virtualAddress });
			}
			const sample = rawRangeValid ? entropy(this.buffer, rawOffset, rawSize) : { value: null, sampleBytes: 0 };
			this.sections.push({
				name, virtualAddress, virtualSize, rawOffset, rawSize, characteristics, rawRangeValid,
				executable: (characteristics & 0x20000000) !== 0,
				readable: (characteristics & 0x40000000) !== 0,
				writable: (characteristics & 0x80000000) !== 0,
				entropy: sample.value, entropySampleBytes: sample.sampleBytes, entropyIsSampled: sample.sampleBytes < rawSize,
			});
		}
		for (let i = 0; i < this.sections.length; i++) {
			const section = this.sections[i];
			for (const other of this.sections.slice(i + 1)) {
				if (section.virtualAddress < other.virtualAddress + Math.max(other.virtualSize, other.rawSize) && other.virtualAddress < section.virtualAddress + Math.max(section.virtualSize, section.rawSize)) {
					this.warn("SECTION_RVA_OVERLAP", `Sections ${section.name} and ${other.name} overlap in RVA space.`);
				}
				if (section.rawSize && other.rawSize && section.rawOffset < other.rawOffset + other.rawSize && other.rawOffset < section.rawOffset + section.rawSize) {
					this.warn("SECTION_RAW_OVERLAP", `Sections ${section.name} and ${other.name} overlap in file space.`);
				}
			}
		}
	}

	/** A virtual-only tail has no file bytes. Ambiguous RVA mappings are deliberately rejected. */
	map(rva: number, length = 1): MappedSpan | undefined {
		if (!rangeFits(rva, length, 0x100000000) || length < 1) return undefined;
		const candidates: MappedSpan[] = [];
		if (rangeFits(rva, length, this.headerMappingSize)) candidates.push({ offset: rva, available: this.headerMappingSize - rva });
		for (const section of this.sections) {
			if (!section.rawRangeValid || section.virtualAddress + Math.max(section.virtualSize, section.rawSize) > 0x100000000) continue;
			const delta = rva - section.virtualAddress;
			if (!rangeFits(delta, length, section.rawSize)) continue;
			candidates.push({ offset: section.rawOffset + delta, available: section.rawSize - delta });
		}
		if (candidates.length !== 1 || !rangeFits(candidates[0].offset, length, this.buffer.length)) return undefined;
		// A C string must also stop before entering another section's ambiguous RVA range.
		const candidate = candidates[0];
		for (const section of this.sections) {
			if (section.rawRangeValid && section.virtualAddress > rva) candidate.available = Math.min(candidate.available, section.virtualAddress - rva);
		}
		return candidate.available >= length ? candidate : undefined;
	}

	directory(index: number, minimum: number, name: string): DataDirectory | undefined {
		const directory = this.directories[index];
		if (!directory || (!directory.rva && !directory.size)) return undefined;
		if (!directory.rva || directory.size < minimum || !this.map(directory.rva, directory.size)) {
			this.warn("DIRECTORY_RANGE", `${name} directory has an invalid or non-contiguous RVA range.`, { rva: directory.rva });
			return undefined;
		}
		return directory;
	}

	cString(rva: number, name: string): string | undefined {
		const mapped = this.map(rva);
		if (!mapped) {
			this.warn("STRING_RVA", `${name} string has an invalid RVA.`, { rva });
			return undefined;
		}
		const count = Math.min(mapped.available, MAX_TABLE_STRING_BYTES);
		const end = this.buffer.indexOf(0, mapped.offset);
		if (end < mapped.offset || end >= mapped.offset + count) {
			this.warn("UNTERMINATED_STRING", `${name} string exceeds its section or the ${MAX_TABLE_STRING_BYTES}-byte limit.`, { rva });
			return undefined;
		}
		return this.buffer.subarray(mapped.offset, end).toString("latin1").replace(/[^\x20-\x7e]/g, "?");
	}

	readImports(): ExecutableImport[] {
		const directory = this.directory(1, 20, "Import");
		if (!directory) return [];
		const imports: ExecutableImport[] = [];
		const descriptorCount = Math.min(Math.floor(directory.size / 20), MAX_IMPORT_DLLS);
		let functionCount = 0;
		let terminated = false;
		for (let index = 0; index < descriptorCount; index++) {
			abortIfRequested(this.signal);
			const mapped = this.map(directory.rva + index * 20, 20);
			if (!mapped) break;
			const offset = mapped.offset;
			const originalThunk = this.buffer.readUInt32LE(offset);
			const timestamp = this.buffer.readUInt32LE(offset + 4);
			const forwarder = this.buffer.readUInt32LE(offset + 8);
			const nameRva = this.buffer.readUInt32LE(offset + 12);
			const firstThunk = this.buffer.readUInt32LE(offset + 16);
			if (!(originalThunk || timestamp || forwarder || nameRva || firstThunk)) { terminated = true; break; }
			const dll = this.cString(nameRva, "Import DLL");
			const imported: ExecutableImport = { dll: dll ?? `<invalid DLL RVA 0x${nameRva.toString(16)}>`, functions: [] };
			imports.push(imported);
			const thunkRva = originalThunk || firstThunk;
			const stride = this.format === "PE32+" ? 8 : 4;
			let thunkTerminated = false;
			for (let slot = 0; functionCount < this.limits.maxImports; slot++) {
				const thunk = this.map(thunkRva + slot * stride, stride);
				if (!thunk) { this.warn("IMPORT_THUNK_RVA", "Import thunk table leaves its raw section.", { rva: thunkRva + slot * stride }); break; }
				const value = stride === 8 ? this.buffer.readBigUInt64LE(thunk.offset) : BigInt(this.buffer.readUInt32LE(thunk.offset));
				if (value === 0n) { thunkTerminated = true; break; }
				functionCount++;
				const ordinalFlag = stride === 8 ? 0x8000000000000000n : 0x80000000n;
				if ((value & ordinalFlag) !== 0n) imported.functions.push({ ordinal: Number(value & 0xffffn) });
				else if (value > 0xffffffffn) this.warn("IMPORT_NAME_RVA", "PE32+ import name does not fit a 32-bit RVA.");
				else {
					const namePointer = Number(value);
					const hint = this.map(namePointer, 2);
					const name = hint ? this.cString(namePointer + 2, "Imported function") : undefined;
					if (hint && name !== undefined) imported.functions.push({ name, hint: this.buffer.readUInt16LE(hint.offset) });
					else if (!hint) this.warn("IMPORT_NAME_RVA", "Imported function hint has an invalid RVA.", { rva: namePointer });
				}
			}
			if (!thunkTerminated && functionCount >= this.limits.maxImports) { this.truncated.imports = true; break; }
		}
		if (!terminated) {
			if (Math.floor(directory.size / 20) > MAX_IMPORT_DLLS) this.truncated.imports = true;
			this.warn("IMPORT_TABLE_INCOMPLETE", "Import table did not reach its null descriptor within the directory or resource limit.");
		}
		return imports;
	}

	readExports(): ExecutableExport[] {
		const directory = this.directory(0, 40, "Export");
		if (!directory) return [];
		const header = this.map(directory.rva, 40);
		if (!header) return [];
		const offset = header.offset;
		const ordinalBase = this.buffer.readUInt32LE(offset + 16);
		const functionCount = this.buffer.readUInt32LE(offset + 20);
		const nameCount = this.buffer.readUInt32LE(offset + 24);
		const functionTable = this.buffer.readUInt32LE(offset + 28);
		const nameTable = this.buffer.readUInt32LE(offset + 32);
		const ordinalTable = this.buffer.readUInt32LE(offset + 36);
		const count = Math.min(functionCount, this.limits.maxExports);
		this.truncated.exports = functionCount > count || nameCount > this.limits.maxExports;
		const names = new Map<number, string>();
		for (let index = 0; index < Math.min(nameCount, this.limits.maxExports); index++) {
			const name = this.map(nameTable + index * 4, 4);
			const ordinal = this.map(ordinalTable + index * 2, 2);
			if (!name || !ordinal) { this.warn("EXPORT_NAME_TABLE", "Export names/ordinals leave their raw section."); break; }
			const functionIndex = this.buffer.readUInt16LE(ordinal.offset);
			if (functionIndex >= functionCount) { this.warn("EXPORT_ORDINAL", "Export name ordinal is outside the address table."); continue; }
			const text = this.cString(this.buffer.readUInt32LE(name.offset), "Export name");
			if (text !== undefined && !names.has(functionIndex)) names.set(functionIndex, text);
		}
		const exports: ExecutableExport[] = [];
		for (let index = 0; index < count; index++) {
			abortIfRequested(this.signal);
			const address = this.map(functionTable + index * 4, 4);
			if (!address) { this.warn("EXPORT_ADDRESS_TABLE", "Export addresses leave their raw section."); break; }
			const rva = this.buffer.readUInt32LE(address.offset);
			if (!rva) continue;
			const exported: ExecutableExport = { ordinal: ordinalBase + index, rva };
			const name = names.get(index);
			if (name !== undefined) exported.name = name;
			if (rva >= directory.rva && rva < directory.rva + directory.size) {
				const forwarder = this.cString(rva, "Export forwarder");
				if (forwarder !== undefined) exported.forwarder = forwarder;
			} else if (!this.map(rva)) this.warn("EXPORT_RVA", "Export address has no raw file mapping.", { rva });
			exports.push(exported);
		}
		return exports;
	}

	readClr(): ExecutableClrInfo {
		const declared = this.directories[14];
		if (!declared || !(declared.rva || declared.size)) return { present: false, valid: false };
		const info: ExecutableClrInfo = { present: true, valid: false, rva: declared.rva, size: declared.size };
		const directory = this.directory(14, 72, "CLR");
		const mapped = directory ? this.map(directory.rva, 72) : undefined;
		if (!mapped) return info;
		const offset = mapped.offset;
		const headerSize = this.buffer.readUInt32LE(offset);
		if (headerSize < 72 || headerSize > declared.size) { this.warn("CLR_HEADER_SIZE", "CLR header size is invalid."); return info; }
		info.valid = true;
		info.runtimeVersion = `${this.buffer.readUInt16LE(offset + 4)}.${this.buffer.readUInt16LE(offset + 6)}`;
		info.flags = this.buffer.readUInt32LE(offset + 16);
		const entry = this.buffer.readUInt32LE(offset + 20);
		if (info.flags & 0x10) info.nativeEntryPointRva = entry;
		else info.entryPointToken = entry;
		const metadataRva = this.buffer.readUInt32LE(offset + 8);
		const metadataSize = this.buffer.readUInt32LE(offset + 12);
		const metadata = metadataSize >= 16 ? this.map(metadataRva, metadataSize) : undefined;
		info.metadata = { rva: metadataRva, size: metadataSize, signatureValid: false };
		if (!metadata || this.buffer.readUInt32LE(metadata.offset) !== 0x424a5342) {
			this.warn("CLR_METADATA", "CLR metadata is outside its raw section or lacks the BSJB signature.", { rva: metadataRva });
			info.valid = false;
			return info;
		}
		info.metadata.signatureValid = true;
		const versionLength = this.buffer.readUInt32LE(metadata.offset + 12);
		if (versionLength > 256 || !rangeFits(16, versionLength, metadataSize)) {
			this.warn("CLR_VERSION", "CLR metadata version exceeds its bounds or the 256-byte limit.");
		} else info.metadata.version = this.buffer.subarray(metadata.offset + 16, metadata.offset + 16 + versionLength).toString("utf8").replace(/\0+$/, "");
		return info;
	}
}

function isWidePrintable(unit: number): boolean {
	return (unit >= 0x20 && unit <= 0x7e) || (unit >= 0xa0 && unit <= 0x24f) || (unit >= 0x370 && unit <= 0x52f) || (unit >= 0x3040 && unit <= 0x30ff) || (unit >= 0x4e00 && unit <= 0x9fff) || (unit >= 0xac00 && unit <= 0xd7af);
}

async function scanStrings(reader: PeReader): Promise<Pick<ExecutableInspectionReport, "strings" | "urls" | "stringsScan">> {
	const { buffer, limits } = reader;
	const scanBytes = Math.min(buffer.length, limits.maxStringScanBytes);
	const candidates: ExecutableString[] = [];
	const urls: ExecutableInspectionReport["urls"] = [];
	const seenUrls = new Set<string>();
	let candidateCount = 0;
	const collect = (start: number, value: string, length: number, encoding: ExecutableString["encoding"]) => {
		if (length < limits.minStringLength) return;
		const item = { offset: start, value, encoding, truncated: length > value.length };
		if (limits.includeStrings) {
			candidateCount++;
			// Each encoding has a bounded candidate budget; the final list is sorted by file offset.
			if (candidates.length < limits.maxStrings * 3) candidates.push(item);
		}
		for (const match of value.matchAll(/(?:https?|ftp):\/\/[^\s"'<>`\\\x00-\x1f]+/gi)) {
			const url = match[0].replace(/[),.;\]}]+$/, "");
			if (seenUrls.has(url)) continue;
			if (urls.length >= limits.maxUrls) { reader.truncated.urls = true; break; }
			seenUrls.add(url);
			urls.push({ url, offset: start + (match.index ?? 0) * (encoding === "utf16le" ? 2 : 1), encoding });
		}
	};
	let start = 0;
	let length = 0;
	let value = "";
	for (let offset = 0; offset <= scanBytes; offset++) {
		if (offset % MIB === 0) { abortIfRequested(reader.signal); await yieldToEventLoop(); }
		const byte = offset < scanBytes ? buffer[offset] : 0;
		if (byte >= 0x20 && byte <= 0x7e) {
			if (!length) start = offset;
			length++;
			if (value.length < limits.maxStringLength) value += String.fromCharCode(byte);
		} else {
			collect(start, value, length, "ascii");
			length = 0; value = "";
		}
	}
	for (let alignment = 0; alignment < 2; alignment++) {
		start = 0; length = 0; value = "";
		for (let offset = alignment; offset + 1 < scanBytes; offset += 2) {
			if ((offset - alignment) % MIB === 0) { abortIfRequested(reader.signal); await yieldToEventLoop(); }
			const unit = buffer.readUInt16LE(offset);
			if (isWidePrintable(unit)) {
				if (!length) start = offset;
				length++;
				if (value.length < limits.maxStringLength) value += String.fromCharCode(unit);
			} else {
				// A NUL terminator reduces false positives in arbitrary binary data.
				if (unit === 0) collect(start, value, length, "utf16le");
				length = 0; value = "";
			}
		}
	}
	abortIfRequested(reader.signal);
	reader.truncated.strings = limits.includeStrings && candidateCount > limits.maxStrings;
	return {
		strings: candidates.sort((a, b) => a.offset - b.offset || a.encoding.localeCompare(b.encoding)).slice(0, limits.maxStrings),
		urls,
		stringsScan: { scannedBytes: scanBytes, totalBytes: buffer.length, truncated: scanBytes < buffer.length, includesStrings: limits.includeStrings, utf16Policy: "NUL-terminated printable Latin, Greek, Cyrillic, CJK, Kana and Hangul at either byte alignment; not a complete Unicode decoder." },
	};
}

/**
 * Read-only static inspection of an authorized local PE image. No child process, loader,
 * network request, signature trust claim, unpacker, disassembler or executable write is used.
 * PE layouts follow https://learn.microsoft.com/en-us/windows/win32/debug/pe-format .
 */
export async function inspectExecutable(options: InspectExecutableOptions, signal?: AbortSignal): Promise<ExecutableInspectionReport> {
	const limits = normalizeLimits(options);
	const file = await readWorkspaceFile(options, limits, signal);
	const reader = new PeReader(file.buffer, limits, signal);
	reader.readHeaders();
	const imports = reader.readImports();
	const exports = reader.readExports();
	const clr = reader.readClr();
	const entryMapping = reader.entryPointRva ? reader.map(reader.entryPointRva) : undefined;
	const entrySections = reader.sections.filter((section) => reader.entryPointRva >= section.virtualAddress && reader.entryPointRva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize));
	if (reader.entryPointRva && !entryMapping) reader.warn("ENTRY_POINT_RVA", "Entry point has no unambiguous raw file mapping.", { rva: reader.entryPointRva });
	const certificate = reader.directories[4];
	let certificateTable: ExecutableInspectionReport["certificateTable"] = null;
	if (certificate && (certificate.rva || certificate.size)) {
		const valid = certificate.rva >= reader.headerEnd && certificate.size >= 8 && rangeFits(certificate.rva, certificate.size, file.buffer.length);
		certificateTable = { offset: certificate.rva, size: certificate.size, valid };
		if (!valid) reader.warn("CERTIFICATE_RANGE", "Certificate directory uses an invalid file-offset range; no signature verification was performed.");
	}
	const imageEnd = Math.max(reader.headerEnd, reader.headerMappingSize, ...reader.sections.filter((section) => section.rawRangeValid && section.rawSize > 0).map((section) => section.rawOffset + section.rawSize));
	const overlaySize = file.buffer.length - imageEnd;
	const certificateTableBytes = certificateTable?.valid ? Math.max(0, Math.min(file.buffer.length, certificateTable.offset + certificateTable.size) - Math.max(imageEnd, certificateTable.offset)) : 0;
	const packerIndicators: ExecutableInspectionReport["packerIndicators"] = [];
	for (const section of reader.sections) {
		if (/^(?:UPX[0-9]?|\.?(?:aspack|adata|petite|mpress[12]?|packed))$/i.test(section.name)) {
			packerIndicators.push({ kind: "heuristic", code: "PACKER_SECTION_NAME", message: "Section name resembles a known packer convention; names can be forged.", section: section.name });
		}
		if (section.entropy !== null && section.entropy > 7.2 && section.rawSize >= 1024) {
			packerIndicators.push({ kind: "heuristic", code: "HIGH_ENTROPY_SECTION", message: `Sample entropy ${section.entropy} bits/byte may indicate compressed, encrypted or other high-entropy data.`, section: section.name });
		}
		if (section.executable && section.writable) packerIndicators.push({ kind: "heuristic", code: "WRITABLE_EXECUTABLE_SECTION", message: "Writable executable section is an investigation clue, not proof of packing or malicious behavior.", section: section.name });
		if (section.virtualSize >= MIB && section.virtualSize >= Math.max(section.rawSize, 1) * 10) packerIndicators.push({ kind: "heuristic", code: "LARGE_VIRTUAL_TAIL", message: "Large virtual-to-raw size difference may represent unpacking space or ordinary uninitialized data.", section: section.name });
	}
	if (reader.entryPointRva && entrySections.length === 1 && !entrySections[0].executable) packerIndicators.push({ kind: "heuristic", code: "NON_EXECUTABLE_ENTRY_SECTION", message: "Entry point is in a section without the executable flag.", section: entrySections[0].name });
	const strings = await scanStrings(reader);
	const coff = reader.peOffset + 4;
	const characteristics = file.buffer.readUInt16LE(coff + 18);
	const subsystem = file.buffer.readUInt16LE(reader.optionalOffset + 68);
	const machines: Record<number, string> = { 0x14c: "x86", 0x8664: "x64", 0x1c0: "arm", 0x1c4: "arm-thumb2", 0xaa64: "arm64", 0xa641: "arm64ec", 0xa64e: "arm64x", 0x200: "ia64", 0x5032: "riscv32", 0x5064: "riscv64" };
	const subsystems: Record<number, string> = { 1: "native", 2: "windows-gui", 3: "windows-console", 9: "windows-ce", 10: "efi-application", 11: "efi-boot-driver", 12: "efi-runtime-driver", 14: "xbox", 16: "windows-boot-application" };
	return {
		file: { path: file.path, size: file.buffer.length, sha256: file.sha256 },
		format: reader.format, architecture: machines[reader.machine] ?? `unknown-0x${reader.machine.toString(16)}`, machine: reader.machine,
		imageBase: reader.imageBase,
		entryPoint: { rva: reader.entryPointRva, fileOffset: entryMapping?.offset ?? null, section: entrySections.length === 1 ? entrySections[0].name : null },
		coff: { timestamp: file.buffer.readUInt32LE(coff + 4), characteristics, isDll: (characteristics & 0x2000) !== 0 },
		subsystem: { value: subsystem, name: subsystems[subsystem] ?? `unknown-${subsystem}` },
		sections: reader.sections, imports, exports, clr, certificateTable,
		overlay: { offset: imageEnd, size: overlaySize, certificateTableBytes, estimated: reader.sections.some((section) => !section.rawRangeValid) || !reader.headerMappingSize },
		...strings, packerIndicators, warnings: reader.warnings, truncated: reader.truncated, limits,
		limitations: [
			"Static metadata and strings only; the executable was not run, modified, unpacked or dynamically debugged.",
			"Packer indicators are heuristics, not a confirmed packer, malware verdict or successful unpacking result.",
			"URLs are unvisited text clues; strings and tables may be incomplete because of declared resource limits or malformed data.",
			"Section entropy uses at most 64 KiB spread over each raw section; certificate bytes are not signature trust verification.",
			"Imports cover the standard import directory; delay imports, resource trees, disassembly and CLR IL/metadata tables are not decoded.",
		],
	};
}
