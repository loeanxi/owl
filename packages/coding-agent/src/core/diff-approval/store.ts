/**
 * 改动审批存储：按工作区持久化 AI 编辑的「改前基线」，支持逐文件保留/回滚。
 *
 * 语义对齐 dsh-diff-approval 的核心子集：每个文件一条目，基线 = 本工作区内
 * 第一次被 AI 编辑前的内容（pending 期间的重复编辑不换基线，diff 始终是
 * 「改前 vs 当前磁盘」的活口径，外部改动同样如实呈现）；keep/revert 后条目
 * 转已处理留在列表，再次被编辑则以新基线重新进入待处理。新建文件回滚即删除。
 *
 * 落盘：<agentDir>/diff-approval/workspaces/<工作区哈希>.json，写走临时文件
 * + rename 的原子路径；损坏文件备份为 *.corrupt 后从空重建（不静默丢数据）。
 * 超过 maxFileBytes 或含 NUL 的文件不追踪（diff/回滚都以文本为前提）。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Diff from "diff";
import { generateUnifiedPatch } from "../tools/edit-diff.ts";

export type DiffApprovalStatus = "pending" | "kept" | "reverted";

export interface DiffApprovalEntry {
	id: string;
	/** 绝对路径（捕获时的 resolve 结果）。 */
	path: string;
	status: DiffApprovalStatus;
	/** AI 第一次编辑前文件是否已存在（false = AI 新建，回滚即删除）。 */
	originalExisted: boolean;
	/** 改前内容；仅 pending 保留，keep/revert 后置 null 释放内存。 */
	originalContent: string | null;
	baselineAt: string;
	resolvedAt: string | null;
}

/** 列表行（协议 DiffApprovalFileSummary 的宿主侧同构）。 */
export interface DiffApprovalFileSummary {
	id: string;
	path: string;
	/** 工作区相对显示路径（解析不出时回退绝对路径）。 */
	displayPath: string;
	status: DiffApprovalStatus;
	originalExisted: boolean;
	currentExists: boolean;
	/** +/− 行数；内容过大或基线缺失时为 null。 */
	added: number | null;
	removed: number | null;
	/** 当前磁盘字节数；文件不在时为 0。 */
	size: number;
	baselineAt: string;
	resolvedAt: string | null;
}

const PERSIST_VERSION = 1;
/** 默认单文件追踪上限：超过不捕获不追踪（对齐 owl-rewind 的「过大不存」）。 */
export const DIFF_APPROVAL_DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 行数统计与 diff 输出的内容上限（超出只说文件大小，不算行级 diff）。 */
const DIFF_TEXT_CAP_CHARS = 512 * 1024;
const DIFF_OUTPUT_CAP_CHARS = 400 * 1024;

