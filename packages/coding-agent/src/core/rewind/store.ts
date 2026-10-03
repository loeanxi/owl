/**
 * owl-rewind 快照存储：会话工作区文件的「写前备份」落盘层。
 *
 * 设计对标 Claude Code / dsh-rewind 的轻量检查点：
 * - 只备份「被写类工具动过、且确实变化」的文件，从不整树快照；
 * - 记录追加写进 index.jsonl（崩溃安全：半行会在加载时丢弃）；
 * - 内容按 sha256 内容寻址存 blobs/，同会话去重，重复内容零拷贝；
 * - 每会话只保留最近 N 组锚点（同一轮用户消息 = 一组），修剪时回收无引用 blob；
 * - 还原动作先写 restore-journal.json 再逐项执行、逐项打勾，崩溃后重开可续做
 *   （动作本身按磁盘差量计算，重放幂等）。
 *
 * 本文件不依赖任何 harness 类型：纯 node:fs + 注入参数，可独立单测。
 */
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 单条备份记录（index.jsonl 的一行）。 */
export interface RewindRecord {
	v: 1;
	id: string;
	/** 捕获时的绝对路径 */
	path: string;
	/** 捕获时父目录的 realpath（还原时校验目录没有被换掉） */
	dirRealPath: string;
	/** 锚点：这条记录归属的那轮用户消息的会话条目 id */
	anchorId: string;
	/** 写之前文件是否存在（false = 这次写新建了文件，还原时应删除） */
	existed: boolean;
	/** 内容 blob 的 sha256；existed=false 时为 null */
	hash: string | null;
	size: number;
	/** 捕获时间（ISO；与会话条目时间戳同格式，可直接比较） */
	time: string;
	/** write = 写类工具执行前的捕获；scan = 用户消息边界的重扫（外部改动） */
	source: "write" | "scan";
}

/** 每会话保留的锚点组数（一组 = 同一条用户消息轮次内的全部记录）。 */
export const REWIND_PRUNE_ANCHORS = 100;

/** 还原日志（崩溃安全：逐动作打勾，重开续做）。 */
export interface RestoreJournal {
	v: 1;
	targetId: string;
	startedAt: string;
	actions: Array<{
		path: string;
		action: "restore" | "delete";
		done: boolean;
		error?: string;
		/** restore：目标内容 blob 的 sha256（跨重启续做时据此读内容） */
		hash?: string | null;
		/** 捕获时父目录的 realpath（穿透写入防护） */
		dirRealPath?: string;
	}>;
}

export interface StagedCapture {
	path: string;
	dirRealPath: string;
	existed: boolean;
	hash: string | null;
	size: number;
	/** 捕获到的「写之前」内容；existed=false 时为 null */
	content: Buffer | null;
	/** 超过大小上限等原因不备份：占位追踪但不落记录 */
	skipped?: string;
}

function isoNow(): string {
	return new Date().toISOString();
}

function atomicWrite(filePath: string, data: string): void {
	const temp = `${filePath}.tmp-${randomUUID()}`;
	writeFileSync(temp, data, "utf-8");
	renameSync(temp, filePath);
}

/** 内容 blob 落盘（内容寻址：已存在即跳过）。返回 sha256。 */
function writeBlob(blobsDir: string, content: Buffer): string {
	const hash = createHash("sha256").update(content).digest("hex");
	const target = join(blobsDir, hash);
	if (!existsSync(target)) {
		const temp = `${target}.tmp-${randomUUID()}`;
		writeFileSync(temp, content);
		renameSync(temp, target);
	}
	return hash;
}

export class RewindSnapshotStore {
	readonly sessionDir: string;
	private readonly indexFile: string;
	private readonly blobsDir: string;
	private readonly journalFile: string;
	private records: RewindRecord[];

