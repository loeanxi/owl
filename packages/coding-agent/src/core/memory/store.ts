/**
 * owl 跨会话记忆存储（设计对标 Codex memories，简化版）。
 *
 * 数据落 `<agentDir>/memories/`：
 * - `entries.json` —— 唯一事实源：结构化记忆条目（id/内容/来源会话/时间）。
 *   设置页和 /memory 展示的就是它，用户能确切看到"哪些记忆在跨会话生效"。
 * - `MEMORY.md` —— 由 entries 机械投影出的可读视图，同时是注入 system prompt 的
 *   内容来源；文件头注明手工编辑请走设置页。
 * - `extracted.json` —— 已抽取过的会话文件标记（mtime），避免重复抽取。
 *
 * 与 serve.ts 的 `owlUserImpression`（对用户的主观印象，自由文本）互补：
 * owl-memory 是结构化的、逐条可见可删的客观记忆。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truncateMiddle } from "../tools/truncate.ts";

export interface OwlMemoryEntry {
	id: string;
	content: string;
	/** 来源会话（文件绝对路径），手工保存的条目没有。 */
	sourceSession?: string;
	/** 来源会话所属项目 cwd。 */
	sourceCwd?: string;
	/** ISO 时间。 */
	createdAt: string;
}

interface MemoryFile {
	version: 1;
	entries: OwlMemoryEntry[];
}

/** 注入 system prompt 的记忆内容上限（字符）。 */
export const MEMORY_SECTION_MAX_CHARS = 8000;
/** entries 总量软上限：超出时拒绝新增，提示用户清理。 */
export const MEMORY_MAX_ENTRIES = 200;

export function getMemoryDir(agentDir: string): string {
	return join(agentDir, "memories");
}

function memoryFile(agentDir: string): string {
	return join(getMemoryDir(agentDir), "entries.json");
}

function extractedFile(agentDir: string): string {
	return join(getMemoryDir(agentDir), "extracted.json");
}

let cache: { path: string; mtimeMs: number; data: MemoryFile } | undefined;

function readMemoryFile(agentDir: string): MemoryFile {
	const path = memoryFile(agentDir);
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return { version: 1, entries: [] };
	}
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.data;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<MemoryFile>;
		const data: MemoryFile = {
			version: 1,
			entries: Array.isArray(raw.entries)
				? raw.entries
						.filter((entry) => entry && typeof entry.id === "string" && typeof entry.content === "string")
						.map((entry) => ({
							id: entry.id,
							content: entry.content,
							...(entry.sourceSession ? { sourceSession: entry.sourceSession } : {}),
							...(entry.sourceCwd ? { sourceCwd: entry.sourceCwd } : {}),
							createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
						}))
				: [],
		};
		cache = { path, mtimeMs, data };
		return data;
	} catch {
		return { version: 1, entries: [] };
	}
}

function writeMemoryFile(agentDir: string, data: MemoryFile): void {
	const dir = getMemoryDir(agentDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const path = memoryFile(agentDir);
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`, "utf-8");
	cache = { path, mtimeMs: statSync(path).mtimeMs, data };
	renderMemoryMarkdown(agentDir, data.entries);
}

export function readMemoryEntries(agentDir: string): OwlMemoryEntry[] {
	return readMemoryFile(agentDir).entries;
}

export function appendMemoryEntries(
	agentDir: string,
	entries: Array<Pick<OwlMemoryEntry, "content"> & Partial<OwlMemoryEntry>>,
): OwlMemoryEntry[] {
	const data = readMemoryFile(agentDir);
	const added: OwlMemoryEntry[] = [];
	for (const entry of entries) {
		const content = entry.content.trim();
		if (!content) continue;
		if (data.entries.some((existing) => existing.content === content)) continue; // 去重
		if (data.entries.length >= MEMORY_MAX_ENTRIES) break;
		const full: OwlMemoryEntry = {
			id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			content,
			...(entry.sourceSession ? { sourceSession: entry.sourceSession } : {}),
			...(entry.sourceCwd ? { sourceCwd: entry.sourceCwd } : {}),
			createdAt: entry.createdAt ?? new Date().toISOString(),
		};
		data.entries.push(full);
		added.push(full);
	}
	if (added.length > 0) writeMemoryFile(agentDir, data);
	return added;
}

export function deleteMemoryEntry(agentDir: string, id: string): boolean {
	const data = readMemoryFile(agentDir);
	const index = data.entries.findIndex((entry) => entry.id === id);
	if (index === -1) return false;
	data.entries.splice(index, 1);
	writeMemoryFile(agentDir, data);
	return true;
}

export function clearMemoryEntries(agentDir: string): void {
	writeMemoryFile(agentDir, { version: 1, entries: [] });
}

/** 把 entries 机械投影成 MEMORY.md（人可读 + prompt 注入同源）。 */
function renderMemoryMarkdown(agentDir: string, entries: OwlMemoryEntry[]): void {
	const lines: string[] = [
		"# Owl 跨会话记忆",
		"",
		"<!-- 此文件由 Owl 自动生成（entries.json 的投影）。增删请用桌面设置页「跨会话记忆」或 TUI /memory 命令。 -->",
		"",
	];
	for (const entry of entries) {
		const date = entry.createdAt.slice(0, 10);
		const source = entry.sourceCwd ? ` · ${entry.sourceCwd}` : "";
		lines.push(`- ${entry.content} （${date}${source}）`);
	}
	const path = join(getMemoryDir(agentDir), "MEMORY.md");
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

/** 渲染注入 system prompt 的记忆分区内容（带 mtime 缓存）。 */
let sectionCache: { path: string; mtimeMs: number; text: string } | undefined;

export function renderMemorySection(agentDir: string): string {
	const path = join(getMemoryDir(agentDir), "MEMORY.md");
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return "";
	}
	if (sectionCache && sectionCache.path === path && sectionCache.mtimeMs === mtimeMs) return sectionCache.text;
	let text = "";
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return "";
	}
	// 去掉投影文件里对模型无意义的管理性注释与标题
	text = text
		.split("\n")
		.filter((line) => !line.startsWith("<!--") && !line.startsWith("# "))
		.join("\n")
		.trim();
	if (text) text = truncateMiddle(text, MEMORY_SECTION_MAX_CHARS).content;
	sectionCache = { path, mtimeMs, text };
	return text;
}

// ---------------------------------------------------------------------------
// 抽取进度标记
// ---------------------------------------------------------------------------

export function readExtractedMarkers(agentDir: string): Record<string, number> {
	try {
		return JSON.parse(readFileSync(extractedFile(agentDir), "utf-8")) as Record<string, number>;
	} catch {
		return {};
	}
}

export function markExtracted(agentDir: string, sessionFilePaths: string[]): void {
	const dir = getMemoryDir(agentDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const markers = readExtractedMarkers(agentDir);
	const now = Date.now();
	for (const path of sessionFilePaths) markers[path] = now;
	// 标记文件按 5000 条裁剪，防无限膨胀
	const trimmed = Object.entries(markers)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5000);
	writeFileSync(extractedFile(agentDir), `${JSON.stringify(Object.fromEntries(trimmed), null, "\t")}\n`, "utf-8");
}

/** 供测试与记忆卡片展示：读取记忆目录的文件清单。 */
export function memoryDirExists(agentDir: string): boolean {
	return existsSync(getMemoryDir(agentDir));
}

/** 清空记忆（含抽取标记），设置页「清空全部」用。 */
export function resetMemoryStorage(agentDir: string): void {
	const dir = getMemoryDir(agentDir);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	cache = undefined;
	sectionCache = undefined;
}
