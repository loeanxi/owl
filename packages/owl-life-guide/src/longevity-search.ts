/**
 * 《程序员延寿指南》的检索与排版（纯函数）：关键词分词 AND、小节过滤、
 * 计分排序、面向 LLM 的文本输出。
 */

import { LONGEVITY_REPO_URL, type LongevityEntry } from "./longevity-source.ts";

export interface LongevityQuery {
	/** 空格分词，词与词 AND 匹配；空串表示不过滤（配合 section 浏览）。 */
	query: string;
	/** 小节过滤：按子串匹配小节号或小节名（如 "6.2" / "液体" / "睡眠"）。 */
	section?: string;
	/** 命中后展示的条数上限。 */
	limit: number;
}

export interface LongevityHit {
	entry: LongevityEntry;
	score: number;
}

/** 单条检索域：主题名权重最高，小节次之，明细与链接文本递减。 */
const FIELDS: Array<{ get: (entry: LongevityEntry) => string; weight: number }> = [
	{ get: (entry) => entry.name, weight: 6 },
	{ get: (entry) => entry.section, weight: 3 },
	{ get: (entry) => entry.details.join(" "), weight: 2 },
	{ get: (entry) => entry.links.map((link) => link.text).join(" "), weight: 1 },
];

function occurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function sectionOrder(sectionNo: string): number {
	const [major = 0, middle = 0, minor = 0] = sectionNo.split(".").map((part) => Number(part) || 0);
	return major * 1_000_000 + middle * 1_000 + minor;
}

export function searchLongevity(
	entries: LongevityEntry[],
	query: LongevityQuery,
): { hits: LongevityHit[]; matched: number } {
	const terms = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const sectionNeedle = query.section?.trim().toLowerCase() ?? "";
	const filtered = entries.filter((entry) => {
		if (!sectionNeedle) return true;
		return (
			entry.section.toLowerCase().includes(sectionNeedle) || entry.sectionNo.toLowerCase().startsWith(sectionNeedle)
		);
	});

	const hits: LongevityHit[] = [];
	for (const entry of filtered) {
		if (terms.length === 0) {
			hits.push({ entry, score: 0 });
			continue;
		}
		let score = 0;
		let allMatched = true;
		for (const term of terms) {
			let termScore = 0;
			for (const field of FIELDS) {
				const count = occurrences(field.get(entry).toLowerCase(), term);
				if (count > 0) termScore += count * field.weight;
			}
			if (termScore === 0) {
				allMatched = false;
				break;
			}
			score += termScore;
		}
		if (allMatched) hits.push({ entry, score });
	}

	hits.sort((a, b) => b.score - a.score || sectionOrder(a.entry.sectionNo) - sectionOrder(b.entry.sectionNo));
	return { hits, matched: hits.length };
}

// ---------------------------------------------------------------------------
// 输出排版
// ---------------------------------------------------------------------------

