/**
 * Persist each successful write/edit separately. Undo reverses only selected operations,
 * three-way merges against the current file, and requires an unchanged preview revision.
 * Old records without an after image are visible but cannot overwrite the working tree.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as Diff from "diff";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";
import { splitBom } from "../../utils/text.ts";
import {
	applyEditsToNormalizedContent,
	type Edit,
	generateUnifiedPatch,
	normalizeToLF,
	restoreMixedLineEndings,
} from "../tools/edit-diff.ts";
import { withFileMutationQueue } from "../tools/file-mutation-queue.ts";

export type DiffApprovalStatus = "pending" | "kept" | "reverted";
export type DiffApprovalUndoMode = "operations" | "baseline";

export interface DiffApprovalScope {
	sessionId?: string;
	toolCallIds?: string[];
}

export interface DiffApprovalCapture {
	sessionId: string;
	turnId: string;
	toolName: "write" | "edit";
	input: unknown;
}

export interface DiffApprovalEntry {
	id: string;
	path: string;
	status: DiffApprovalStatus;
	originalExisted: boolean;
	originalContent: string | null;
	baselineAt: string;
	resolvedAt: string | null;
	afterContent?: string | null;
	toolCallId?: string;
	sessionId?: string;
	turnId?: string;
	/** An operation's order is independent of timestamp resolution and caller-selected ID order. */
	sequence?: number;
	captureError?: string;
	/** Hidden from the completed list but retained while earlier pending operations depend on it. */
	hidden?: boolean;
}

export interface DiffApprovalFileSummary {
	id: string;
	path: string;
	displayPath: string;
	status: DiffApprovalStatus;
	originalExisted: boolean;
	currentExists: boolean;
	added: number | null;
	removed: number | null;
	size: number;
	baselineAt: string;
	resolvedAt: string | null;
	toolCallId?: string;
	sessionId?: string;
	turnId?: string;
	scope?: "operation" | "legacy";
	revertible?: boolean;
	revertReason?: string;
}

export interface DiffApprovalPreviewFile {
	path: string;
	displayPath: string;
	entryIds: string[];
	canRevert: boolean;
	reason?: string;
	diff: string;
	truncated: boolean;
	currentExists: boolean;
	targetExists: boolean;
}

export interface DiffApprovalPreviewResult {
	token: string;
	mode: DiffApprovalUndoMode;
	files: DiffApprovalPreviewFile[];
	expiresAt: string;
}

export interface DiffApprovalResolveResult {
	resolved: number;
	resolvedIds: string[];
	failed: Array<{ path: string; reason: string }>;
	warnings?: Array<{ path: string; reason: string }>;
}

/** Small filesystem seam used to verify partial-write recovery without touching real data. */
export interface DiffApprovalMutationIO {
	write(fd: number, bytes: Uint8Array, offset: number, length: number, position: number): number;
	truncate(fd: number, size: number): void;
	sync(fd: number): void;
}

const PERSIST_VERSION = 2;
export const DIFF_APPROVAL_DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DIFF_TEXT_CAP_CHARS = 512 * 1024;
const DIFF_OUTPUT_CAP_CHARS = 400 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;

