/**
 * Resolve the reference image(s) an edit_image call should use.
 *
 * The DSH attachment-store selectors of the upstream bundle are replaced by
 * owl-native ones: workspace files (safely contained) and, as the no-selector
 * fallback, the images of the newest image-bearing message in the current
 * conversation — owl messages carry image blocks inline, so no attachment
 * store is needed. Containment logic ported from dsh-image-gen
 * src/reference-image.ts (Apache-2.0).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectImageMediaType, type GeneratedImage, type ImageMediaType } from "./media.ts";

/** The slice of an owl message this module understands. */
export interface OwlMessageLike {
	role?: string
	content?: unknown
}

/** Minimal session surface for the conversation fallback. */
export interface OwlSessionLike {
	buildSessionProjection(): { messages: readonly OwlMessageLike[] }
}

/** Explicit selector fields accepted by edit_image. */
export interface ReferenceSelectors {
	sourcePath?: string
	sourcePaths?: readonly string[]
}

/**
 * Resolve one or more edit references. Explicit `source_path(s)` preserve
 * caller order; without selectors, every image of the newest image-bearing
 * conversation message is used (user messages preferred over tool output).
 */
export async function resolveReferenceImages(input: {
	session?: OwlSessionLike
	sourcePath?: string
	sourcePaths?: readonly string[]
	maxBytes: number
	signal: AbortSignal
	proxy?: string
}): Promise<GeneratedImage[]> {
	const sourcePaths = mergeSelectors(input.sourcePath, input.sourcePaths);
	if (sourcePaths !== undefined) {
		const workspaceRoot = input.session === undefined ? undefined : sessionCwdOf(input.session);
		return Promise.all(sourcePaths.map((sourcePath) => readWorkspaceReferenceImage({
			sourcePath,
			...(workspaceRoot === undefined ? {} : { workspaceRoot }),
			maxBytes: input.maxBytes,
			signal: input.signal,
		})));
	}

	if (input.session === undefined) {
		throw new Error("edit_image requires source_path when no active session provides conversation images");
	}
	const images = findConversationImages(input.session.buildSessionProjection().messages);
	if (images.length === 0) {
		throw new Error("edit_image requires a reference image: name a workspace file with source_path, or generate/upload an image into the conversation first");
	}
	return images.map((image) => ({ data: image.data, mediaType: image.mediaType }));
}

/** Best-effort cwd of the session (owl sessions know their working directory). */
function sessionCwdOf(session: OwlSessionLike): string | undefined {
	const cwd = (session as OwlSessionLike & { getCwd?: () => string }).getCwd?.();
	return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/**
 * Read an explicitly named workspace image without exposing filesystem
 * details to provider adapters. Both lexical and real-path containment are
 * enforced so absolute paths, parent traversal, and symlink escapes fail.
 */
async function readWorkspaceReferenceImage(input: {
	sourcePath: string
	workspaceRoot?: string
	maxBytes: number
	signal: AbortSignal
}): Promise<GeneratedImage> {
	const requested = input.sourcePath.trim();
	if (requested.length === 0) throw new Error("edit_image source_path must not be empty");

	// No workspace root known: accept absolute paths as-is but still enforce
	// image-type and size; relative paths have nothing to resolve against.
	if (input.workspaceRoot === undefined) {
		if (!isAbsolute(requested)) throw new Error("edit_image source_path requires an absolute path when no session workspace is known");
		return readContainedImage(resolve(requested), input.maxBytes, input.signal, requested);
	}

	const root = resolve(input.workspaceRoot);
	const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
	if (!containsPath(root, candidate)) {
		throw new Error("edit_image source_path must stay inside the session workspace: " + requested);
	}

	let realRoot: string;
	let realCandidate: string;
	try {
		[realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("edit_image could not find workspace image: " + requested);
		}
		throw error;
	}
	if (!containsPath(realRoot, realCandidate)) {
		throw new Error("edit_image source_path resolves outside the session workspace: " + requested);
	}
	return readContainedImage(realCandidate, input.maxBytes, input.signal, requested);
}

async function readContainedImage(path: string, maxBytes: number, signal: AbortSignal, label: string): Promise<GeneratedImage> {
	const file = await stat(path);
	if (!file.isFile()) throw new Error("edit_image source_path is not a file: " + label);
	if (file.size > maxBytes) {
		throw new Error(`edit_image source image is too large (${String(file.size)} bytes; maximum ${String(maxBytes)})`);
	}
	const data = await readFile(path, { signal });
	const mediaType = detectImageMediaType(new Uint8Array(data));
	if (mediaType === undefined) {
		throw new Error("edit_image source_path is not a supported PNG, JPEG, WebP, or GIF image: " + label);
	}
	return { data: new Uint8Array(data), mediaType };
}

/**
 * Collect every image block of the newest image-bearing message. Owl
 * conversation messages carry images inline as `{ type: "image", data,
 * mimeType }` content blocks — both user-attached images and images this
 * plugin itself returned in earlier tool results qualify, which is what
 * makes continuous editing work.
 */
export function findConversationImages(messages: readonly OwlMessageLike[]): Array<{ data: Uint8Array; mediaType: ImageMediaType }> {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const images = collectInContent(messages[index]?.content);
		if (images.length > 0) return images;
	}
	return [];
}

function collectInContent(content: unknown): Array<{ data: Uint8Array; mediaType: ImageMediaType }> {
	const images: Array<{ data: Uint8Array; mediaType: ImageMediaType }> = [];
	if (!Array.isArray(content)) return images;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const row = block as { type?: unknown; data?: unknown; mimeType?: unknown; mediaType?: unknown; content?: unknown };
		if (row.type === "image" && typeof row.data === "string" && row.data.length > 0) {
			const declared = typeof row.mimeType === "string" ? row.mimeType : typeof row.mediaType === "string" ? row.mediaType : undefined;
			const data = new Uint8Array(Buffer.from(row.data.replace(/\s+/g, ""), "base64"));
			// Sniff the bytes; fall back to the declared type only when they are clean.
			const mediaType = detectImageMediaType(data) ?? (declared === "image/png" || declared === "image/jpeg" || declared === "image/webp" || declared === "image/gif" ? declared : undefined);
			if (mediaType !== undefined && data.byteLength > 0) images.push({ data, mediaType });
			continue;
		}
		// Nested tool-result content (defensive; owl messages are usually flat).
		if (row.content !== undefined && Array.isArray(row.content)) images.push(...collectInContent(row.content));
	}
	return images;
}

/** Merge single/multiple path selectors with ordering and conflict checks. */
function mergeSelectors(single: string | undefined, multiple: readonly string[] | undefined): readonly string[] | undefined {
	if (multiple === undefined) {
		return single === undefined ? undefined : [single];
	}
	if (multiple.length === 0) {
		if (single !== undefined) return [single];
		throw new Error("edit_image source_paths must not be empty");
	}
	if (single !== undefined && !multiple.some((value) => value.trim() === single.trim())) {
		throw new Error("edit_image source_path must also appear in source_paths when both are provided");
	}
	return multiple;
}

function containsPath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