const DETAIL_TRUNCATE_DEFAULT = 220;
const DETAIL_TRUNCATE_FULL = 600;
const DEFAULT_DETAIL_LINES = 3;
const DEFAULT_LINK_LINES = 2;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}……（截断，原文 ${text.length} 字）` : text;
}

function snapshotLine(snapshot: { savedAt?: string; complete: boolean }): string {
	return snapshot.savedAt
		? `本地快照 ${snapshot.savedAt}`
		: snapshot.complete
			? "本地快照（日期未知）"
			: "本地快照不完整";
}

function detailsLines(entry: LongevityEntry, full: boolean): string[] {
	const max = full ? entry.details.length : Math.min(entry.details.length, DEFAULT_DETAIL_LINES);
	const lines = entry.details
		.slice(0, max)
		.map((detail) => `· ${truncate(detail, full ? DETAIL_TRUNCATE_FULL : DETAIL_TRUNCATE_DEFAULT)}`);
	if (!full && entry.details.length > max) {
		lines.push(`· ……另有 ${entry.details.length - max} 条明细，full=true 展开`);
	}
	return lines;
}

function linkLines(entry: LongevityEntry, full: boolean): string[] {
	const max = full ? entry.links.length : Math.min(entry.links.length, DEFAULT_LINK_LINES);
	const lines = entry.links.slice(0, max).map((link) => `链接：${link.text} <${link.url}>`);
	if (!full && entry.links.length > max) {
		lines.push(`链接：……另有 ${entry.links.length - max} 条，full=true 展开`);
	}
	return lines;
}

export function formatLongevityEntry(hit: LongevityHit, options: { full: boolean }): string {
	const { entry } = hit;
	const lines = [`〔${entry.key}〕${entry.name} ｜ ${entry.section}${entry.disputed ? " ｜ 存在争议" : ""}`];
	lines.push(...detailsLines(entry, options.full));
	lines.push(...linkLines(entry, options.full));
	return lines.join("\n");
}

function disputedCount(entries: LongevityEntry[]): number {
	return entries.filter((entry) => entry.disputed).length;
}

function sectionCount(entries: LongevityEntry[]): number {
	return new Set(entries.map((entry) => entry.sectionNo)).size;
}

const USAGE_HINT =
	'可加关键词（空格分词 AND），或限定小节 section（如 "6.2" / "液体"）、单条 key（如 "6.1.2/牛奶"）、full=true 展开全部明细与链接。';

/** 检索结果文本；头部带命中统计与快照日期，让模型能向用户转述新鲜度。 */
export function formatLongevityResults(
	entries: LongevityEntry[],
	hits: LongevityHit[],
	matched: number,
	snapshot: { savedAt?: string; complete: boolean },
	limit: number,
	full: boolean,
): string {
	const shown = hits.slice(0, limit);
	const head = `《程序员延寿指南》命中 ${matched} 条，显示前 ${shown.length} 条（全书 ${entries.length} 条 / ${sectionCount(entries)} 个小节；争议标记 ${disputedCount(entries)} 条；${snapshotLine(snapshot)}；来源 geekan/HowToLiveLonger，Unlicense）`;
	const body = shown.map((hit) => formatLongevityEntry(hit, { full })).join("\n\n");
	return `${head}\n\n${body}\n\n（条目 key 形如 ${shown[0]?.entry.key ?? "6.1.2/牛奶"}，用 key 参数可取单条全文；上游研究多为相关性证据，引用时如实转述。）`;
}

/** 单条全文（key 精确命中）。 */
export function formatLongevitySingle(
	entry: LongevityEntry,
	snapshot: { savedAt?: string; complete: boolean },
): string {
	return `${formatLongevityEntry({ entry, score: 0 }, { full: true })}\n\n（${snapshotLine(snapshot)}；原文：${LONGEVITY_REPO_URL}）`;
}

/** 无参数时的全书概览：小节目录 + 条数 + 用法提示。 */
export function formatLongevityOverview(
	entries: LongevityEntry[],
	snapshot: { savedAt?: string; complete: boolean },
): string {
	const sections = new Map<string, number>();
	for (const entry of entries) sections.set(entry.section, (sections.get(entry.section) ?? 0) + 1);
	const lines = [...sections.entries()].map(([name, count]) => `${name}（${count} 条）`);
	return [
		`《程序员延寿指南》全书概览（${entries.length} 条 / ${sections.size} 个小节；争议标记 ${disputedCount(entries)} 条；${snapshotLine(snapshot)}；来源 geekan/HowToLiveLonger，Unlicense）`,
		"",
		...lines,
		"",
		USAGE_HINT,
	].join("\n");
}

/** 检索全空时的提示文本：只给改写建议，不列小节目录（overview 职责）。 */
export function formatLongevityNoMatches(query: LongevityQuery): string {
	const parts: string[] = [];
	if (query.query) parts.push(`关键词「${query.query}」`);
	if (query.section) parts.push(`小节「${query.section}」`);
	return `未命中（${parts.join(" + ") || "空查询"}）。中文按子串匹配：换更短的词（如「睡」「红肉」），或去掉 section 过滤；无参数调用可看小节目录。${USAGE_HINT}`;
}