export function diffApprovalPathKey(p: string): string {
	const normalized = resolve(p);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface FileSnapshot {
	exists: boolean;
	content: string;
	revision: string;
	identity?: string;
}

interface StagedCapture {
	toolCallId: string;
	path: string;
	existed: boolean;
	content: string;
	expected?: string;
	metadata?: DiffApprovalCapture;
	error?: string;
	identity?: string;
	mutationRecorded?: boolean;
}

interface PreviewPlan {
	result: DiffApprovalPreviewFile;
	snapshot?: FileSnapshot;
	target?: string;
	entryRevision: string;
}

interface StoredPreview {
	entryIds: string[];
	expires: number;
	plans: PreviewPlan[];
}

interface PersistShape {
	version: number;
	workspaceDir: string;
	entries: DiffApprovalEntry[];
}

export class DiffApprovalStore {
	private readonly filePath: string;
	private readonly workspaceDir: string;
	private readonly maxFileBytes: number;
	private readonly mutationIO: DiffApprovalMutationIO;
	onChanged: (() => void) | undefined;
	private entries: DiffApprovalEntry[] = [];
	private staging = new Map<string, StagedCapture>();
	private previews = new Map<string, StoredPreview>();
	private loaded = false;
	private sequence = 0;

	constructor(options: {
		filePath: string;
		workspaceDir: string;
		maxFileBytes?: number;
		mutationIO?: Partial<DiffApprovalMutationIO>;
	}) {
		this.filePath = options.filePath;
		this.workspaceDir = resolve(options.workspaceDir);
		this.maxFileBytes = options.maxFileBytes ?? DIFF_APPROVAL_DEFAULT_MAX_FILE_BYTES;
		this.mutationIO = {
			write: options.mutationIO?.write ?? writeSync,
			truncate: options.mutationIO?.truncate ?? ftruncateSync,
			sync: options.mutationIO?.sync ?? fsyncSync,
		};
	}

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.filePath)) return;
		try {
			this.refreshEntries();
		} catch {
			backupCorruptFile(this.filePath);
		}
	}

	stage(toolCallId: string, absolutePath: string, metadata?: DiffApprovalCapture): void {
		const staged: StagedCapture = { toolCallId, path: resolve(absolutePath), existed: false, content: "", metadata };
		try {
			const before = this.snapshot(staged.path);
			staged.existed = before.exists;
			staged.content = before.content;
			staged.identity = before.identity;
			if (!metadata?.sessionId || !metadata.turnId) throw new Error("缺少会话或轮次归属，不能安全撤销");
			const input = metadata.input as { content?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown };
			if (metadata.toolName === "write") {
				if (typeof input?.content !== "string") throw new Error("缺少可核对的写入内容");
				staged.expected = input.content;
			} else {
				if (!before.exists) throw new Error("编辑前文件不存在");
				const edits: Edit[] = [];
				if (Array.isArray(input?.edits)) {
					for (const item of input.edits as unknown[]) {
						if (!item || typeof item !== "object" || !("oldText" in item) || !("newText" in item)) {
							throw new Error("编辑参数无法核对");
						}
						if (typeof item.oldText !== "string" || typeof item.newText !== "string") {
							throw new Error("编辑参数无法核对");
						}
						edits.push({ oldText: item.oldText, newText: item.newText });
					}
				} else if (typeof input?.oldText === "string" && typeof input.newText === "string") {
					edits.push({ oldText: input.oldText, newText: input.newText });
				}
				if (!edits.length) throw new Error("编辑参数无法核对");
				const { bom, text } = splitBom(before.content);
				const { newContent } = applyEditsToNormalizedContent(normalizeToLF(text), edits, staged.path);
				staged.expected = bom + restoreMixedLineEndings(text, newContent);
			}
			if (Buffer.byteLength(staged.expected, "utf8") > this.maxFileBytes || staged.expected.includes("\0")) {
				throw new Error("写入内容过大或为二进制，不能安全撤销");
			}
		} catch (error) {
			staged.error = errorText(error);
		}
		this.staging.set(`${metadata?.sessionId ?? ""}:${toolCallId}`, staged);
	}

	/** The real local tool calls this inside its mutation queue immediately before writing. */
	stagedMutationKeys(toolCallId: string, path: string, sessionId?: string): string[] {
		return [...this.staging.entries()]
			.filter(
				([, item]) =>
					item.toolCallId === toolCallId &&
					diffApprovalPathKey(item.path) === diffApprovalPathKey(path) &&
					(sessionId === undefined || item.metadata?.sessionId === sessionId),
			)
			.map(([key]) => key);
	}

	recordMutationBefore(key: string, expectedAfter: string, sourceContent?: string): void {
		const staged = this.staging.get(key);
		if (!staged) return;
		staged.mutationRecorded = false;
		try {
			const before = this.snapshot(staged.path);
			if (sourceContent !== undefined && (!before.exists || sourceContent !== before.content)) {
				throw new Error("读取后文件已被其他操作修改，已停止写入；请重新读取后再编辑");
			}
			if (!staged.metadata?.sessionId || !staged.metadata.turnId) throw new Error("缺少会话或轮次归属");
			if (expectedAfter.includes("\0") || Buffer.byteLength(expectedAfter, "utf8") > this.maxFileBytes) {
				throw new Error("写入内容过大或为二进制，不能安全撤销");
			}
			staged.content = before.content;
			staged.existed = before.exists;
			staged.identity = before.identity;
			staged.expected = expectedAfter;
			staged.error = undefined;
			staged.mutationRecorded = true;
		} catch (error) {
			staged.error = errorText(error);
			// Editing a file changed after it was read must not erase the intervening work.
			if (sourceContent !== undefined && staged.error.includes("已停止写入")) throw error;
		}
	}

	rejectStagedMutation(key: string): void {
		const staged = this.staging.get(key);
		if (staged) {
			staged.error = "工具调用归属不唯一，不能安全撤销；请人工核对";
			staged.mutationRecorded = false;
		}
	}

	commit(toolCallId: string, isError: boolean, sessionId = ""): void {
		const key = `${sessionId}:${toolCallId}`;
		const staged = this.staging.get(key);
		this.staging.delete(key);
		if (!staged || isError) return;
		let afterContent: string | null = null;
		let captureError = staged.error;
		if (!captureError && !staged.mutationRecorded) captureError = "没有工具写入时的准确快照，不能安全撤销";
		if (!captureError) {
			try {
				const after = this.snapshot(staged.path);
				if (
					!after.exists ||
					after.content !== staged.expected ||
					(staged.existed && after.identity !== staged.identity)
				) {
					throw new Error("执行期间文件已变化，无法确认本次编辑的改后内容；请人工核对");
				}
				afterContent = after.content;
			} catch (error) {
				captureError = errorText(error);
			}
		}
		if (!captureError && staged.existed && staged.content === afterContent) return;
		withFileLockSync(this.filePath, () => {
			this.refreshEntries();
			this.entries.unshift({
				id: randomUUID(),
				path: staged.path,
				status: "pending",
				originalExisted: staged.existed,
				originalContent: staged.content,
				afterContent,
				toolCallId,
				sessionId: staged.metadata?.sessionId,
				turnId: staged.metadata?.turnId,
				sequence: ++this.sequence,
				captureError,
				baselineAt: new Date().toISOString(),
				resolvedAt: null,
			});
			this.persist();
		});
		this.onChanged?.();
	}

	list(cwd: string, scope?: DiffApprovalScope): DiffApprovalFileSummary[] {
		this.refreshEntries();
		return this.entries
			.filter((entry) => {
				if (entry.hidden) return false;
				if (scope?.sessionId !== undefined && entry.sessionId !== scope.sessionId) return false;
				if (scope?.toolCallIds !== undefined) {
					return scope.toolCallIds.some((id) => entry.toolCallId === id || entry.toolCallId?.startsWith(`${id}/`));
				}
				return true;
			})
			.map((entry) => this.summarize(entry, cwd))
			.sort((a, b) => {
				if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
				return (b.resolvedAt ?? b.baselineAt).localeCompare(a.resolvedAt ?? a.baselineAt);
			});
	}

	/** This diff describes the captured operation only, never unrelated later changes. */
	diff(entryId: string): { diff: string; truncated: boolean } {
		this.refreshEntries();
		const entry = this.entries.find((item) => item.id === entryId);
		if (!entry) throw new Error(`Unknown diff-approval entry: ${entryId}`);
		if (entry.status !== "pending") throw new Error("该条目已处理");
		const before = entry.originalExisted ? entry.originalContent : "";
		if (before === null) throw new Error("缺少改前内容");
		if (typeof entry.afterContent !== "string") throw new Error("旧记录缺少改后快照，请人工核对");
		return patchOf(entry.path, before, entry.afterContent);
	}

	preview(entryIds: string[], mode: DiffApprovalUndoMode = "operations"): DiffApprovalPreviewResult {
		this.refreshEntries();
		if (mode !== "operations" && mode !== "baseline") throw new Error("未知撤销范围");
		const uniqueIds = [...new Set(entryIds)];
		if (!uniqueIds.length) throw new Error("请选择需要撤销的改动");
		const groups = new Map<string, { path: string; ids: string[] }>();
		for (const id of uniqueIds) {
			const entry = this.entries.find((item) => item.id === id);
			const path = entry?.path ?? id;
			const key = entry ? diffApprovalPathKey(path) : `missing:${id}`;
			let group = groups.get(key);
			if (!group) {
				group = { path, ids: [] };
				groups.set(key, group);
			}
			group.ids.push(id);
		}
		const plans = [...groups.values()].map(({ path, ids }) => this.plan(path, ids));
		const token = randomUUID();
		const expires = Date.now() + PREVIEW_TTL_MS;
		for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key);
		// A stale dialog never retains unbounded full-file snapshots.
		if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value ?? "");
		this.previews.set(token, { entryIds: uniqueIds.sort(), expires, plans });
		return { token, mode, files: plans.map((item) => item.result), expiresAt: new Date(expires).toISOString() };
	}

	async resolve(
		entryIds: string[],
		action: "keep" | "revert",
		previewToken?: string,
	): Promise<DiffApprovalResolveResult> {
		const result: DiffApprovalResolveResult = { resolved: 0, resolvedIds: [], failed: [] };
		const uniqueIds = [...new Set(entryIds)].sort();
		if (action === "keep") {
			withFileLockSync(this.filePath, () => {
				this.refreshEntries();
				for (const id of uniqueIds) {
					const entry = this.entries.find((item) => item.id === id);
					if (!entry || entry.status === "reverted") {
						result.failed.push({ path: entry?.path ?? id, reason: "不是待保留条目" });
						continue;
					}
					if (entry.status === "pending") this.markResolved(entry, "kept");
					result.resolvedIds.push(id);
				}
				this.pruneResolvedSnapshots();
				if (result.resolvedIds.length) this.persist();
			});
		} else if (action === "revert") {
			const preview = previewToken ? this.previews.get(previewToken) : undefined;
			if (
				!preview ||
				preview.expires < Date.now() ||
				JSON.stringify(preview.entryIds) !== JSON.stringify(uniqueIds)
			) {
				return {
					...result,
					failed: uniqueIds.map((id) => ({
						path: this.entries.find((entry) => entry.id === id)?.path ?? id,
						reason: "撤销预览已失效，请重新预览后确认",
					})),
				};
			}
			for (const plan of preview.plans) {
				try {
					if (!plan.result.canRevert || !plan.snapshot || plan.target === undefined) {
						throw new Error(plan.result.reason ?? "没有可安全撤销的内容");
					}
					await withFileMutationQueue(plan.result.path, async () => {
						withFileLockSync(this.filePath, () => {
							this.refreshEntries();
							const selected = plan.result.entryIds.map((id) => this.entries.find((entry) => entry.id === id));
							if (selected.every((entry) => entry?.status === "reverted")) return;
							if (this.pathRevision(plan.result.path) !== plan.entryRevision)
								throw new Error("条目已变化，请重新预览");
							const current = this.snapshot(plan.result.path);
							if (current.revision !== plan.snapshot?.revision) throw new Error("预览后文件已变化，请重新预览");
							if (!current.exists) throw new Error("文件已被删除，不会自动重建");
							const warning = this.applyPlan(plan, current);
							if (warning) {
								result.warnings ??= [];
								result.warnings.push({ path: plan.result.path, reason: warning });
							}
							for (const entry of selected) if (entry) this.markResolved(entry, "reverted");
							this.pruneResolvedSnapshots();
							this.persist();
						});
					});
					result.resolvedIds.push(...plan.result.entryIds);
				} catch (error) {
					result.failed.push({ path: plan.result.path, reason: errorText(error) });
				}
			}
		} else {
			throw new Error("未知改动处理动作");
		}
		result.resolved = result.resolvedIds.length;
		if (result.resolved > 0) {
			this.onChanged?.();
		}
		return result;
	}

	clearResolved(): number {
		const removed = withFileLockSync(this.filePath, () => {
			this.refreshEntries();
			let count = 0;
			for (const entry of this.entries) {
				if (entry.status !== "pending" && !entry.hidden) {
					entry.hidden = true;
					count++;
				}
			}
			this.pruneResolvedSnapshots();
			if (count > 0) this.persist();
			return count;
		});
		if (removed > 0) this.onChanged?.();
		return removed;
	}

	private plan(path: string, ids: string[]): PreviewPlan {
		const selected = ids.map((id) => this.entries.find((entry) => entry.id === id));
		const plan: PreviewPlan = {
			result: {
				path,
				displayPath: displayPathOf(path, this.workspaceDir),
				entryIds: ids,
				canRevert: false,
				diff: "",
				truncated: false,
				currentExists: false,
				targetExists: true,
			},
			entryRevision: this.pathRevision(path),
		};
		try {
			const operations: DiffApprovalEntry[] = [];
			for (const entry of selected) {
				if (!entry || entry.status !== "pending") throw new Error("所选改动已处理或不存在");
				const reason = captureReason(entry);
				if (reason) throw new Error(reason);
				operations.push(entry);
			}
			const current = this.snapshot(path);
			plan.snapshot = current;
			plan.result.currentExists = current.exists;
			if (!current.exists) throw new Error("文件已被删除，不会自动重建；请人工核对");
			let target = current.content;
			for (const entry of operations.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))) {
				const after = entry.afterContent;
				const before = entry.originalContent;
				if (typeof after !== "string" || before === null) throw new Error("缺少撤销快照");
				if (!entry.originalExisted) {
					if (
						this.entries.some(
							(later) =>
								!ids.includes(later.id) &&
								later.status !== "reverted" &&
								diffApprovalPathKey(later.path) === diffApprovalPathKey(path) &&
								(later.sequence ?? 0) > (entry.sequence ?? 0),
						)
					)
						throw new Error("新建文件存在未选中的后续操作，不能删除");
					if (target !== after) throw new Error("新建文件存在后续修改或手改，不能删除");
					plan.result.targetExists = false;
					target = "";
				} else {
					for (const later of this.entries) {
						if (
							ids.includes(later.id) ||
							later.status === "reverted" ||
							diffApprovalPathKey(later.path) !== diffApprovalPathKey(path) ||
							(later.sequence ?? 0) <= (entry.sequence ?? 0)
						)
							continue;
						if (later.originalContent === null || typeof later.afterContent !== "string" || later.captureError) {
							throw new Error("后续操作缺少可核对的快照，不能证明撤销不会影响它；请人工核对");
						}
						const beforeLater = reverseMerge(after, before, later.originalContent);
						reverseMerge(later.originalContent, beforeLater, later.afterContent);
					}
					target = reverseMerge(after, before, target);
				}
			}
			plan.target = target;
			plan.result.canRevert = true;
			Object.assign(plan.result, patchOf(path, current.content, target));
		} catch (error) {
			plan.result.reason = errorText(error);
		}
		return plan;
	}

	private snapshot(path: string): FileSnapshot {
		const resolvedPath = resolve(path);
		const within = relative(this.workspaceDir, resolvedPath);
		if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
			throw new Error("文件不在当前工作区内，不能安全撤销");
		}
		// Reject links in every traversed component, including a replaced workspace root.
		let cursor = resolvedPath;
		while (true) {
			try {
				const info = lstatSync(cursor);
				if (info.isSymbolicLink()) throw new Error("路径含符号链接或目录联接，不能安全撤销");
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			if (diffApprovalPathKey(cursor) === diffApprovalPathKey(this.workspaceDir)) break;
			const parent = dirname(cursor);
			if (parent === cursor) throw new Error("路径不在当前工作区内");
			cursor = parent;
		}
		try {
			const info = lstatSync(resolvedPath);
			if (!info.isFile() || info.nlink > 1) throw new Error("目标不是普通独立文件，不能安全撤销");
			if (info.size > this.maxFileBytes) throw new Error("文件过大，不能安全撤销");
			const bytes = readFileSync(resolvedPath);
			const content = bytes.toString("utf8");
			if (content.includes("\0") || !Buffer.from(content, "utf8").equals(bytes)) {
				throw new Error("文件为二进制或非 UTF-8 内容，不能安全撤销");
			}
			const after = lstatSync(resolvedPath);
			const identity = [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs, info.birthtimeMs];
			const identityAfter = [
				after.dev,
				after.ino,
				after.mode,
				after.size,
				after.mtimeMs,
				after.ctimeMs,
				after.birthtimeMs,
			];
			if (JSON.stringify(identity) !== JSON.stringify(identityAfter)) throw new Error("读取期间文件已变化，请重试");
			return {
				exists: true,
				content,
				revision: hash(JSON.stringify(identity) + hash(content)),
				identity: hash(JSON.stringify([info.dev, info.ino, info.birthtimeMs])),
			};
		} catch (error) {
			if (!isMissing(error)) throw error;
			return { exists: false, content: "", revision: "missing" };
		}
	}

	private applyPlan(plan: PreviewPlan, current: FileSnapshot): string | undefined {
		const path = plan.result.path;
		let warning: string | undefined;
		// Open the existing inode without truncation. Never create a deleted path or follow a link.
		const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = fstatSync(fd);
			const pathInfo = lstatSync(path);
			if (!info.isFile() || info.nlink > 1 || info.ino !== pathInfo.ino || info.dev !== pathInfo.dev) {
				throw new Error("文件身份已变化，请重新预览");
			}
			const bytes = readFileSync(fd);
			if (!bytes.equals(Buffer.from(current.content, "utf8")) || this.snapshot(path).revision !== current.revision) {
				throw new Error("确认期间文件已变化，请重新预览");
			}
			if (plan.result.targetExists) {
				const output = Buffer.from(plan.target ?? "", "utf8");
				const backupPath = `${path}.owl-undo-backup-${randomUUID()}`;
				// Keep the original inode/ACL. A private, durable copy must exist before any overwrite.
				this.writeRecoveryBackup(backupPath, bytes);
				try {
					if (this.snapshot(path).revision !== current.revision) throw new Error("文件内容或身份已变化");
				} catch (error) {
					const retained = this.removeRecoveryBackup(backupPath);
					throw new Error(
						`写入前核对失败，未执行写入：${errorText(error)}；请重新预览${retained ? `；原文备份：${backupPath}` : ""}`,
					);
				}
				try {
					this.writeMutationBytes(fd, output);
				} catch (writeError) {
					try {
						const failedInfo = fstatSync(fd);
						const failedPathInfo = lstatSync(path);
						if (
							failedPathInfo.isSymbolicLink() ||
							failedInfo.ino !== failedPathInfo.ino ||
							failedInfo.dev !== failedPathInfo.dev ||
							failedInfo.nlink > 1
						) {
							throw new Error("原文件路径或身份已变化，不能自动回写");
						}
						this.writeMutationBytes(fd, bytes);
						const restored = this.snapshot(path);
						if (
							!restored.exists ||
							restored.content !== current.content ||
							restored.identity !== current.identity
						) {
							throw new Error("回写结果与原文不一致");
						}
					} catch (restoreError) {
						throw new Error(
							`撤销写入失败：${errorText(writeError)}；自动恢复失败：${errorText(restoreError)}；原文备份：${backupPath}`,
						);
					}
					const retained = this.removeRecoveryBackup(backupPath);
					throw new Error(
						`撤销写入失败：${errorText(writeError)}；已恢复原文${retained ? `；原文备份：${backupPath}` : ""}`,
					);
				}
				if (this.removeRecoveryBackup(backupPath)) {
					warning = `改动已撤销，原文备份暂未清理：${backupPath}`;
				}
			}
		} finally {
			closeSync(fd);
		}
		if (!plan.result.targetExists) {
			if (this.snapshot(path).revision !== current.revision) throw new Error("删除前文件已变化，请重新预览");
			unlinkSync(path);
		}
		return warning;
	}

	private writeMutationBytes(fd: number, bytes: Uint8Array): void {
		let written = 0;
		while (written < bytes.length) {
			const count = this.mutationIO.write(fd, bytes, written, bytes.length - written, written);
			if (count === 0) throw new Error("写入未完成");
			written += count;
		}
		this.mutationIO.truncate(fd, bytes.length);
		this.mutationIO.sync(fd);
	}

	private writeRecoveryBackup(path: string, bytes: Uint8Array): void {
		let fd: number | undefined;
		let failure: unknown;
		try {
			fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, bytes);
			fsyncSync(fd);
			const info = fstatSync(fd);
			const atPath = lstatSync(path);
			if (
				!info.isFile() ||
				info.nlink !== 1 ||
				atPath.isSymbolicLink() ||
				info.ino !== atPath.ino ||
				info.dev !== atPath.dev
			) {
				throw new Error("原文备份不是独立普通文件");
			}
		} catch (error) {
			failure = error;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch (error) {
					failure ??= error;
				}
			}
		}
		if (failure) {
			const retained = fd !== undefined && this.removeRecoveryBackup(path);
			throw new Error(
				`撤销前原文备份失败，未执行写入：${errorText(failure)}${retained ? `；未完成备份残留：${path}` : ""}`,
			);
		}
	}

	/** Returns true when a recoverable backup remains at the reported path. */
	private removeRecoveryBackup(path: string): boolean {
		try {
			unlinkSync(path);
			return false;
		} catch {
			return true;
		}
	}

	private markResolved(entry: DiffApprovalEntry, status: "kept" | "reverted"): void {
		entry.status = status;
		entry.resolvedAt = new Date().toISOString();
	}

	private pruneResolvedSnapshots(): void {
		for (const entry of this.entries) {
			if (entry.status === "pending") continue;
			const earlierPending =
				entry.status === "kept" &&
				this.entries.some(
					(earlier) =>
						earlier.status === "pending" &&
						diffApprovalPathKey(earlier.path) === diffApprovalPathKey(entry.path) &&
						(earlier.sequence ?? 0) < (entry.sequence ?? 0),
				);
			if (!earlierPending) {
				entry.originalContent = null;
				entry.afterContent = null;
			}
		}
	}

	private pathRevision(path: string): string {
		return hash(
			JSON.stringify(this.entries.filter((entry) => diffApprovalPathKey(entry.path) === diffApprovalPathKey(path))),
		);
	}

	private refreshEntries(): void {
		if (!existsSync(this.filePath)) {
			this.entries = [];
			this.sequence = 0;
			return;
		}
		const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistShape;
		if ((parsed.version !== 1 && parsed.version !== PERSIST_VERSION) || !Array.isArray(parsed.entries)) {
			throw new Error("改动记录格式不可识别，已停止处理以保留原始记录");
		}
		this.entries = parsed.entries;
		this.sequence = this.entries.reduce((max, entry) => Math.max(max, entry.sequence ?? 0), 0);
	}

	private summarize(entry: DiffApprovalEntry, cwd: string): DiffApprovalFileSummary {
		let currentExists = false;
		let size = 0;
		try {
			const info = lstatSync(entry.path);
			currentExists = info.isFile();
			size = info.size;
		} catch {
			/* A missing or unreadable file still has a visible operation record. */
		}
		let added: number | null = null;
		let removed: number | null = null;
		if (entry.originalContent !== null && typeof entry.afterContent === "string") {
			if (entry.originalContent.length + entry.afterContent.length <= DIFF_TEXT_CAP_CHARS) {
				added = 0;
				removed = 0;
				const changes = Diff.diffLines(entry.originalContent, entry.afterContent, { timeout: 100 });
				if (changes) {
					for (const part of changes) {
						if (part.added) added += countChunkLines(part.value);
						if (part.removed) removed += countChunkLines(part.value);
					}
				} else {
					added = null;
					removed = null;
				}
			}
		}
		const reason = captureReason(entry);
		return {
			id: entry.id,
			path: entry.path,
			displayPath: displayPathOf(entry.path, cwd),
			status: entry.status,
			originalExisted: entry.originalExisted,
			currentExists,
			added,
			removed,
			size,
			baselineAt: entry.baselineAt,
			resolvedAt: entry.resolvedAt,
			toolCallId: entry.toolCallId,
			sessionId: entry.sessionId,
			turnId: entry.turnId,
			scope: entry.sessionId && entry.toolCallId ? "operation" : "legacy",
			revertible: entry.status === "pending" && !reason,
			revertReason: reason,
		};
	}

	private persist(): void {
		const payload: PersistShape = {
			version: PERSIST_VERSION,
			workspaceDir: this.workspaceDir,
			entries: this.entries,
		};
		atomicWriteFileSync(this.filePath, JSON.stringify(payload));
	}
}

