/**
 * 会话压缩状态持久化 — 参照 billion-context-pi src/state.ts（MIT）简化。
 *
 * 状态以 sidecar 文件存放在会话文件旁：`<sessionFile>.acp.json`（与上游
 * billion-context-pi 同一套约定，将来两侧状态可互通）。进程内按会话缓存。
 *
 * 相比上游去掉：父会话状态继承、live-ref 迁移（owl 为 pi 原生宿主，
 * context 事件时条目已持久化，无需合并未持久化尾部）、派生子会话。
 */
import { promises as fs } from "node:fs";
import { createInitialState, type CompressionState } from "./kernel.js";

export const STATE_SUFFIX = ".acp.json";
const SCHEMA_VERSION = 1;
const PRODUCER = "owl-billion-context";

interface StateCacheSlot {
	state: CompressionState;
}

function stateFileFor(sessionFile: string | undefined): string | null {
	if (sessionFile) return sessionFile + STATE_SUFFIX;
	return null;
}

function cacheKey(sessionFile: string | undefined, sessionId: string): string {
	return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

export class SessionStateStore {
	private cache = new Map<string, StateCacheSlot>();

	async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
		const file = stateFileFor(sessionFile);
		const key = cacheKey(sessionFile, sessionId);
		const cached = this.cache.get(key);
		if (cached) return cached.state;
		let state = createInitialState();
		if (file) {
			try {
				const raw = await fs.readFile(file, "utf8");
				const parsed = JSON.parse(raw) as CompressionState & { schemaVersion?: unknown; producer?: unknown };
				if (parsed && Array.isArray(parsed.blocks)) {
					// 更新的 schemaVersion 说明是未来版本的写入方：尽力读取，
					// 只按 v1 字段理解，绝不重写不认识的结构。
					state = parsed;
				}
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") {
					console.warn(`[owl-billion-context] state load failed (${file}): ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
		this.cache.set(key, { state });
		return state;
	}

	async save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void> {
		const file = stateFileFor(sessionFile);
		const key = cacheKey(sessionFile, sessionId);
		this.cache.set(key, { state });
		if (!file) return;
		const payload = { ...state, schemaVersion: SCHEMA_VERSION, producer: PRODUCER };
		try {
			await fs.writeFile(file, JSON.stringify(payload, null, "\t"), { encoding: "utf8", mode: 0o600 });
		} catch (e) {
			console.warn(`[owl-billion-context] state save failed (${file}): ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** 会话切换/关闭时丢弃缓存槽，防止跨会话串状态。 */
	drop(sessionFile: string | undefined, sessionId: string): void {
		this.cache.delete(cacheKey(sessionFile, sessionId));
	}
}
