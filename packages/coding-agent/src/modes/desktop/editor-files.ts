/** Versioned, lossless text editing. Files keep their inode and Windows ACL. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { withFileLockSync } from "../../utils/atomic-file.ts";
import type { FsReadResult, FsWriteResult } from "./protocol.ts";

export const EDITOR_TEXT_LIMIT = 1_000_000;

export interface EditorMutationIO {
	write(fd: number, bytes: Uint8Array, offset: number, length: number, position: number): number;
	truncate(fd: number, size: number): void;
	sync(fd: number): void;
}

function hash(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function editorPathKey(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function canonicalEditorWorkspace(cwd: string): string {
	let probe = resolve(cwd);
	const tail: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(probe), ...tail);
		} catch (error) {
			if (!missing(error)) throw error;
			const parent = dirname(probe);
			if (parent === probe) return resolve(cwd);
			tail.unshift(probe.slice(parent.length).replace(/^[\\/]+/, ""));
			probe = parent;
		}
	}
}

function below(root: string, target: string): boolean {
	const child = relative(root, target);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Resolve the workspace alias once, and reject links introduced anywhere below it. */
function guardedPath(cwd: string, absolute: string): { path: string; readOnlyReason?: string } {
	if (!below(resolve(cwd), resolve(absolute))) throw new Error("目标必须是工作区中的文件");
	const root = realpathSync(cwd);
	const path = join(root, relative(resolve(cwd), resolve(absolute)));
	let cursor = root;
	let readOnlyReason: string | undefined;
	for (const segment of relative(root, path).split(sep)) {
		cursor = join(cursor, segment);
		try {
			if (lstatSync(cursor).isSymbolicLink()) readOnlyReason = "符号链接或目录联接只允许预览";
		} catch (error) {
			if (!missing(error)) throw error;
			break;
		}
	}
	let actual = path;
	try {
		actual = realpathSync(path);
	} catch (error) {
		if (!missing(error)) throw error;
	}
	if (!below(root, actual)) throw new Error("目标越出工作区");
	return { path, readOnlyReason };
}

function identity(info: ReturnType<typeof fstatSync>): string {
	return JSON.stringify([
		info.dev,
		info.ino,
		info.size,
		info.mode,
		info.mtimeMs,
		info.ctimeMs,
		info.birthtimeMs,
		info.nlink,
	]);
}

function inode(info: ReturnType<typeof fstatSync>): string {
	return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

function readState(
	cwd: string,
	absolute: string,
): { result: FsReadResult; bytes: Buffer; inode: string; path: string } {
	const resolved = guardedPath(cwd, absolute);
	const actual = realpathSync(resolved.path);
	const fd = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = fstatSync(fd);
		if (!before.isFile()) throw new Error("目标不是普通文件");
		const buffer = Buffer.alloc(Math.min(before.size, EDITOR_TEXT_LIMIT));
		let read = 0;
		while (read < buffer.length) {
			const count = readSync(fd, buffer, read, buffer.length - read, read);
			if (count === 0) break;
			read += count;
		}
		const bytes = buffer.subarray(0, read);
		const after = fstatSync(fd);
		const atPath = lstatSync(actual);
		if (
			identity(before) !== identity(after) ||
			inode(after) !== inode(atPath) ||
			read !== buffer.length ||
			editorPathKey(realpathSync(resolved.path)) !== editorPathKey(actual)
		) {
			throw new Error("读取期间文件已变化，请重新读取");
		}
		const finalPath = guardedPath(cwd, absolute);
		const truncated = before.size > EDITOR_TEXT_LIMIT;
		const binary = bytes.includes(0);
		const content = binary ? "" : bytes.toString("utf8");
		const utf8 = !binary && Buffer.from(content, "utf8").equals(bytes);
		const readOnlyReason =
			finalPath.readOnlyReason ??
			resolved.readOnlyReason ??
			(before.nlink > 1
				? "硬链接文件只允许预览"
				: binary
					? "二进制文件不能作为文本保存"
					: truncated
						? "文件超过文本读取上限，当前仅为截断预览"
						: !utf8
							? "文件不是完整有效的 UTF-8 文本"
							: undefined);
		const revision = readOnlyReason
			? null
			: `owl-file-v1:${hash(bytes)}:${hash(`${editorPathKey(actual)}\0${identity(after)}`)}`;
		return {
			path: resolved.path,
			bytes,
			inode: inode(after),
			result: {
				kind: binary ? "binary" : "text",
				content,
				truncated,
				size: before.size,
				revision,
				editable: revision !== null,
				...(readOnlyReason ? { readOnlyReason } : {}),
				...(binary ? { head: bytes.subarray(0, 4096).toString("base64") } : {}),
			},
		};
	} finally {
		closeSync(fd);
	}
}

