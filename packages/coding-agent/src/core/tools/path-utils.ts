import { accessSync, constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}

const MAX_PATH_CORRECTION_CHILDREN = 80;

function isFilesystemRoot(directory: string): boolean {
	return path.parse(directory).root === directory;
}

/**
 * Repair a missing path when exactly one existing path differs by one directory segment.
 * Models often insert or drop a single remembered directory; an ambiguous repair is left unchanged.
 */
export async function correctMissingPath(absolutePath: string): Promise<string> {
	const requested = path.resolve(absolutePath);
	if (await pathExists(requested)) return requested;
	const missing: string[] = [];
	let cursor = requested;
	let ancestor = "";
	while (!isFilesystemRoot(cursor)) {
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		missing.unshift(path.basename(cursor));
		if (await pathExists(parent)) {
			ancestor = parent;
			break;
		}
		cursor = parent;
	}
	if (!ancestor || missing.length === 0) return requested;
	try {
		if (!(await stat(ancestor)).isDirectory()) return requested;
	} catch {
		return requested;
	}
	const candidates = new Set<string>();
	const accept = async (candidate: string) => {
		if (candidate !== requested && (await pathExists(candidate))) candidates.add(candidate);
	};
	for (let index = 0; index < missing.length - 1; index++) {
		await accept(path.join(ancestor, ...missing.slice(0, index), ...missing.slice(index + 1)));
	}
	let children: string[] = [];
	try {
		children = await readdir(ancestor);
	} catch {
		children = [];
	}
	if (children.length <= MAX_PATH_CORRECTION_CHILDREN) {
		for (const child of children) await accept(path.join(ancestor, child, ...missing));
	}
	return candidates.size === 1 ? [...candidates][0]! : requested;
}

export function pathCorrectionNote(requested: string, actual: string): string {
	return `[Path corrected from ${requested} to ${actual}. Copy this path exactly; do not insert or drop a directory segment from memory.]`;
}
