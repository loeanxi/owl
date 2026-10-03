/**
 * owl-rewind 引擎：追踪状态机 + 影响清单 + 差量还原。
 *
 * 追踪（扩展钩子侧）：
 * - `stageCapture`（tool_call，write/edit）：把目标文件的「写之前」状态暂存内存；
 * - `commitCapture`（tool_result）：成功的调用把暂存发布为备份记录，失败的丢弃；
 * - `stageBoundaryRescan`（before_agent_start）+ `ensureBoundaryCommitted`
 *   （agent_start / 本轮首个 tool_call）：重扫全部已追踪文件，外部改动
 *   （bash、手动编辑）也被记录，回退时一并还原——「轻量却不残缺」的关键。
 *
 * 还原（桥侧）：`planRestore` 对照真实磁盘算差量（幂等、无幽灵写入），
 * `applyRestore` 按还原日志逐项执行（崩溃后可续做）。
 *
 * 重建状态的规则：文件在目标用户消息 T 时刻的内容 = 时间线上第一条
 * 「发生在 T 之后」的记录的备份内容；没有则沿用最后一条记录的内容
 * （其后磁盘未变）。锚点条目不在当前分支上的记录（被回退掉的旧未来）
 * 一律按时间戳参与比较，wall-clock 顺序即真实顺序。
 */

import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { captureFileState, type RestoreJournal, type RewindRecord, type RewindSnapshotStore } from "./store.ts";

/** 锚点解析只需要会话分支的结构子集（ReadonlySessionManager 天然满足）。 */
export interface RewindBranchEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	message?: { role: string };
}

export interface RewindAnchorSource {
	getBranch(): RewindBranchEntry[];
}

export interface RestorePlanItem {
	path: string;
	action: "restore" | "delete";
	/** 还原内容大小（delete 为 0） */
	size: number;
	hash: string | null;
	dirRealPath: string;
}

export interface RestorePlan {
	targetId: string;
	/** 将被改动的文件（restore/delete） */
	actions: RestorePlanItem[];
	/** 已追踪但内容与目标状态一致的文件数（不动） */
	unchanged: number;
}

export interface RestoreResult {
	restored: number;
	deleted: number;
	unchanged: number;
	skipped: Array<{ path: string; reason: string }>;
}

export interface RewindTrackerOptions {
	store: RewindSnapshotStore;
	/** 单文件备份上限（字节），超出不追踪不备份 */
	maxFileBytes: number;
}

/** 当前分支上，从叶往根走的最近一条用户消息条目 id（本轮锚点）。 */
export function resolveAnchorId(source: RewindAnchorSource): string | null {
	const branch = source.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message?.role === "user") return entry.id;
	}
	return null;
}

interface StagedCapture {
	path: string;
	dirRealPath: string;
	existed: boolean;
	hash: string | null;
	size: number;
	content: Buffer | null;
	anchorId: string;
	skipped?: string;
}

export class SessionRewindTracker {
	private readonly store: RewindSnapshotStore;
	private readonly maxFileBytes: number;
	/** toolCallId → 暂存的写前状态 */
	private readonly staged = new Map<string, StagedCapture>();
	private boundaryStaged = false;
	private journalResumed = false;

	constructor(options: RewindTrackerOptions) {
		this.store = options.store;
		this.maxFileBytes = options.maxFileBytes;
	}

	/** 进程重启后续做半截还原（动作幂等，重放安全）。在挂载时调用一次。 */
	resumeInterruptedRestore(): RestoreResult | null {
		if (this.journalResumed) return null;
		this.journalResumed = true;
		const journal = this.store.readJournal();
		if (!journal) return null;
		return this.runJournal(journal);
	}

	// -- 追踪钩子 ---------------------------------------------------------------

	/** before_agent_start：标记边界，磁盘重扫推迟到能解析锚点时（agent_start/首个 tool_call）。 */
	stageBoundaryRescan(): void {
		this.boundaryStaged = true;
	}

	/** 记录一条成功的写前备份。失败（isError）的调用直接丢弃暂存。 */
	commitCapture(toolCallId: string, isError: boolean): void {
		const staged = this.staged.get(toolCallId);
		if (!staged) return;
		this.staged.delete(toolCallId);
		if (isError || staged.skipped) return;
		this.appendDeduped({
			path: staged.path,
			dirRealPath: staged.dirRealPath,
			anchorId: staged.anchorId,
			content: staged.existed ? staged.content : null,
			source: "write",
		});
	}

	/** 工具调用前捕获「写之前」状态；顺带把上轮遗留的边界重扫提交掉。 */
	stageCapture(toolCallId: string, absolutePath: string, anchorSource: RewindAnchorSource): void {
		this.ensureBoundaryCommitted(anchorSource);
		if (this.staged.has(toolCallId)) return;
		const anchorId = resolveAnchorId(anchorSource);
		if (!anchorId) return;
		const state = captureFileState(absolutePath, this.maxFileBytes);
		this.staged.set(toolCallId, { ...state, anchorId });
	}

