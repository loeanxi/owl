/**
 * 页面控制台证据台账。
 *
 * 与 BrowserNetworkJournal 同构：环形缓冲 + 单调序号 + since 增量查询，模型只需要
 * 学会一套「先读 lastSequence，再带着 since 读增量」的读法。控制台消息在入账时就
 * 脱敏——原始 token 不留在缓冲里，也不进模型上下文。
 */

import { redactSecrets } from "./browser-redaction.ts";

const MAX_ENTRIES = 200;
const MAX_LIST = 200;
/** 单条消息上限：超长文本（堆栈、巨型 JSON）只留头部并标 truncated。 */
const MAX_TEXT_CHARS = 2048;

export interface BrowserConsoleEntry {
	sequence: number;
	/** console 类型：log / info / warning / error / debug / pageerror 等。 */
	type: string;
	text: string;
	/** 原文超过上限，只保留了头部。 */
	truncated: boolean;
}

export interface BrowserConsoleListOptions {
	/** 只返回序号大于该值的消息（增量检查点）。 */
	since?: number;
	limit?: number;
	/** 只保留这些级别；warning 是 warn 的别名。 */
	levels?: string[];
	/** 大小写敏感的子串过滤，命中渲染后的文本。 */
	filter?: string;
}

export interface BrowserConsoleListResult {
	entries: BrowserConsoleEntry[];
	/** 下次带上这个序号即可只读新增。 */
	cursor: number;
	/** 本次已见的最大序号：直接拿它当下次的 since 就能只读增量。 */
	lastSequence: number;
	oldestSequence: number | null;
	/** 因超出环形上限被丢弃的条数。 */
	dropped: number;
	truncated: boolean;
	limits: { maxEntries: number; maxReturned: number; maxTextChars: number; redaction: string };
}

const LEVEL_ALIASES: Record<string, string> = { warning: "warn", warn: "warn" };

function bounded(value: number | undefined, fallback: number, maximum: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(Math.floor(value), maximum));
}

export class BrowserConsoleJournal {
	private readonly entries: BrowserConsoleEntry[] = [];
	private readonly maxEntries: number;
	private sequence = 0;
	private dropped = 0;

	constructor(options: { maxEntries?: number } = {}) {
		this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
	}

	push(type: string, text: string): void {
		const safe = redactSecrets(text);
		const truncated = safe.length > MAX_TEXT_CHARS;
		this.entries.push({
			sequence: ++this.sequence,
			type,
			text: truncated ? safe.slice(0, MAX_TEXT_CHARS) : safe,
			truncated,
		});
		while (this.entries.length > this.maxEntries) {
			this.entries.shift();
			this.dropped++;
		}
	}

	clear(): void {
		this.entries.length = 0;
	}

	list(options: BrowserConsoleListOptions = {}): BrowserConsoleListResult {
		const limit = bounded(options.limit, 50, MAX_LIST);
		const since = options.since === undefined || !Number.isFinite(options.since) ? 0 : Math.max(0, options.since);
		const levels = new Set(
			(options.levels ?? [])
				.map((level) => level.trim().toLowerCase())
				.filter((level) => level !== "")
				.map((level) => LEVEL_ALIASES[level] ?? level),
		);
		const filter = options.filter;
		const matches = this.entries.filter((entry) => {
			if (entry.sequence <= since) return false;
			if (levels.size > 0) {
				const raw = entry.type.toLowerCase();
				if (!levels.has(raw) && !levels.has(LEVEL_ALIASES[raw] ?? raw)) return false;
			}
			if (filter !== undefined && filter !== "" && !entry.text.includes(filter)) return false;
			return true;
		});
		const entries = matches.slice(0, limit).map((entry) => ({ ...entry }));
		const truncated = matches.length > limit;
		return {
			entries,
			cursor: truncated ? entries[entries.length - 1].sequence : Math.max(this.sequence, since),
			// 本次已见的最大序号：直接拿它当下次的 since 就能只读增量。
			lastSequence: this.sequence,
			oldestSequence: this.entries[0]?.sequence ?? null,
			dropped: this.dropped,
			truncated,
			limits: {
				maxEntries: this.maxEntries,
				maxReturned: limit,
				maxTextChars: MAX_TEXT_CHARS,
				redaction: "known_secret_fields",
			},
		};
	}
}