/** Windows 下大小写/分隔符不敏感的路径比较键。 */
export function diffApprovalPathKey(p: string): string {
	const resolved = p.replace(/\//g, "\\");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface StagedCapture {
	path: string;
	existed: boolean;
	/** 改前内容；无法捕获（二进制/过大/不可读）时为 undefined 且带 skip 原因。 */
	content?: string;
	skip?: string;
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
	/** 状态变化时回调（注册表接上广播器，向桌面 UI 推 diffApproval.changed）。 */
	onChanged: (() => void) | undefined;
	private entries: DiffApprovalEntry[] = [];
	private staging = new Map<string, StagedCapture>();
	private loaded = false;

	constructor(options: { filePath: string; workspaceDir: string; maxFileBytes?: number }) {
		this.filePath = options.filePath;
		this.workspaceDir = options.workspaceDir;
		this.maxFileBytes = options.maxFileBytes ?? DIFF_APPROVAL_DEFAULT_MAX_FILE_BYTES;
	}

	/** 同步加载一次（进程内缓存，之后每次变更即写盘）。 */
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.filePath)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as PersistShape;
			if (parsed.version === PERSIST_VERSION && Array.isArray(parsed.entries)) {
				this.entries = parsed.entries;
			}
		} catch {
			// 损坏文件拒绝加载但备份留证，从空重建
			try {
				renameSync(this.filePath, `${this.filePath}.corrupt`);
			} catch {
				/* 备份失败也只能放弃旧文件 */
			}
		}
	}

	/**
	 * 工具执行前暂存改前状态（tool_call 时机）。已有 pending 条目的文件不换
	 * 基线（最早的改前内容才是回滚点）；已处理条目暂不清理，commit 时以新
	 * 基线的 pending 条目取代。
	 */
	stage(toolCallId: string, absolutePath: string): void {
		const staged: StagedCapture = { path: absolutePath, existed: false };
		try {
			if (existsSync(absolutePath)) {
				const stat = statSync(absolutePath).size;
				if (stat > this.maxFileBytes) {
					staged.skip = "too-large";
				} else {
					const raw = readFileSync(absolutePath, "utf-8");
					if (raw.includes("\0")) {
						staged.skip = "binary";
					} else {
						staged.existed = true;
						staged.content = raw;
					}
				}
			}
		} catch (error) {
			staged.skip = error instanceof Error ? error.message : String(error);
		}
		this.staging.set(toolCallId, staged);
	}

	/** 工具结果落库（tool_result 时机）；失败结果与未暂存的调用直接空转。 */
	commit(toolCallId: string, isError: boolean): void {
		const staged = this.staging.get(toolCallId);
		this.staging.delete(toolCallId);
		if (!staged || staged.skip !== undefined || isError) return;

		const key = diffApprovalPathKey(staged.path);
		const existing = this.entries.find(
			(entry) => entry.status === "pending" && diffApprovalPathKey(entry.path) === key,
		);
		if (existing) return; // 基线保持最早一次的改前内容

		// 已处理条目被再次编辑：由新 pending 条目取代（时间序上旧条目已无意义）
		this.entries = this.entries.filter(
			(entry) => !(diffApprovalPathKey(entry.path) === key && entry.status !== "pending"),
		);
		this.entries.unshift({
			id: randomUUID(),
			path: staged.path,
			status: "pending",
			originalExisted: staged.existed,
			originalContent: staged.content ?? null,
			baselineAt: new Date().toISOString(),
			resolvedAt: null,
		});
		this.persist();
		this.onChanged?.();
	}

	/** 列表（算活差量，不落盘）。pending 在前按基线时间倒序，已处理按处理时间倒序。 */
	list(cwd: string): DiffApprovalFileSummary[] {
		const rows = this.entries.map((entry) => this.summarize(entry, cwd));
		rows.sort((a, b) => {
			if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
			const at = a.status === "pending" ? a.baselineAt : (a.resolvedAt ?? a.baselineAt);
			const bt = b.status === "pending" ? b.baselineAt : (b.resolvedAt ?? b.baselineAt);
			return at < bt ? 1 : at > bt ? -1 : 0;
		});
		return rows;
	}

	/** 单文件 unified diff（基线 vs 当前磁盘，补 diff --git 头供前端解析器识别）。 */
	diff(entryId: string): { diff: string; truncated: boolean } {
		const entry = this.entries.find((item) => item.id === entryId);
		if (!entry) throw new Error(`Unknown diff-approval entry: ${entryId}`);
		if (entry.status !== "pending" || entry.originalContent === null) {
			throw new Error("该条目已处理，基线内容已释放");
		}
		let current = "";
		if (existsSync(entry.path)) {
			const raw = readFileSync(entry.path, "utf-8");
			if (raw.includes("\0")) throw new Error("文件已变成二进制内容，无法生成 diff");
			current = raw;
		}
		let patch = generateUnifiedPatch(entry.path, entry.originalContent, current, 4);
		if (!patch.startsWith("diff --git ")) {
			patch = `diff --git a/${entry.path} b/${entry.path}\n${patch}`;
		}
		if (patch.length > DIFF_OUTPUT_CAP_CHARS) {
			const cut = patch.lastIndexOf("\n", DIFF_OUTPUT_CAP_CHARS);
			return { diff: cut > 0 ? patch.slice(0, cut) : patch.slice(0, DIFF_OUTPUT_CAP_CHARS), truncated: true };
		}
		return { diff: patch, truncated: false };
	}

	/** 保留/回滚一批条目（只动 pending）；回滚 = 还原基线或删除新建文件。 */
	resolve(
		entryIds: string[],
		action: "keep" | "revert",
	): { resolved: number; failed: Array<{ path: string; reason: string }> } {
		const failed: Array<{ path: string; reason: string }> = [];
		let resolved = 0;
		for (const entryId of entryIds) {
			const entry = this.entries.find((item) => item.id === entryId);
			if (!entry || entry.status !== "pending") {
				failed.push({ path: entry?.path ?? entryId, reason: "不是待处理条目" });
				continue;
			}
			try {
				if (action === "revert") {
					if (entry.originalExisted) {
						if (entry.originalContent === null) throw new Error("缺少改前内容");
						mkdirSync(dirname(entry.path), { recursive: true });
						writeFileSync(entry.path, entry.originalContent, "utf-8");
					} else if (existsSync(entry.path)) {
						unlinkSync(entry.path);
					}
				}
				entry.status = action === "keep" ? "kept" : "reverted";
				entry.originalContent = null;
				entry.resolvedAt = new Date().toISOString();
				resolved += 1;
			} catch (error) {
				failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		if (resolved > 0) {
			this.persist();
			this.onChanged?.();
		}
		return { resolved, failed };
	}

	/** 清掉已处理条目（保留/回滚后的记录行），返回清除数。 */
	clearResolved(): number {
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => entry.status === "pending");
		const removed = before - this.entries.length;
		if (removed > 0) {
			this.persist();
			this.onChanged?.();
		}
		return removed;
	}

	private summarize(entry: DiffApprovalEntry, cwd: string): DiffApprovalFileSummary {
		let currentExists = false;
		let size = 0;
		try {
			if (existsSync(entry.path)) {
				currentExists = true;
				size = statSync(entry.path).size;
			}
		} catch {
			/* 读不到按不存在处理 */
		}
		let added: number | null = null;
		let removed: number | null = null;
		if (
			entry.status === "pending" &&
			entry.originalContent !== null &&
			size <= DIFF_TEXT_CAP_CHARS &&
			currentExists
		) {
			try {
				const current = readFileSync(entry.path, "utf-8");
				if (!current.includes("\0")) {
					for (const part of Diff.diffLines(entry.originalContent, current)) {
						if (part.added) added = (added ?? 0) + countNewlines(part.value);
						else if (part.removed) removed = (removed ?? 0) + countNewlines(part.value);
					}
				}
			} catch {
				added = null;
				removed = null;
			}
		} else if (entry.status === "pending" && !currentExists && entry.originalContent !== null) {
			removed = countNewlines(entry.originalContent);
			added = 0;
		}
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
		};
	}

	private persist(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const payload: PersistShape = {
			version: PERSIST_VERSION,
			workspaceDir: this.workspaceDir,
			entries: this.entries,
		};
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), "utf-8");
		renameSync(tmp, this.filePath);
	}
}

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) count += 1;
	}
	return count;
}

function displayPathOf(absolutePath: string, cwd: string): string {
	const normalizedCwd = cwd.replace(/\//g, "\\").replace(/\\+$/, "");
	const normalizedPath = absolutePath.replace(/\//g, "\\");
	const lowerCwd = normalizedCwd.toLowerCase();
	const lowerPath = normalizedPath.toLowerCase();
	if (lowerPath.startsWith(lowerCwd + "\\")) {
		return normalizedPath.slice(normalizedCwd.length + 1).replace(/\\/g, "/");
	}
	return absolutePath;
}

/** 工作区存储文件名（内容寻址，避免路径里的非法字符）。 */
export function diffApprovalStoreFileName(cwd: string): string {
	return createHash("sha1").update(diffApprovalPathKey(cwd)).digest("hex").slice(0, 16) + ".json";
}

export function diffApprovalStorePath(agentDir: string, cwd: string): string {
	return join(agentDir, "diff-approval", "workspaces", diffApprovalStoreFileName(cwd));
}