export function readEditorFile(cwd: string, absolute: string): FsReadResult {
	return readState(cwd, absolute).result;
}

export function validEditorText(content: string): boolean {
	return (
		typeof content === "string" &&
		!content.includes("\0") &&
		Buffer.byteLength(content, "utf8") <= EDITOR_TEXT_LIMIT &&
		Buffer.from(content, "utf8").toString("utf8") === content
	);
}

/** A draft baseline must match a complete read's content hash, not a truncated preview. */
export function editorRevisionMatchesContent(revision: string | null, content: string): boolean {
	if (!validEditorText(content)) return false;
	if (revision === null) return content === "";
	const match = /^owl-file-v1:([a-f0-9]{64}):[a-f0-9]{64}$/.exec(revision);
	return match !== null && match[1] === hash(Buffer.from(content, "utf8"));
}

function missing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class EditorMutationFailure extends Error {
	/** Present only when the observed failure bytes can be explained by our own mutation. */
	readonly ownBytes: Buffer | undefined;
	constructor(error: unknown, ownBytes?: Buffer) {
		super(message(error));
		this.ownBytes = ownBytes;
	}
}

function descriptorBytes(fd: number): Buffer {
	const before = fstatSync(fd);
	if (!before.isFile() || before.size > EDITOR_TEXT_LIMIT) throw new Error("文件已出现其他内容，不能自动回写");
	const bytes = Buffer.alloc(before.size);
	let read = 0;
	while (read < bytes.length) {
		const count = readSync(fd, bytes, read, bytes.length - read, read);
		if (count === 0) break;
		read += count;
	}
	if (read !== bytes.length || identity(before) !== identity(fstatSync(fd)))
		throw new Error("核对失败字节时文件仍在变化");
	return bytes;
}

function writtenBytes(before: Buffer, source: Buffer, position: number, count: number): Buffer {
	const expected = Buffer.alloc(Math.max(before.length, position + count));
	before.copy(expected);
	source.copy(expected, position, position, position + count);
	return expected;
}

type WriteStage =
	| { kind: "write"; before: Buffer; position: number; source: Buffer }
	| { kind: "truncate"; before: Buffer; length: number }
	| { kind: "sync"; before: Buffer };

function truncatedBytes(before: Buffer, length: number): Buffer {
	const result = Buffer.alloc(length);
	before.copy(result);
	return result;
}

function matchesOwnFailure(stage: WriteStage | undefined, expected: Buffer, actual: Buffer): boolean {
	if (!stage) return actual.equals(expected);
	if (stage.kind === "sync") return actual.equals(stage.before);
	if (stage.kind === "truncate")
		return actual.equals(stage.before) || actual.equals(truncatedBytes(stage.before, stage.length));
	if (actual.length < stage.before.length || actual.length > Math.max(stage.before.length, stage.source.length))
		return false;
	let end = stage.position;
	for (let index = 0; index < actual.length; index++)
		if (actual[index] !== stage.before[index]) end = Math.max(end, index + 1);
	const count = actual.length > stage.before.length ? actual.length - stage.position : end - stage.position;
	if (count < 0 || count > stage.source.length - stage.position) return false;
	return actual.equals(writtenBytes(stage.before, stage.source, stage.position, count));
}