	/**
	 * agent_start / 本轮首个 tool_call：把 before_agent_start 时标记的边界重扫落库。
	 * 锚点解析不出来（比如会话还没第一条用户消息）时保留标记，下个钩子再试。
	 */
	ensureBoundaryCommitted(anchorSource: RewindAnchorSource): void {
		if (!this.boundaryStaged) return;
		const anchorId = resolveAnchorId(anchorSource);
		if (!anchorId) return;
		this.boundaryStaged = false;
		// 重扫时间取现在：它描述的是「这轮开始时磁盘的样子」
		for (const path of this.trackedPaths()) {
			const state = captureFileState(path, this.maxFileBytes);
			if (state.skipped) continue;
			this.appendDeduped(
				{
					path,
					dirRealPath: state.dirRealPath,
					anchorId,
					content: state.existed ? state.content : null,
					source: "scan",
				},
				{ onlyIfChanged: true },
			);
		}
	}

	/** 已追踪的文件路径集合 = 出现过备份记录的路径（去重）。 */
	private trackedPaths(): string[] {
		const seen = new Set<string>();
		for (const record of this.store.getRecords()) {
			if (!seen.has(record.path)) seen.add(record.path);
		}
		return [...seen];
	}

	/** 同一锚点下与最后一条记录内容相同的不再追加（不变不存）。 */
	private appendDeduped(
		params: { path: string; dirRealPath: string; anchorId: string; content: Buffer | null; source: "write" | "scan" },
		options?: { onlyIfChanged?: boolean },
	): void {
		if (options?.onlyIfChanged) {
			const last = this.lastRecordForPath(params.path);
			if (last) {
				const lastHash = last.hash ?? "";
				const nextHash = params.content === null ? "" : createHash("sha256").update(params.content).digest("hex");
				if (lastHash === nextHash) return;
			}
		}
		this.store.recordCapture(params);
	}

	private lastRecordForPath(path: string): RewindRecord | undefined {
		const records = this.store.getRecords();
		for (let i = records.length - 1; i >= 0; i--) {
			if (records[i]!.path === path) return records[i];
		}
		return undefined;
	}

	// -- 影响清单与还原（桥侧） ---------------------------------------------------

	/**
	 * 计算「回退到目标用户消息 T」时每个已追踪文件该变成什么样（只算不动盘）。
	 * 规则：时间线上第一条发生在 T 之后（时间戳 ≥ T 且锚点位置 ≥ T）的记录的
	 * 备份内容；没有这样的记录则沿用最后一条记录的内容。
	 */
	planRestore(target: { entryId: string; time: string }, anchorSource: RewindAnchorSource): RestorePlan {
		const branch = anchorSource.getBranch();
		const targetPos = branch.findIndex((entry) => entry.id === target.entryId);
		// 锚点位置表：能定位到当前分支的记录用位置比较，定位不到的（被回退掉的
		// 旧未来）只按时间戳比较——wall-clock 顺序即真实顺序
		this.branchPosCache = new Map();
		branch.forEach((entry, index) => this.branchPosCache!.set(entry.id, index));
		const actions: RestorePlanItem[] = [];
		let unchanged = 0;
		for (const path of this.trackedPaths()) {
			const timeline = this.store.getRecords().filter((record) => record.path === path);
			if (timeline.length === 0) continue;
			let state: RewindRecord | undefined;
			for (const record of timeline) {
				if (!this.recordAfterTarget(record, target, targetPos)) {
					continue;
				}
				state = record;
				break;
			}
			state ??= timeline[timeline.length - 1]!;
			const disk = diskStateOf(path);
			if (!state.existed) {
				if (disk.exists)
					actions.push({ path, action: "delete", size: 0, hash: null, dirRealPath: state.dirRealPath });
				else unchanged += 1;
				continue;
			}
			if (!disk.exists || disk.hash !== state.hash) {
				actions.push({
					path,
					action: "restore",
					size: state.size,
					hash: state.hash,
					dirRealPath: state.dirRealPath,
				});
			} else {
				unchanged += 1;
			}
		}
		return { targetId: target.entryId, actions, unchanged };
	}

	/** 记录是否发生在目标之后：时间戳必须更新；锚点能定位到当前分支时还要位置不早于目标。 */
	private recordAfterTarget(
		record: RewindRecord,
		target: { entryId: string; time: string },
		targetPos: number,
	): boolean {
		if (record.time < target.time) return false;
		if (targetPos >= 0) {
			const anchorPos = this.branchPosCache?.get(record.anchorId);
			if (anchorPos !== undefined && anchorPos < targetPos) return false;
		}
		return true;
	}

	/** planRestore 用的锚点位置缓存（同一次 plan 内构建）。 */
	private branchPosCache: Map<string, number> | undefined;

