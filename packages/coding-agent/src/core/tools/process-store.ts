/**
 * owl unified-exec 进程存储：跨工具调用存活的子进程注册表。
 *
 * bash/powershell 工具在 `yield_time_ms` 内没跑完的命令不再被杀掉，而是把句柄存进这里并
 * 返回 session_id；模型随后用 `process` 工具 poll / write / kill。设计对标 Codex 的
 * unified exec（codex-rs/core/src/unified_exec/）：不维护常驻 REPL shell，维护的是
 * "仍在运行的进程句柄表"，上限 LRU 淘汰。
 *
 * 输出采用双缓冲：`pending`（自上次 poll 以来的新输出，读取即消费）+ `recent`
 * （HeadTail 环形缓冲，头尾各半，中段丢弃，供 list/kill 摘要）。
 */
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "child_process";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

/** 进程表上限；超出时先淘汰已退出的，再按 lastUsedAt LRU 淘汰运行中的（kill）。 */
const MAX_PROCESSES = 64;

/** pending 缓冲上限：poll 消费不尽时丢头部（新输出永远优先）。 */
const MAX_PENDING_BYTES = 1024 * 1024;

/** recent HeadTail 缓冲各半的上限（总 1MiB，头 512KB + 尾 512KB）。 */
const HALF_BUFFER_BYTES = 512 * 1024;

export interface HeadTailSnapshot {
	content: string;
	totalBytes: number;
	omittedBytes: number;
}

/**
 * 头尾各半的环形文本缓冲，中段以省略标记代替（对标 Codex HeadTailBuffer）。
 * 只在 UTF-8 字符边界上裁剪。
 */
export class HeadTailBuffer {
	private head = "";
	private headBytes = 0;
	private tail = "";
	private tailBytes = 0;
	private totalBytes = 0;

	append(chunk: string): void {
		const bytes = Buffer.byteLength(chunk, "utf-8");
		this.totalBytes += bytes;
		// 先填满头半区，其余滚入尾半区（尾半区只保留最后 HALF 字节）
		if (this.headBytes < HALF_BUFFER_BYTES) {
			const space = HALF_BUFFER_BYTES - this.headBytes;
			if (bytes <= space) {
				this.head += chunk;
				this.headBytes += bytes;
				return;
			}
			const headPart = sliceUtf8FromStart(chunk, space);
			this.head += headPart;
			this.headBytes += Buffer.byteLength(headPart, "utf-8");
			chunk = chunk.slice(headPart.length);
		}
		this.tail += chunk;
		this.tailBytes = Buffer.byteLength(this.tail, "utf-8");
		if (this.tailBytes > HALF_BUFFER_BYTES) {
			this.tail = sliceUtf8FromEnd(this.tail, HALF_BUFFER_BYTES);
			this.tailBytes = Buffer.byteLength(this.tail, "utf-8");
		}
	}

	snapshot(): HeadTailSnapshot {
		const omitted = Math.max(0, this.totalBytes - this.headBytes - this.tailBytes);
		if (omitted <= 0) return { content: this.head + this.tail, totalBytes: this.totalBytes, omittedBytes: 0 };
		const marker = `\n... ${omitted} bytes omitted ...\n`;
		return { content: this.head + marker + this.tail, totalBytes: this.totalBytes, omittedBytes: omitted };
	}
}

/** 从字符串开头取约 maxBytes 的内容，落在 UTF-8 边界上。 */
function sliceUtf8FromStart(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) return str;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf-8");
}

export interface ProcessEntry {
	id: number;
	/** 拥有该进程的 agent 会话；dispose 时按此清理。 */
	sessionId: string;
	command: string;
	cwd: string;
	child: ChildProcess;
	startedAt: number;
	lastUsedAt: number;
	/** stdin 是否可写（stdin 传输型 shell 的命令随 stdin 关闭执行，后续无法再写）。 */
	acceptsStdin: boolean;
	/** undefined = 仍在运行。 */
	exitCode: number | null | undefined;
	exitSignal: NodeJS.Signals | null;
	killed: boolean;
	/** 输出自上次 poll 以来的新输出（读取即消费）。 */
	pending: string;
	pendingBytes: number;
	recent: HeadTailBuffer;
	readonly exitPromise: Promise<void>;
	/** 实时输出订阅（前台等待阶段由 bash 工具接去驱动 UI 流式更新）。 */
	listeners: Set<(chunk: string) => void>;
}

const processes = new Map<number, ProcessEntry>();
let nextProcessId = 1;

export interface RegisterProcessOptions {
	child: ChildProcess;
	sessionId: string;
	command: string;
	cwd: string;
	acceptsStdin: boolean;
	/** 附加到 recent/pending 之外的实时订阅（如 UI 流式更新）。 */
	onData?: (chunk: string) => void;
}