/** Verify each intermediate byte state, including partial writes that throw without returning their count. */
function writeAll(io: EditorMutationIO, fd: number, bytes: Buffer, initial: Buffer, assertIdentity: () => void): void {
	let expected: Buffer = Buffer.from(initial);
	let stage: WriteStage | undefined;
	const check = (): void => {
		assertIdentity();
		if (!descriptorBytes(fd).equals(expected)) throw new Error("检测到外部的新内容，已停止写入");
	};
	try {
		let written = 0;
		while (written < bytes.length) {
			check();
			stage = { kind: "write", before: expected, position: written, source: bytes };
			const count = io.write(fd, bytes, written, bytes.length - written, written);
			if (!Number.isInteger(count) || count <= 0 || count > bytes.length - written)
				throw new Error("文件写入未完成");
			expected = writtenBytes(expected, bytes, written, count);
			written += count;
			stage = undefined;
		}
		check();
		stage = { kind: "truncate", before: expected, length: bytes.length };
		io.truncate(fd, bytes.length);
		expected = truncatedBytes(expected, bytes.length);
		stage = undefined;
		check();
		stage = { kind: "sync", before: expected };
		io.sync(fd);
		stage = undefined;
		check();
	} catch (error) {
		let ownBytes: Buffer | undefined;
		try {
			const actual = descriptorBytes(fd);
			if (matchesOwnFailure(stage, expected, actual)) ownBytes = actual;
		} catch {
			/* Uncertain external state must not be overwritten. */
		}
		throw new EditorMutationFailure(error, ownBytes);
	}
}

