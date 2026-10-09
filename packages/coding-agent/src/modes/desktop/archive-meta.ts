/**
 * 会话归档元数据：侧边栏归档标记与过期巡检共用。
 * 记在 <agentDir>/Owl-history/archive.json，不写进会话 JSONL。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../utils/atomic-file.ts";

export interface ArchiveMetaEntry {
	archivedAt: string;
	/** 归档时定位到的 JSONL 路径（巡检优先用它，找不到再按 id 全盘搜索）。 */
	path?: string;
}

export interface ArchiveMetaFile {
	retentionDays?: number;
	sessions?: Record<string, ArchiveMetaEntry>;
}

export const DEFAULT_ARCHIVE_RETENTION_DAYS = 15;
/** 巡检间隔：1 小时（保留期以天为单位，小时级精度足够）。 */
export const ARCHIVE_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export function archiveMetaPath(agentDir: string): string {
	return join(agentDir, "Owl-history", "archive.json");
}

export function readArchiveMeta(agentDir: string): ArchiveMetaFile {
	try {
		const parsed = JSON.parse(readFileSync(archiveMetaPath(agentDir), "utf-8")) as ArchiveMetaFile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function writeArchiveMeta(agentDir: string, meta: ArchiveMetaFile): void {
	atomicWriteFileSync(archiveMetaPath(agentDir), `${JSON.stringify(meta, null, 2)}\n`);
}

export function archiveRetentionDays(meta: ArchiveMetaFile): number {
	const value = meta.retentionDays;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_ARCHIVE_RETENTION_DAYS;
}
