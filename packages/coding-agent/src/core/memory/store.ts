/**
 * owl 跨会话记忆存储（设计对标 Codex memories，简化版；治理层设计借鉴 hindsight）。
 *
 * 数据落 `<agentDir>/memories/`：
 * - `entries.json` —— 唯一事实源：结构化记忆条目（id/内容/来源会话/时间/证据计数/作用域）。
 *   设置页和 /memory 展示的就是它，用户能确切看到"哪些记忆在跨会话生效"。
 * - `MEMORY.md` —— 由 entries 机械投影出的可读视图；文件头注明手工编辑请走设置页。
 * - `extracted.json` —— 已抽取过的会话文件标记（mtime），避免重复抽取。
 *
 * 治理规则（借鉴 hindsight，全部本地零依赖）：
 * - **证据强化**：同一内容再次出现 → proofCount+1（精炼不覆盖），近似重复由归并流水线
 *   （extract.ts consolidateMemories）交给模型判合。
 * - **作用域**（banks 的本地化）：`scope: "project"` 的条目只注入 sourceCwd 匹配的会话；
 *   `scope: "global"`（用户偏好、环境特点）跨项目注入。
 * - **预算化注入**：注入按 项目匹配 > proofCount > 新近度 排序，装满字符预算即止，
 *   剩余提示模型用 recall 工具按需查询。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OwlMemoryEntry {
	id: string;
	content: string;
	/** 来源会话（文件绝对路径），手工保存的条目没有。 */
	sourceSession?: string;
	/** 来源会话所属项目 cwd。 */
	sourceCwd?: string;
	/** 作用域：project = 只注入来源项目的会话；global = 跨项目注入（用户偏好等）。 */
	scope?: "project" | "global";
	/** 证据计数：同一/同类记忆每次被再次观察到就 +1（hindsight observations 的本地化）。 */
	proofCount?: number;
	/** ISO 时间（首次记录）。 */
	createdAt: string;
}

interface MemoryFile {
	version: 1;
	entries: OwlMemoryEntry[];
}

/** 注入 system prompt 的记忆内容预算（字符）。 */
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