interface TextChange {
	start: number;
	end: number;
	text: string;
}

function lineChanges(base: string, target: string): TextChange[] {
	const parts = Diff.diffLines(base, target, { timeout: 200, maxEditLength: 10000 });
	if (!parts) throw new Error("差异过大，无法可靠合并，请人工核对");
	const result: TextChange[] = [];
	let offset = 0;
	let pending: TextChange | undefined;
	for (const part of parts) {
		if (part.added || part.removed) {
			pending ??= { start: offset, end: offset, text: "" };
			if (part.removed) {
				offset += part.value.length;
				pending.end = offset;
			} else pending.text += part.value;
		} else {
			if (pending) result.push(pending);
			pending = undefined;
			offset += part.value.length;
		}
	}
	if (pending) result.push(pending);
	return result;
}

/** Conservative line-based diff3: shared lines and ambiguous repeated blocks fail closed. */
function reverseMerge(after: string, before: string, current: string): string {
	if (after === current) return before;
	if (Math.max(after.length, before.length, current.length) > DIFF_TEXT_CAP_CHARS) {
		throw new Error("文件存在后续修改且内容过大，请人工核对");
	}
	const undo = lineChanges(after, before);
	const external = lineChanges(after, current);
	for (const change of undo) {
		for (const later of external) {
			const overlap =
				change.start === change.end || later.start === later.end
					? change.start <= later.end && later.start <= change.end
					: change.start < later.end && later.start < change.end;
			if (overlap) throw new Error("所选改动与后续修改或手改重叠，已保留当前文件；请人工核对");
		}
		// Duplicate changed blocks have more than one plausible alignment. Do not guess.
		const affected = after.slice(change.start, change.end);
		const anchorStart = change.start > 0 ? after.lastIndexOf("\n", change.start - 2) + 1 : 0;
		const nextNewline = after.indexOf("\n", change.start);
		const anchorEnd = nextNewline < 0 ? after.length : nextNewline + 1;
		const anchor = affected || after.slice(anchorStart, anchorEnd);
		if (anchor && after.indexOf(anchor) !== after.lastIndexOf(anchor)) {
			throw new Error("重复内容导致撤销位置不确定，已保留当前文件；请人工核对");
		}
	}
	let output = after;
	for (const change of [...undo, ...external].sort((a, b) => b.start - a.start)) {
		output = output.slice(0, change.start) + change.text + output.slice(change.end);
	}
	return output;
}

