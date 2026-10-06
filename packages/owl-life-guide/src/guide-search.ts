/**
 * 检索与排版（纯函数，便于测试）：关键词分词 AND 匹配、证据等级/章节过滤、
 * 加权计分排序、面向 LLM 的文本输出。
 */

import { GUIDE_REPO_URL, type GuideChapter, type GuideTip } from "./guide-source.ts";

export type GradeFilter = "A" | "B" | "C" | "disputed";

export interface GuideQuery {
	/** 空格分词，词与词 AND 匹配；空串表示不过滤（配合 chapter/grade 浏览）。 */
	query: string;
	chapter?: number;
	grade?: GradeFilter;
	/** 命中后展示的条数上限。 */
	limit: number;
}

export interface GuideHit {
	chapter: GuideChapter;
	tip: GuideTip;
	score: number;
}

/** 单条检索域：标题权重最高，标签/章名次之，正文按字段递减。 */
const FIELDS: Array<{ get: (hit: { tip: GuideTip; chapter: GuideChapter }) => string; weight: number }> = [
	{ get: (h) => h.tip.title, weight: 6 },
	{ get: (h) => h.tip.tags.map((t) => `${t.k}${t.v}`).join(" "), weight: 4 },
	{ get: (h) => h.chapter.title, weight: 3 },
	{ get: (h) => h.tip.plain, weight: 2 },
	{ get: (h) => h.tip.benefit, weight: 2 },
	{ get: (h) => h.tip.cost, weight: 1 },
	{ get: (h) => h.tip.remark, weight: 1 },
	{ get: (h) => h.tip.sources, weight: 1 },
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

const GRADE_RANK: Record<GuideTip["grade"], number> = { A: 0, B: 1, C: 2 };

function keyOrder(key: string): number {
	const [chapter, no] = key.split(".").map((part) => Number(part) || 0);
	return chapter * 10_000 + no;
}

/** 全部平铺成 (chapter, tip) 对，章号过滤提前做。 */
export function flattenChapters(chapters: GuideChapter[]): Array<{ chapter: GuideChapter; tip: GuideTip }> {
	const flat: Array<{ chapter: GuideChapter; tip: GuideTip }> = [];
	for (const chapter of chapters) {
		for (const tip of chapter.tips) flat.push({ chapter, tip });
	}
	return flat;
}

export function searchGuide(chapters: GuideChapter[], query: GuideQuery): { hits: GuideHit[]; matched: number } {
	const terms = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const flat = flattenChapters(chapters).filter(({ chapter }) => !query.chapter || chapter.no === query.chapter);
	const filtered = flat.filter(({ tip }) => {
		if (query.grade === "disputed") return tip.disputed;
		if (query.grade) return tip.grade === query.grade;
		return true;
	});

	const hits: GuideHit[] = [];
	for (const entry of filtered) {
		if (terms.length > 0) {
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
			if (!allMatched) continue;
			hits.push({ ...entry, score });
		} else {
			hits.push({ ...entry, score: 0 });
		}
	}

	hits.sort(
		(a, b) =>
			b.score - a.score ||
			GRADE_RANK[a.tip.grade] - GRADE_RANK[b.tip.grade] ||
			keyOrder(a.tip.key) - keyOrder(b.tip.key),
	);
	return { hits, matched: hits.length };
}

// ---------------------------------------------------------------------------
// 输出排版
// ---------------------------------------------------------------------------

const FIELD_TRUNCATE = 600;

/** 超长字段截断，保 LLM 上下文；截断处明确标注。 */
function truncate(text: string, max = FIELD_TRUNCATE): string {
	return text.length > max ? `${text.slice(0, max)}……（截断，原文 ${text.length} 字）` : text;
}

export function chapterCounts(chapters: GuideChapter[]): {
	total: number;
	a: number;
	b: number;
	c: number;
	disputed: number;
} {
	let total = 0;
	let a = 0;
	let b = 0;
	let c = 0;
	let disputed = 0;
	for (const chapter of chapters) {
		for (const tip of chapter.tips) {
			total += 1;
			if (tip.grade === "A") a += 1;
			else if (tip.grade === "B") b += 1;
			else c += 1;
			if (tip.disputed) disputed += 1;
		}
	}
	return { total, a, b, c, disputed };
}

function tagsLine(tip: GuideTip): string {
	return tip.tags.map((t) => `${t.k} ${t.v}`).join(" · ");
}

export function formatTip(hit: GuideHit, options: { full: boolean }): string {
	const { tip, chapter } = hit;
	const lines: string[] = [];
	lines.push(
		`〔${tip.key}〕${tip.title} ｜ 证据等级 ${tip.grade}${tip.disputed ? "（争议）" : ""} ｜ 第 ${chapter.no} 章「${chapter.title}」`,
	);
	if (tagsLine(tip)) lines.push(`标签：${tagsLine(tip)}`);
	if (tip.plain) lines.push(`说人话：${tip.plain}`);
	if (options.full) {
		if (tip.cost) lines.push(`成本：${truncate(tip.cost)}`);
		if (tip.benefit) lines.push(`收益：${truncate(tip.benefit)}`);
		if (tip.sources) lines.push(`来源：${truncate(tip.sources)}`);
		if (tip.remark) lines.push(`备注：${truncate(tip.remark)}`);
	}
	return lines.join("\n");
}

function snapshotLine(snapshot: { savedAt?: string; complete: boolean }): string {
	return snapshot.savedAt
		? `本地快照 ${snapshot.savedAt}`
		: snapshot.complete
			? "本地快照（日期未知）"
			: "本地快照不完整";
}

const USAGE_HINT =
	'可加关键词检索（空格分词 AND），或指定章号 chapter、证据等级 grade、单条 key（"章.条"）、full=true 取全文。';

/** 检索结果文本；头部带命中统计与快照日期，让模型能向用户转述新鲜度。 */
export function formatSearchResults(
	chapters: GuideChapter[],
	hits: GuideHit[],
	matched: number,
	snapshot: { savedAt?: string; complete: boolean },
	limit: number,
	full: boolean,
): string {
	const counts = chapterCounts(chapters);
	const shown = hits.slice(0, limit);
	const head = `《高性价比人生指南》命中 ${matched} 条，显示前 ${shown.length} 条（全书 34 章 ${counts.total} 条：A ${counts.a} / B ${counts.b} / C ${counts.c} / 争议 ${counts.disputed}；${snapshotLine(snapshot)}；来源 eternity4719/HowToLiveBetter，CC BY 4.0）`;
	const body = shown.map((hit) => formatTip(hit, { full })).join("\n\n");
	return `${head}\n\n${body}\n\n（未展开的命中可调大 limit，或按章/等级缩小范围。条目 key 形如 ${shown[0]?.tip.key ?? "1.1"}，用 key 参数可取单条全文。）`;
}

/** 单条全文（key 精确命中）。 */
export function formatSingleTip(hit: GuideHit, snapshot: { savedAt?: string; complete: boolean }): string {
	return `${formatTip(hit, { full: true })}\n\n（${snapshotLine(snapshot)}；原文：${GUIDE_REPO_URL}/blob/main/book/${encodeURIComponent(hit.chapter.file)}.md）`;
}

/** 无参数时的全书概览：章目录 + 等级分布 + 用法提示。 */
export function formatOverview(chapters: GuideChapter[], snapshot: { savedAt?: string; complete: boolean }): string {
	const counts = chapterCounts(chapters);
	const lines = chapters.map(
		(chapter) => `${String(chapter.no).padStart(2, "0")} ${chapter.title}（${chapter.tips.length} 条）`,
	);
	return [
		`《高性价比人生指南》全书概览（34 章 ${counts.total} 条：A ${counts.a} / B ${counts.b} / C ${counts.c} / 争议 ${counts.disputed}；${snapshotLine(snapshot)}；来源 eternity4719/HowToLiveBetter，CC BY 4.0）`,
		"",
		...lines,
		"",
		USAGE_HINT,
	].join("\n");
}

/** 检索全空时的提示文本：别列 34 章目录（overview 职责），只给改写建议。 */
export function formatNoMatches(query: GuideQuery): string {
	const parts: string[] = [];
	if (query.query) parts.push(`关键词「${query.query}」`);
	if (query.chapter) parts.push(`章号 ${query.chapter}`);
	if (query.grade) parts.push(`等级 ${query.grade}`);
	return `未命中（${parts.join(" + ") || "空查询"}）。中文检索用子串匹配：换更短的词（如「电动车」而非「电动车充电」）、去掉 grade/chapter 过滤，或先用 overview 看章目录。${USAGE_HINT}`;
}