/** Windows/POSIX 路径归一比较（大小写与分隔符不敏感）。 */
export function normalizeCwd(path: string | undefined): string {
	return (path ?? "").replace(/[/\\]+/g, "/").replace(/\/$/, "").toLowerCase();
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
							...(entry.scope === "global" || entry.scope === "project" ? { scope: entry.scope } : {}),
							...(typeof entry.proofCount === "number" && entry.proofCount > 1 ? { proofCount: entry.proofCount } : {}),
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

/**
 * 追加记忆条目。完全相同的内容视为再次观察到的同一信念：proofCount+1（强化）而不是
 * 新增或忽略；真正的新条目受上限约束并按来源标记 scope（有项目来源 → project，
 * 否则 → global）。
 */
export function appendMemoryEntries(
	agentDir: string,
	entries: Array<Pick<OwlMemoryEntry, "content"> & Partial<OwlMemoryEntry>>,
): { added: OwlMemoryEntry[]; strengthened: number } {
	const data = readMemoryFile(agentDir);
	const added: OwlMemoryEntry[] = [];
	let strengthened = 0;
	for (const entry of entries) {
		const content = entry.content.trim();
		if (!content) continue;
		const existing = data.entries.find((candidate) => candidate.content === content);
		if (existing) {
			existing.proofCount = (existing.proofCount ?? 1) + 1;
			strengthened++;
			continue;
		}
		if (data.entries.length >= MEMORY_MAX_ENTRIES) break;
		const sourceCwd = entry.sourceCwd;
		const scope: "project" | "global" =
			entry.scope === "global" || entry.scope === "project" ? entry.scope : sourceCwd ? "project" : "global";
		const full: OwlMemoryEntry = {
			id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			content,
			...(entry.sourceSession ? { sourceSession: entry.sourceSession } : {}),
			...(sourceCwd ? { sourceCwd } : {}),
			scope,
			createdAt: entry.createdAt ?? new Date().toISOString(),
		};
		data.entries.push(full);
		added.push(full);
	}
	if (added.length > 0 || strengthened > 0) writeMemoryFile(agentDir, data);
	return { added, strengthened };
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

/** 归并指令：把 mergeIds 的条目并进 intoId，内容用合并后的文本。 */
export interface MemoryMerge {
	intoId: string;
	mergeIds: string[];
	content: string;
}

/** 应用归并流水线的判定结果：目标条目改为合并内容、证据计数累加，被并条目删除。 */
export function applyMemoryMerges(agentDir: string, merges: MemoryMerge[]): number {
	if (merges.length === 0) return 0;
	const data = readMemoryFile(agentDir);
	let applied = 0;
	for (const merge of merges) {
		const target = data.entries.find((entry) => entry.id === merge.intoId);
		if (!target) continue;
		const sources = merge.mergeIds
			.filter((id) => id !== merge.intoId)
			.map((id) => data.entries.find((entry) => entry.id === id))
			.filter((entry): entry is OwlMemoryEntry => Boolean(entry));
		if (sources.length === 0) continue;
		const content = merge.content.trim();
		if (!content) continue;
		target.content = content;
		target.proofCount = (target.proofCount ?? 1) + sources.reduce((sum, entry) => sum + (entry.proofCount ?? 1), 0);
		// 合并后的作用域取更宽的一档：出现过 global 语义的证据就按 global 对待
		if (sources.some((entry) => entry.scope === "global") || target.scope === "global") target.scope = "global";
		const mergedIds = new Set(sources.map((entry) => entry.id));
		data.entries = data.entries.filter((entry) => !mergedIds.has(entry.id));
		applied++;
	}
	if (applied > 0) writeMemoryFile(agentDir, data);
	return applied;
}

/** 把 entries 机械投影成 MEMORY.md（人可读视图，含全部项目）。 */
function renderMemoryMarkdown(agentDir: string, entries: OwlMemoryEntry[]): void {
	const lines: string[] = [
		"# Owl 跨会话记忆",
		"",
		"<!-- 此文件由 Owl 自动生成（entries.json 的投影）。增删请用桌面设置页「跨会话记忆」或 TUI /memory 命令。 -->",
		"",
	];
	for (const entry of entries) {
		const date = entry.createdAt.slice(0, 10);
		const proofs = (entry.proofCount ?? 1) > 1 ? ` ×${entry.proofCount}` : "";
		const scope = entry.scope === "global" ? " · 全局" : entry.sourceCwd ? ` · ${entry.sourceCwd}` : "";
		lines.push(`- ${entry.content} （${date}${proofs}${scope}）`);
	}
	const path = join(getMemoryDir(agentDir), "MEMORY.md");
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

/**
 * 注入候选：当前项目的条目 + 全局条目（其它项目的记忆不进上下文）。
 * 无来源的旧条目按全局对待（宁多勿漏，用户可在设置页删）。
 */
export function injectionCandidates(entries: OwlMemoryEntry[], cwd: string): { included: OwlMemoryEntry[]; excluded: number } {
	const currentCwd = normalizeCwd(cwd);
	const included = entries.filter(
		(entry) =>
			entry.scope === "global" ||
			!entry.sourceCwd ||
			(normalizeCwd(entry.sourceCwd) === currentCwd && currentCwd !== ""),
	);
	return { included, excluded: entries.length - included.length };
}

/**
 * 注入排序：项目匹配 > proofCount > 新近度（hindsight recall 的排序理念，零依赖版）。
 * 项目条目整体排在全局条目之前。
 */
export function rankEntriesForInjection(entries: OwlMemoryEntry[], cwd: string): OwlMemoryEntry[] {
	const currentCwd = normalizeCwd(cwd);
	return [...entries].sort((a, b) => {
		const projectA = a.scope === "global" || !a.sourceCwd ? 1 : 0;
		const projectB = b.scope === "global" || !b.sourceCwd ? 1 : 0;
		const matchA = a.sourceCwd && normalizeCwd(a.sourceCwd) === currentCwd ? 0 : projectA;
		const matchB = b.sourceCwd && normalizeCwd(b.sourceCwd) === currentCwd ? 0 : projectB;
		if (matchA !== matchB) return matchA - matchB;
		const proofA = a.proofCount ?? 1;
		const proofB = b.proofCount ?? 1;
		if (proofA !== proofB) return proofB - proofA;
		return b.createdAt.localeCompare(a.createdAt);
	});
}

/**
 * 渲染注入 system prompt 的记忆分区：过滤（项目 + 全局）→ 排序 → 装满预算即止，
 * 剩余条数在尾部提示（引导模型用 recall 工具）。带 mtime+cwd 缓存。
 */
let sectionCache: { path: string; mtimeMs: number; cwd: string; text: string } | undefined;

export function renderMemorySection(agentDir: string, cwd: string): string {
	const path = memoryFile(agentDir);
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return "";
	}
	if (sectionCache && sectionCache.path === path && sectionCache.mtimeMs === mtimeMs && sectionCache.cwd === cwd) {
		return sectionCache.text;
	}
	const { included, excluded } = injectionCandidates(readMemoryEntries(agentDir), cwd);
	if (included.length === 0) {
		sectionCache = { path, mtimeMs, cwd, text: "" };
		return "";
	}
	const ranked = rankEntriesForInjection(included, cwd);
	const lines: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const entry of ranked) {
		const proofs = (entry.proofCount ?? 1) > 1 ? `（已验证 ×${entry.proofCount}）` : "";
		const line = `- ${entry.content}${proofs}`;
		const size = Buffer.byteLength(line, "utf-8") + 1;
		if (used + size > MEMORY_SECTION_MAX_CHARS) {
			omitted = ranked.length - lines.length;
			break;
		}
		lines.push(line);
		used += size;
	}
	if (lines.length === 0) {
		sectionCache = { path, mtimeMs, cwd, text: "" };
		return "";
	}
	const header = "跨会话记忆（此前会话沉淀的稳定事实；与当前工作冲突时以当前项目实际状态为准）：";
	const footer = omitted > 0 ? `\n（另有 ${omitted} 条相关记忆未注入，需要时可用 recall 工具按关键词查询）` : "";
	const text = `${header}\n${lines.join("\n")}${footer}`;
	sectionCache = { path, mtimeMs, cwd, text };
	return text;
}

// ---------------------------------------------------------------------------
// 按需检索（recall 工具的数据面；hindsight recall 的理念、词面匹配的零依赖实现）
// ---------------------------------------------------------------------------

export interface MemorySearchHit {
	entry: OwlMemoryEntry;
	score: number;
}

/**
 * 词面检索：query 按空白拆词（≥2 字符），按命中词数打分；再按 proofCount/新近度决胜。
 * query 为空时返回最近的条目（浏览语义）。搜索范围与注入一致（当前项目 + 全局）。
 */
export function searchMemoryEntries(
	agentDir: string,
	cwd: string,
	query: string,
	limit = 10,
): MemorySearchHit[] {
	const { included } = injectionCandidates(readMemoryEntries(agentDir), cwd);
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2);
	const scored = included.map((entry) => {
		const content = entry.content.toLowerCase();
		let score = terms.reduce((sum, term) => (content.includes(term) ? sum + 1 : sum), 0);
		if (terms.length > 0 && score === 0) score = -1; // 有查询词但没命中：排除
		return { entry, score };
	});
	const hits = scored
		.filter(({ score }) => score >= 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const proofA = a.entry.proofCount ?? 1;
			const proofB = b.entry.proofCount ?? 1;
			if (proofB !== proofA) return proofB - proofA;
			return b.entry.createdAt.localeCompare(a.entry.createdAt);
		});
	return hits.slice(0, limit);
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
