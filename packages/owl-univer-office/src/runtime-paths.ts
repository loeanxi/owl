import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class OfficeRuntimeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "OfficeRuntimeError";
		this.code = code;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new OfficeRuntimeError("INVALID_ARGUMENT", `${label} must be a non-empty string.`);
	}
	return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requiredString(value, label);
}

export function assertInside(root: string, path: string): void {
	const suffix = relative(root, path);
	if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
		throw new OfficeRuntimeError("WORKSPACE_DENIED", "The Office file must remain inside the current workspace.");
	}
}

function missing(error: unknown): boolean {
	return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Follow existing ancestors as well as the target, so symlink/junction escapes fail closed. */
export async function authorizePath(cwd: string, input: string, mode: "existing" | "new"): Promise<string> {
	const root = await realpath(requiredString(cwd, "cwd"));
	const candidate = resolve(root, requiredString(input, "path"));
	assertInside(root, candidate);
	if (mode === "existing") {
		const canonical = await realpath(candidate);
		assertInside(root, canonical);
		const info = await lstat(canonical);
		if (!info.isFile()) throw new OfficeRuntimeError("INVALID_FILE", "The target must be a regular file.");
		return canonical;
	}
	try {
		await lstat(candidate);
		throw new OfficeRuntimeError("OUTPUT_EXISTS", "The output already exists. Choose another filename.");
	} catch (error) {
		if (!missing(error)) throw error;
	}
	let ancestor = dirname(candidate);
	for (;;) {
		try {
			const canonical = resolve(await realpath(ancestor), relative(ancestor, candidate));
			assertInside(root, canonical);
			return canonical;
		} catch (error) {
			if (!missing(error)) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			ancestor = parent;
		}
	}
}

export function fileKey(path: string): string {
	return Buffer.from(path, "utf8").toString("base64url");
}

export function kindType(kind: unknown): number {
	if (kind === "doc") return 1;
	if (kind === "sheet") return 2;
	if (kind === "slide") return 3;
	if (kind === "base") return 5;
	if (kind === "board") return 6;
	throw new OfficeRuntimeError("INVALID_UNIT_KIND", "kind must be sheet, doc, slide, base, or board.");
}

export function unitKind(type: unknown): string {
	if (type === 1) return "doc";
	if (type === 2) return "sheet";
	if (type === 3) return "slide";
	if (type === 5) return "base";
	if (type === 6) return "board";
	throw new OfficeRuntimeError("INVALID_UNIT_TYPE", "The Gateway returned an unsupported Unit type.");
}
