/**
 * Persist one generated image as a file under the session workspace.
 * Ported from dsh-image-gen src/workspace-save.ts (Apache-2.0), trimmed to
 * the save path: the DSH attachment id is replaced by a sha256 digest of the
 * image bytes, so the deterministic content-addressed file name survives.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extensionOf, type ImageMediaType } from "./media.ts";

/** Deterministic file name for a generated image: `image-<digest-prefix>.<ext>`.
 * The same image bytes always map to the same file name regardless of when
 * they were generated, and re-saving simply overwrites the previous copy. */
export function workspaceImageName(data: Uint8Array, mediaType: ImageMediaType): string {
	const digest = createHash("sha256").update(data).digest("hex");
	return `image-${digest.slice(0, 8)}.${extensionOf(mediaType)}`;
}

/** Durable id-shaped digest of the image bytes (used in result text). */
export function imageDigest(data: Uint8Array): string {
	return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * Resolve the configured image folder inside the session workspace. The
 * folder may nest, but must stay inside the workspace: absolute paths and
 * parent-traversal segments are rejected for both separator styles.
 *
 * This lexical pass is necessary but not sufficient: `saveImageToWorkspace`
 * additionally verifies the on-disk resolution so symlinked folders cannot
 * escape the workspace.
 */
export function workspaceImageDir(workspaceRoot: string, folder: string | undefined): string {
	const trimmed = (folder ?? "").trim();
	const root = resolve(workspaceRoot);
	// An absolute folder resolves to itself and is rejected by the containment check below.
	const dir = trimmed === "" ? root : resolve(root, trimmed);
	if (!containsPath(root, dir)) {
		throw new Error(`image workspace folder '${folder}' must stay inside the session workspace`);
	}
	return dir;
}

/** True when `child` equals `parent` or lives underneath it (lexically). */
function containsPath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Real path of the closest existing ancestor of `dir` (inclusive). Walking up
 * lets us validate symlinked folder segments before creating anything under
 * them.
 */
async function nearestExistingRealPath(dir: string): Promise<string> {
	let probe = dir;
	for (;;) {
		try {
			return await realpath(probe);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			const parent = dirname(probe);
			if (parent === probe) throw error; // reached the filesystem root
			probe = parent;
		}
	}
}

/** Reject a directory whose on-disk resolution lands outside the workspace. */
function assertInsideWorkspace(realRoot: string, candidate: string, folder: string | undefined): void {
	if (containsPath(realRoot, candidate)) return;
	throw new Error(`image workspace folder '${folder ?? ""}' must stay inside the session workspace (${candidate} resolves outside ${realRoot})`);
}

/**
 * Write one generated image durably under the session workspace.
 *
 * Containment is enforced twice: lexically by `workspaceImageDir`, then
 * against real paths, so a configured folder (or any intermediate segment)
 * that is a symlink pointing outside the workspace is rejected before and
 * after anything is created.
 *
 * The bytes are written to a same-directory staging file and renamed onto the
 * target, so a crash never leaves a half-written image under its final name.
 * A cancellation is honoured up to and including the final rename: an aborted
 * save never resolves successfully and never leaves the image behind.
 */
export async function saveImageToWorkspace(options: {
	workspaceRoot: string
	folder?: string | undefined
	mediaType: ImageMediaType
	data: Uint8Array
	signal?: AbortSignal
}): Promise<string> {
	const dir = workspaceImageDir(options.workspaceRoot, options.folder);
	options.signal?.throwIfAborted();
	const realRoot = await realpath(resolve(options.workspaceRoot));
	assertInsideWorkspace(realRoot, await nearestExistingRealPath(dir), options.folder);
	const name = workspaceImageName(options.data, options.mediaType);
	const target = join(dir, name);
	const staging = join(dir, `.${name}.${process.pid}-${randomUUID()}.tmp`);
	await mkdir(dir, { recursive: true });
	// Re-validate the finished directory: creating it may have traversed a
	// symlink, and links can be swapped in between the checks above.
	assertInsideWorkspace(realRoot, await realpath(dir), options.folder);
	try {
		await writeFile(staging, options.data, { flag: "wx", signal: options.signal });
		options.signal?.throwIfAborted();
		await rename(staging, target);
	} catch (error) {
		await unlink(staging).catch(() => {});
		throw error;
	}
	// Final gate: a cancellation landing during the last write/rename step must
	// not be reported as a successful save, and the already-renamed file is
	// removed so no orphan image outlives the cancelled call.
	try {
		options.signal?.throwIfAborted();
	} catch (error) {
		await unlink(target).catch(() => {});
		throw error;
	}
	return target;
}
