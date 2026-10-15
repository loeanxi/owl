/**
 * 会话归档元数据：归档只收起会话，保留到用户主动删除。
 * 记在 <agentDir>/Owl-history/archive.json，不写进会话 JSONL。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../utils/atomic-file.ts";

export interface ArchiveMetaEntry {
	archivedAt: string;
	/** 归档时定位到的 JSONL 路径；保留旧归档的来源信息。 */
	path?: string;
}

export interface ArchiveMetaFile {
	sessions?: Record<string, ArchiveMetaEntry>;
}

export function archiveMetaPath(agentDir: string): string {
	return join(agentDir, "Owl-history", "archive.json");
}

export function readArchiveMeta(agentDir: string): ArchiveMetaFile {
	try {
		const parsed = JSON.parse(readFileSync(archiveMetaPath(agentDir), "utf-8")) as ArchiveMetaFile;
		// 旧 retentionDays 配置不再生效，后续归档/恢复写回时一并移除。
		return parsed && typeof parsed === "object" ? { sessions: parsed.sessions } : {};
	} catch {
		return {};
	}
}

export function writeArchiveMeta(agentDir: string, meta: ArchiveMetaFile): void {
	atomicWriteFileSync(archiveMetaPath(agentDir), `${JSON.stringify(meta, null, 2)}\n`);
}