function captureReason(entry: DiffApprovalEntry): string | undefined {
	if (entry.captureError) return entry.captureError;
	if (!entry.sessionId || !entry.toolCallId || !entry.turnId || entry.sequence === undefined) {
		return "旧记录缺少会话和轮次归属，只能人工核对或保留，不能自动撤销";
	}
	if (typeof entry.afterContent !== "string" || entry.originalContent === null) {
		return "缺少完整改前和改后快照，不能自动撤销";
	}
	return undefined;
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function patchOf(path: string, before: string, after: string): { diff: string; truncated: boolean } {
	let patch = `diff --git a/${path} b/${path}\n${generateUnifiedPatch(path, before, after, 4)}`;
	if (patch.length <= DIFF_OUTPUT_CAP_CHARS) return { diff: patch, truncated: false };
	const cut = patch.lastIndexOf("\n", DIFF_OUTPUT_CAP_CHARS);
	patch = patch.slice(0, cut > 0 ? cut : DIFF_OUTPUT_CAP_CHARS);
	return { diff: patch, truncated: true };
}

function countChunkLines(text: string): number {
	return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function displayPathOf(absolutePath: string, cwd: string): string {
	const path = relative(cwd, absolutePath);
	return path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
		? path.replace(/\\/g, "/")
		: absolutePath;
}

export function diffApprovalStoreFileName(cwd: string): string {
	return `${createHash("sha1").update(diffApprovalPathKey(cwd)).digest("hex").slice(0, 16)}.json`;
}

export function diffApprovalStorePath(agentDir: string, cwd: string): string {
	return join(agentDir, "diff-approval", "workspaces", diffApprovalStoreFileName(cwd));
}