export function registerSessionProcess(options: RegisterProcessOptions): ProcessEntry {
	pruneProcessesIfNeeded();
	const { child } = options;
	const stdoutDecoder = new StringDecoder("utf-8");
	const stderrDecoder = new StringDecoder("utf-8");
	let resolveExit: () => void = () => {};
	const exitPromise = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});

	const entry: ProcessEntry = {
		id: nextProcessId++,
		sessionId: options.sessionId,
		command: options.command,
		cwd: options.cwd,
		child,
		startedAt: Date.now(),
		lastUsedAt: Date.now(),
		acceptsStdin: options.acceptsStdin,
		exitCode: undefined,
		exitSignal: null,
		killed: false,
		pending: "",
		pendingBytes: 0,
		recent: new HeadTailBuffer(),
		exitPromise,
		listeners: new Set(options.onData ? [options.onData] : []),
	};

	const ingest = (chunk: Buffer, decoder: StringDecoder) => {
		const text = decoder.write(chunk);
		if (!text) return;
		entry.pending += text;
		entry.pendingBytes += Buffer.byteLength(text, "utf-8");
		trimPending(entry);
		entry.recent.append(text);
		for (const listener of entry.listeners) {
			try {
				listener(text);
			} catch {
				// 订阅者（UI 更新）出错不影响输出收集。
			}
		}
	};
	child.stdout?.on("data", (chunk: Buffer) => ingest(chunk, stdoutDecoder));
	child.stderr?.on("data", (chunk: Buffer) => ingest(chunk, stderrDecoder));
	child.stdin?.on("error", () => {});
	child.once("exit", (code, signal) => {
		const tailText = stdoutDecoder.end() + stderrDecoder.end();
		if (tailText) {
			entry.pending += tailText;
			entry.pendingBytes += Buffer.byteLength(tailText, "utf-8");
			trimPending(entry);
			entry.recent.append(tailText);
		}
		entry.exitCode = code;
		entry.exitSignal = signal ?? null;
		resolveExit();
	});
	if (child.pid) trackDetachedChildPid(child.pid);
	const untrack = () => {
		if (child.pid) untrackDetachedChildPid(child.pid);
	};
	child.once("exit", untrack);
	child.once("error", untrack);
	processes.set(entry.id, entry);
	return entry;
}

function trimPending(entry: ProcessEntry): void {
	if (entry.pendingBytes <= MAX_PENDING_BYTES) return;
	const dropped = sliceUtf8FromEnd(entry.pending, entry.pendingBytes - MAX_PENDING_BYTES);
	entry.pending = entry.pending.slice(dropped.length);
	entry.pendingBytes = Buffer.byteLength(entry.pending, "utf-8");
}

/** 从字符串结尾取约 maxBytes 的内容，落在 UTF-8 边界上。 */
function sliceUtf8FromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) return str;
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
	return buf.subarray(start).toString("utf-8");
}

export function getSessionProcess(id: number, sessionId?: string): ProcessEntry | undefined {
	const entry = processes.get(id);
	if (!entry) return undefined;
	if (sessionId && entry.sessionId !== sessionId) return undefined;
	entry.lastUsedAt = Date.now();
	return entry;
}

export function listSessionProcesses(sessionId?: string): ProcessEntry[] {
	const all = [...processes.values()].filter((entry) => !sessionId || entry.sessionId === sessionId);
	for (const entry of all) entry.lastUsedAt = entry.lastUsedAt;
	return all.sort((a, b) => a.id - b.id);
}

/** 读取并清空 pending 输出。 */
export function takePending(entry: ProcessEntry): string {
	const text = entry.pending;
	entry.pending = "";
	entry.pendingBytes = 0;
	return text;
}

/** 向会话进程 stdin 写入；`\u0003` 视为 Ctrl-C，杀进程树。返回 false 表示不支持写入。 */
export function writeSessionProcess(entry: ProcessEntry, chars: string): boolean {
	entry.lastUsedAt = Date.now();
	if (chars === "\u0003") {
		killSessionProcess(entry);
		return true;
	}
	if (!entry.acceptsStdin || !entry.child.stdin || entry.child.stdin.destroyed || entry.exitCode !== undefined) {
		return false;
	}
	entry.child.stdin.write(chars);
	return true;
}

export function killSessionProcess(entry: ProcessEntry): void {
	entry.lastUsedAt = Date.now();
	if (entry.exitCode !== undefined) return;
	entry.killed = true;
	if (entry.child.pid) killProcessTree(entry.child.pid);
}

/** 等待进程退出或在 yield 时限到点返回；退出时顺带等一拍让 exit 回调先落账。 */
export async function waitSessionProcess(entry: ProcessEntry, yieldMs: number): Promise<"running" | "exited"> {
	entry.lastUsedAt = Date.now();
	if (entry.exitCode !== undefined) return "exited";
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			entry.exitPromise.then(() => "exited" as const),
			new Promise<"running">((resolve) => {
				timer = setTimeout(() => resolve("running"), yieldMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	return entry.exitCode !== undefined ? "exited" : "running";
}

function pruneProcessesIfNeeded(): void {
	if (processes.size < MAX_PROCESSES) return;
	const entries = [...processes.values()];
	// 先清已退出的（最旧优先），再按 lastUsedAt 淘汰运行中的。
	const exited = entries.filter((e) => e.exitCode !== undefined).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	for (const entry of exited) {
		processes.delete(entry.id);
		if (processes.size < MAX_PROCESSES) return;
	}
	const running = entries
		.filter((e) => e.exitCode === undefined)
		.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	for (const entry of running) {
		killSessionProcess(entry);
		processes.delete(entry.id);
		if (processes.size < MAX_PROCESSES) return;
	}
}

/** 会话销毁（dispose）时清空属于该会话的所有进程。 */
export function terminateSessionProcesses(sessionId: string): void {
	for (const [id, entry] of processes) {
		if (entry.sessionId !== sessionId) continue;
		killSessionProcess(entry);
		processes.delete(id);
	}
}

/** 进程退出兜底：清空整张表。 */
export function terminateAllProcesses(): void {
	for (const [, entry] of processes) {
		killSessionProcess(entry);
	}
	processes.clear();
}