	applyRestore(plan: RestorePlan): RestoreResult {
		if (plan.actions.length === 0) {
			return { restored: 0, deleted: 0, unchanged: plan.unchanged, skipped: [] };
		}
		const journal: RestoreJournal = {
			v: 1,
			targetId: plan.targetId,
			startedAt: new Date().toISOString(),
			actions: plan.actions.map((item) => ({
				path: item.path,
				action: item.action,
				done: false,
				...(item.hash !== null ? { hash: item.hash } : {}),
				dirRealPath: item.dirRealPath,
			})) as RestoreJournal["actions"],
		};
		this.store.writeJournal(journal);
		return this.runJournal(journal, plan.unchanged);
	}

	/** 执行日志里未完成的动作（新还原与崩溃续做共用；动作幂等）。 */
	private runJournal(journal: RestoreJournal, unchanged = 0): RestoreResult {
		const result: RestoreResult = { restored: 0, deleted: 0, unchanged, skipped: [] };
		for (const item of journal.actions) {
			if (item.done) continue;
			const outcome = this.applyAction(item);
			if (outcome === undefined) {
				item.done = true;
			} else {
				item.error = outcome;
				item.done = false;
			}
			this.store.writeJournal(journal);
		}
		for (const item of journal.actions) {
			if (!item.done && item.error) {
				result.skipped.push({ path: item.path, reason: item.error });
				continue;
			}
			if (item.action === "restore") result.restored += 1;
			else result.deleted += 1;
		}
		this.store.writeJournal(null);
		return result;
	}

	/** 执行单个还原动作。返回 undefined = 成功，字符串 = 跳过原因。 */
	private applyAction(item: RestoreJournal["actions"][number]): string | undefined {
		try {
			// 目录被移走/换掉时拒绝穿透写入（realpath 钉死捕获时的位置）
			let currentDir: string;
			try {
				currentDir = realpathSync(dirname(item.path));
			} catch {
				currentDir = "";
			}
			if (currentDir !== item.dirRealPath) {
				// restore 的目标目录可能整个被删了：重建后再校验一次
				if (item.action === "restore" && currentDir === "") {
					mkdirSync(dirname(item.path), { recursive: true });
					currentDir = realpathSync(dirname(item.path));
				}
				if (currentDir !== item.dirRealPath) return "directory changed since capture";
			}
			const stats = lstatSync(item.path, { throwIfNoEntry: false });
			if (stats) {
				if (stats.isSymbolicLink()) return "symbolic link, skipped";
				if (!stats.isFile()) return "not a regular file, skipped";
			}
			if (item.action === "delete") {
				if (!stats) return undefined; // 已经不在 = 目标状态达成
				unlinkSync(item.path);
				return undefined;
			}
			const content = item.hash !== null ? this.store.readContentByHash(item.hash) : null;
			if (content === null) return "backup content missing";
			const temp = join(dirname(item.path), `.owl-rewind-${randomTail()}`);
			writeFileSync(temp, content);
			renameSync(temp, item.path);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/** 会话删除时联动清盘。 */
	destroyAll(): void {
		this.store.destroy();
	}

	/** 修剪旧锚点（挂载与每次提交后调用；有未完成日志时内部自动跳过）。 */
	prune(): void {
		this.store.prune();
	}
}

// -- 回退候选（当前分支上的用户消息） ---------------------------------------------

export interface RewindTargetInfo {
	entryId: string;
	text: string;
	timestamp: string;
}

/** 从消息 content 里抽纯文本（string 或 content block 数组都兼容）。 */
export function textOfMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text?: string } => (part as { type?: string })?.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/**
 * 回退候选 = 当前可见上下文里的用户消息（投影感知：被压缩掉的 Earlier
 * 轮次不出现——回退进压缩范围语义混乱，桌面按钮也不该给它们）。
 * 入参传 sessionManager.buildSessionProjection().entries 的 sourceEntry 即可。
 */
export function listRewindTargets(
	entries: ReadonlyArray<{
		id: string;
		type: string;
		timestamp: string;
		message?: { role?: string; content?: unknown };
	}>,
): RewindTargetInfo[] {
	const targets: RewindTargetInfo[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = textOfMessageContent(entry.message.content);
		if (text.trim()) targets.push({ entryId: entry.id, text, timestamp: entry.timestamp });
	}
	return targets;
}

function randomTail(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 磁盘现状：存在性 + 内容 hash（与备份记录同一算法，供差量比较）。 */
function diskStateOf(path: string): { exists: boolean; hash?: string } {
	let stats;
	try {
		stats = lstatSync(path, { throwIfNoEntry: false });
	} catch {
		return { exists: false };
	}
	if (!stats) return { exists: false };
	if (!stats.isFile()) return { exists: true };
	try {
		return { exists: true, hash: createHash("sha256").update(readFileSync(path)).digest("hex") };
	} catch {
		return { exists: true };
	}
}