function removeBackup(path: string): boolean {
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

function durableBackup(path: string, bytes: Uint8Array): void {
	const fd = openSync(path, "wx", 0o600);
	let failure: unknown;
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
		const info = fstatSync(fd);
		const atPath = lstatSync(path);
		if (info.nlink !== 1 || atPath.isSymbolicLink() || inode(info) !== inode(atPath)) throw new Error("备份身份变化");
	} catch (error) {
		failure = error;
	} finally {
		try {
			closeSync(fd);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure) {
		const removed = removeBackup(path);
		throw new Error(`原文备份失败，未执行写入：${message(failure)}${removed ? "" : `；未完成备份：${path}`}`);
	}
}

export async function saveEditorFile(
	cwd: string,
	absolute: string,
	content: string,
	expectedRevision: string | null,
	assertProfile: () => void,
	mutationIO: Partial<EditorMutationIO> = {},
): Promise<FsWriteResult> {
	if (expectedRevision !== null && typeof expectedRevision !== "string")
		throw new Error("保存必须携带已读取的文件版本");
	if (!validEditorText(content)) throw new Error("只允许保存读取上限内的完整有效 UTF-8 文本");
	assertProfile();
	const io: EditorMutationIO = {
		write: mutationIO.write ?? writeSync,
		truncate: mutationIO.truncate ?? ftruncateSync,
		sync: mutationIO.sync ?? fsyncSync,
	};
	return withFileMutationQueue(absolute, async () => {
		assertProfile();
		const guarded = guardedPath(cwd, absolute);
		if (guarded.readOnlyReason) return { status: "conflict", reason: guarded.readOnlyReason };
		return withFileLockSync(guarded.path, () => {
			assertProfile();
			let current: ReturnType<typeof readState> | undefined;
			try {
				current = readState(cwd, absolute);
			} catch (error) {
				if (!missing(error)) throw error;
			}
			if (
				expectedRevision === null
					? current !== undefined
					: !current || current.result.revision !== expectedRevision || !current.result.editable
			) {
				return {
					status: "conflict",
					reason:
						current?.result.readOnlyReason ??
						(current ? "文件已被其他操作修改，请比较当前版本" : "文件已删除或移动"),
					...(current ? { current: current.result } : {}),
				};
			}
			const output = Buffer.from(content, "utf8");
			const warnings: string[] = [];
			if (!current) {
				mkdirSync(dirname(guarded.path), { recursive: true });
				if (guardedPath(cwd, absolute).readOnlyReason) throw new Error("创建前路径已变为链接");
				assertProfile();
				let fd: number;
				try {
					fd = openSync(guarded.path, "wx+", 0o666);
				} catch (error) {
					if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
						return {
							status: "conflict",
							reason: "目标文件已存在，未覆盖",
							current: readEditorFile(cwd, absolute),
						};
					throw error;
				}
				try {
					writeAll(io, fd, output, Buffer.alloc(0), () => {
						if (
							guardedPath(cwd, absolute).readOnlyReason ||
							inode(lstatSync(guarded.path)) !== inode(fstatSync(fd))
						)
							throw new Error("新文件身份已变化");
					});
				} catch (error) {
					try {
						const live = lstatSync(guarded.path);
						if (
							!guardedPath(cwd, absolute).readOnlyReason &&
							!live.isSymbolicLink() &&
							live.nlink === 1 &&
							inode(fstatSync(fd)) === inode(live) &&
							error instanceof EditorMutationFailure &&
							error.ownBytes?.equals(descriptorBytes(fd))
						)
							unlinkSync(guarded.path);
					} catch {
						/* Preserve any external replacement or unverified partial file. */
					}
					throw new Error(`新文件保存失败，草稿仍需保留：${message(error)}`);
				} finally {
					closeSync(fd);
				}
			} else {
				const fd = openSync(guarded.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
				try {
					if (
						inode(fstatSync(fd)) !== current.inode ||
						readState(cwd, absolute).result.revision !== expectedRevision
					)
						return { status: "conflict", reason: "确认保存时文件已变化", current: readEditorFile(cwd, absolute) };
					const backup = `${guarded.path}.owl-editor-backup-${randomUUID()}`;
					durableBackup(backup, current.bytes);
					try {
						assertProfile();
						if (readState(cwd, absolute).result.revision !== expectedRevision) {
							const removed = removeBackup(backup);
							return {
								status: "conflict",
								reason: `保存前文件已变化${removed ? "" : `；原文备份：${backup}`}`,
								current: readEditorFile(cwd, absolute),
							};
						}
					} catch (error) {
						const removed = removeBackup(backup);
						throw new Error(`${message(error)}${removed ? "" : `；原文备份：${backup}`}`);
					}
					const assertIdentity = (): void => {
						const atPath = lstatSync(guarded.path);
						if (
							guardedPath(cwd, absolute).readOnlyReason ||
							atPath.isSymbolicLink() ||
							inode(atPath) !== inode(fstatSync(fd)) ||
							atPath.nlink !== 1
						)
							throw new Error("文件身份变化，未回写其他文件");
					};
					try {
						writeAll(io, fd, output, current.bytes, assertIdentity);
					} catch (error) {
						try {
							assertIdentity();
							if (
								!(error instanceof EditorMutationFailure) ||
								!error.ownBytes ||
								!descriptorBytes(fd).equals(error.ownBytes)
							)
								throw new Error("文件包含外部后续修改，已保留当前内容，未自动回写");
							writeAll(io, fd, current.bytes, error.ownBytes, assertIdentity);
							const restored = readState(cwd, absolute);
							if (restored.inode !== current.inode || !restored.bytes.equals(current.bytes))
								throw new Error("原文恢复未能核对");
						} catch (restoreError) {
							throw new Error(
								`保存失败：${message(error)}；自动恢复失败：${message(restoreError)}；原文备份：${backup}`,
							);
						}
						const removed = removeBackup(backup);
						throw new Error(`保存失败：${message(error)}；已恢复原文${removed ? "" : `；原文备份：${backup}`}`);
					}
					if (!removeBackup(backup)) warnings.push(`已保存，原文备份尚未清理：${backup}`);
				} finally {
					closeSync(fd);
				}
			}
			const saved = readEditorFile(cwd, absolute);
			if (!saved.editable || !saved.revision || saved.content !== content)
				return { status: "conflict", reason: "保存后文件又被其他操作修改，请保留草稿并比较", current: saved };
			return {
				status: "saved",
				path: relative(resolve(cwd), resolve(absolute)).split(sep).join("/"),
				size: output.length,
				revision: saved.revision,
				...(warnings.length ? { warnings } : {}),
			};
		});
	});
}
