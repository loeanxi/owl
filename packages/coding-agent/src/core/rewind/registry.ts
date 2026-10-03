/**
 * owl-rewind 的进程级单例接缝（与 question-channel / context-insight 同一套模式）：
 * 扩展（追踪钩子）与桌面桥（影响清单/还原）经这里拿到同一个会话追踪器实例。
 */
import { join } from "node:path";
import { SessionRewindTracker } from "./engine.ts";
import { RewindSnapshotStore } from "./store.ts";

export const REWIND_SNAPSHOT_DIR_NAME = "rewind-snapshots";

/** 单文件备份上限默认值：超过不追踪不备份（对齐 dsh-rewind 的「过大不存」）。 */
export const REWIND_DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export function rewindStoreDir(agentDir: string, sessionId: string): string {
	return join(agentDir, REWIND_SNAPSHOT_DIR_NAME, sessionId);
}

const trackers = new Map<string, SessionRewindTracker>();

/**
 * 取会话追踪器（每 sessionId 一个，进程内共享）。创建时自动续做半截还原日志
 * （崩溃安全：重放幂等）并顺带修剪旧锚点。
 */
export function getSessionRewindTracker(
	agentDir: string,
	sessionId: string,
	options?: { maxFileBytes?: number },
): SessionRewindTracker {
	let tracker = trackers.get(sessionId);
	if (!tracker) {
		tracker = new SessionRewindTracker({
			store: new RewindSnapshotStore(rewindStoreDir(agentDir, sessionId)),
			maxFileBytes: options?.maxFileBytes ?? REWIND_DEFAULT_MAX_FILE_BYTES,
		});
		trackers.set(sessionId, tracker);
		tracker.resumeInterruptedRestore();
		tracker.prune();
	}
	return tracker;
}

/** 会话卸载时丢弃内存实例（磁盘快照保留，下次挂载继续用）。 */
export function disposeSessionRewindTracker(sessionId: string): void {
	trackers.delete(sessionId);
}