	constructor(sessionDir: string) {
		this.sessionDir = sessionDir;
		this.indexFile = join(sessionDir, "index.jsonl");
		this.blobsDir = join(sessionDir, "blobs");
		this.journalFile = join(sessionDir, "restore-journal.json");
		this.records = [];
		this.reload();
	}

	/** 从磁盘重建索引；半行/坏行丢弃（追加写崩溃安全的另一半）。 */
	reload(): void {
		this.records = [];
		if (!existsSync(this.indexFile)) return;
		let raw = "";
		try {
			raw = readFileSync(this.indexFile, "utf-8");
		} catch {
			return;
		}
		const lines = raw.split("\n");
		// 最后一行不完整（进程在 append 中途死掉）时丢弃
		if (lines.length > 0 && raw.endsWith("\n")) lines.pop();
		else if (lines.length > 0) lines.pop();
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as RewindRecord;
				if (record && record.v === 1 && typeof record.path === "string") this.records.push(record);
			} catch {
				// 坏行跳过
			}
		}
	}

	getRecords(): readonly RewindRecord[] {
		return this.records;
	}

	/** 追加一条记录并持久化（单行 append + fsync 语义由 appendFileSync 保证到页缓存）。 */
	append(record: Omit<RewindRecord, "v" | "id" | "time"> & { time?: string }): RewindRecord {
		const full: RewindRecord = { v: 1, id: randomUUID(), time: record.time ?? isoNow(), ...record } as RewindRecord;
		mkdirSync(this.sessionDir, { recursive: true });
		appendFileSync(this.indexFile, `${JSON.stringify(full)}\n`, "utf-8");
		this.records.push(full);
		return full;
	}

	/** 把一份文件内容写成备份记录。返回新记录；content 为 null 表示「写之前不存在」。 */
	recordCapture(params: {
		path: string;
		dirRealPath: string;
		anchorId: string;
		content: Buffer | null;
		source: "write" | "scan";
		time?: string;
	}): RewindRecord {
		const hash = params.content === null ? null : writeBlob(this.blobsDirGuard(), params.content);
		return this.append({
			path: params.path,
			dirRealPath: params.dirRealPath,
			anchorId: params.anchorId,
			existed: params.content !== null,
			hash,
			size: params.content?.byteLength ?? 0,
			source: params.source,
			...(params.time ? { time: params.time } : {}),
		});
	}

	private blobsDirGuard(): string {
		mkdirSync(this.blobsDir, { recursive: true });
		return this.blobsDir;
	}

	/** 读取一条记录的备份内容。 */
	readContent(record: RewindRecord): Buffer | null {
		if (record.hash === null) return null;
		return this.readContentByHash(record.hash);
	}

	/** 按 hash 读取备份内容（还原日志跨重启续做时用）。 */
	readContentByHash(hash: string): Buffer | null {
		try {
			return readFileSync(join(this.blobsDir, hash));
		} catch {
			return null;
		}
	}

	/**
	 * 修剪：只保留最近 N 组锚点（按记录时间排序的 distinct anchorId），
	 * 然后回收不再被引用的 blob。存在未完成还原日志时跳过（日志引用的目标
	 * 状态必须保得住）。返回修剪掉的记录数。
	 */
	prune(maxAnchors: number = REWIND_PRUNE_ANCHORS): number {
		if (existsSync(this.journalFile)) return 0;
		const byAnchor = new Map<string, number>();
		for (const record of this.records) {
			byAnchor.set(record.anchorId, (byAnchor.get(record.anchorId) ?? 0) + 1);
		}
		const anchors = [...byAnchor.keys()];
		if (anchors.length <= maxAnchors) return 0;
		const drop = new Set(anchors.slice(0, anchors.length - maxAnchors));
		const kept = this.records.filter((record) => !drop.has(record.anchorId));
		const removed = this.records.length - kept.length;
		if (removed === 0) return 0;
		this.records = kept;
		this.rewriteIndex();
		this.gcBlobs();
		return removed;
	}

	private rewriteIndex(): void {
		mkdirSync(this.sessionDir, { recursive: true });
		atomicWrite(this.indexFile, `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	}

	private gcBlobs(): void {
		if (!existsSync(this.blobsDir)) return;
		const referenced = new Set(
			this.records.map((record) => record.hash).filter((hash): hash is string => hash !== null),
		);
		for (const name of readdirSync(this.blobsDir)) {
			if (name.includes(".tmp-")) {
				try {
					unlinkSync(join(this.blobsDir, name));
				} catch {
					// 并发写同名临时文件的竞争：下次再清
				}
				continue;
			}
			if (!referenced.has(name)) {
				try {
					unlinkSync(join(this.blobsDir, name));
				} catch {
					// 回收失败不打扰主流程
				}
			}
		}
	}

	// -- 还原日志（崩溃安全） --------------------------------------------------

	readJournal(): RestoreJournal | null {
		if (!existsSync(this.journalFile)) return null;
		try {
			const journal = JSON.parse(readFileSync(this.journalFile, "utf-8")) as RestoreJournal;
			if (journal?.v === 1 && Array.isArray(journal.actions)) return journal;
		} catch {
			// 半截日志按不存在处理（动作幂等，重新计划即可）
		}
		return null;
	}

	writeJournal(journal: RestoreJournal | null): void {
		if (journal === null) {
			try {
				unlinkSync(this.journalFile);
			} catch {
				// 不存在即目标状态
			}
			return;
		}
		mkdirSync(this.sessionDir, { recursive: true });
		atomicWrite(this.journalFile, JSON.stringify(journal, null, "\t"));
	}

	/** 删除整个会话的快照目录（会话被删除时联动清理）。 */
	destroy(): void {
		try {
			rmSync(this.sessionDir, { recursive: true, force: true });
		} catch {
			// 尽力而为
		}
		this.records = [];
	}
}

/** 捕获一个文件的「写之前」状态；不满足安全条件时返回带原因的占位。 */
export function captureFileState(absolutePath: string, maxFileBytes: number): StagedCapture {
	const dirRealPath = (() => {
		try {
			return realpathSync(dirname(absolutePath));
		} catch {
			return dirname(absolutePath);
		}
	})();
	try {
		// lstat：符号链接按链接本体判断，绝不读穿（还原时同样拒绝穿透写入）
		const stats = lstatSync(absolutePath, { throwIfNoEntry: false });
		if (!stats) {
			return { path: absolutePath, dirRealPath, existed: false, hash: null, size: 0, content: null };
		}
		// 符号链接 / 多硬链接文件不追踪：还原会穿透链接误伤另一份文件
		if (stats.isSymbolicLink() || stats.nlink > 1) {
			return { path: absolutePath, dirRealPath, existed: true, hash: null, size: 0, content: null, skipped: "link" };
		}
		if (!stats.isFile()) {
			return {
				path: absolutePath,
				dirRealPath,
				existed: true,
				hash: null,
				size: 0,
				content: null,
				skipped: "not-file",
			};
		}
		if (stats.size > maxFileBytes) {
			return {
				path: absolutePath,
				dirRealPath,
				existed: true,
				hash: null,
				size: stats.size,
				content: null,
				skipped: "too-large",
			};
		}
		const content = readFileSync(absolutePath);
		return {
			path: absolutePath,
			dirRealPath,
			existed: true,
			hash: createHash("sha256").update(content).digest("hex"),
			size: content.byteLength,
			content,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === "ENOENT") {
			return { path: absolutePath, dirRealPath, existed: false, hash: null, size: 0, content: null };
		}
		// 读取失败（权限/占用）：按存在但不备份处理，绝不阻塞工具调用
		return {
			path: absolutePath,
			dirRealPath,
			existed: true,
			hash: null,
			size: 0,
			content: null,
			skipped: "read-failed",
		};
	}
}
