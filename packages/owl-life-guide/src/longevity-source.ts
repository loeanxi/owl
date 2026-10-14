/**
 * 「程序员延寿指南」（github.com/geekan/HowToLiveLonger，Unlicense 公共领域）
 * 的 Node 侧数据层：单文件 README 的抓取、6.x 证据段解析与磁盘缓存。
 *
 * 上游结构（README.md 的「6. 证据」一节）：
 * - `#### 6.x 名` / `##### 6.x.y 名` 划分小节；
 * - 顶层 `* 主题` 是一个条目，`* [标题](url)` 开头的直接以标题为条目名；
 * - `  * [标题](url)`（含「出处：」前缀）收进条目的链接列表，其余缩进行是结论明细；
 * - 主题名后的「（存有大量争议）」脚注标记 disputed。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getGuideCacheDir } from "./guide-source.ts";

export const LONGEVITY_REPO_URL = "https://github.com/geekan/HowToLiveLonger";
const LONGEVITY_RAW_URL = "https://cdn.jsdelivr.net/gh/geekan/HowToLiveLonger@main/README.md";
const LONGEVITY_CACHE_FILE = "longevity-readme.md";
const LONGEVITY_META_FILE = "longevity-meta.json";
/** 单文件抓取超时；上游是静态 CDN 文件，超时基本等于断网。 */
const FETCH_TIMEOUT_MS = 30_000;

export interface LongevityLink {
	text: string;
	url: string;
}

export interface LongevityEntry {
	/** 小节号，如 "6.1.2"。 */
	sectionNo: string;
	/** 小节名（含号），如 "6.1.2 液体"。 */
	section: string;
	/** 全书唯一键：`小节号/主题`，如 "6.1.2/牛奶"。 */
	key: string;
	/** 主题名（去掉争议脚注与链接语法）。 */
	name: string;
	/** 主题名后带「存有大量争议」脚注时为 true。 */
	disputed: boolean;
	/** 报道/论文链接，按出现顺序。 */
	links: LongevityLink[];
	/** 结论/明细行（去掉 bullet 前缀）。 */
	details: string[];
}

export interface LongevitySnapshot {
	entries: LongevityEntry[];
	/** 最近一次成功抓取的日期（YYYY-MM-DD）。 */
	savedAt?: string;
	/** 是否解析出至少一条条目。 */
	complete: boolean;
}

const SECTION_RE = /^#{4,5}\s+(6(?:\.\d+){1,2})\.?\s+(.*)$/;
const BULLET_RE = /^(\s*)\*\s*(.*)$/;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const IMAGE_RE = /^!\[/;
const DISPUTED_RE = /（存有大量争议）/;
const SOURCE_LABEL_RE = /^出处\d*[:：]/;
/** 指向图片文件的链接（如 `[鸡蛋](...jpg)`）不算文献来源。 */
const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|svg|bmp)$/i;

/** 去掉 markdown 粗体等标记噪声，供检索与展示。 */
function cleanText(text: string): string {
	return text.replace(/\*\*/g, "").trim();
}

/** 抽出全部 markdown 链接，并返回去掉链接语法后的剩余文本。 */
function extractLinks(text: string): { links: LongevityLink[]; remainder: string } {
	const links = Array.from(text.matchAll(LINK_RE)).map((match) => ({
		text: (match[1] ?? "").trim(),
		url: (match[2] ?? "").trim(),
	}));
	const remainder = links.length > 0 ? text.replace(LINK_RE, "").trim() : text;
	return { links, remainder };
}

export function parseLongevityReadme(raw: string): LongevityEntry[] {
	const entries: LongevityEntry[] = [];
	const keyCount = new Map<string, number>();
	let sectionNo = "";
	let section = "";
	let entry: LongevityEntry | undefined;

	const pushEntry = (name: string, disputed: boolean): LongevityEntry => {
		const baseKey = `${sectionNo}/${name}`;
		const seen = keyCount.get(baseKey) ?? 0;
		keyCount.set(baseKey, seen + 1);
		const created: LongevityEntry = {
			sectionNo,
			section,
			key: seen === 0 ? baseKey : `${baseKey}#${seen + 1}`,
			name,
			disputed,
			links: [],
			details: [],
		};
		entries.push(created);
		return created;
	};

	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trimEnd();
		const sectionMatch = SECTION_RE.exec(line);
		if (sectionMatch) {
			sectionNo = sectionMatch[1];
			section = `${sectionNo} ${(sectionMatch[2] ?? "").trim()}`.trim();
			entry = undefined;
			continue;
		}
		const bullet = BULLET_RE.exec(line);
		if (!bullet) continue;
		// 只收「6. 证据」下的条目，5. 行动等段落的 bullet 不算。
		if (!sectionNo) continue;
		const indent = (bullet[1] ?? "").replace(/\t/g, "  ").length;
		const text = (bullet[2] ?? "").trim();
		// `**粗体**` 这类行不是 bullet，跳过。
		if (!text || text.startsWith("*")) continue;
		const { links, remainder } = extractLinks(text);

		if (indent === 0) {
			if (IMAGE_RE.test(text)) continue;
			const disputed = DISPUTED_RE.test(text);
			const nameText = cleanText(remainder.replace(DISPUTED_RE, ""));
			const name = nameText || (links[0] ? cleanText(links[0].text) : "");
			if (!name) continue;
			entry = pushEntry(name, disputed);
			entry.links.push(...links.filter((link) => !IMAGE_URL_RE.test(link.url)));
			continue;
		}

		// 缩进行：没有归属条目则忽略。
		if (!entry) continue;
		if (IMAGE_RE.test(text)) continue;
		if (links.length > 0) {
			entry.links.push(...links.filter((link) => !IMAGE_URL_RE.test(link.url)));
			const leftover = cleanText(remainder.replace(SOURCE_LABEL_RE, "")).replace(/^[\s\-–—、]+|[\s\-–—、]+$/g, "");
			if (leftover) entry.details.push(leftover);
			continue;
		}
		const detail = cleanText(text);
		if (detail) entry.details.push(detail);
	}

	return entries;
}

// ---------------------------------------------------------------------------
// 磁盘缓存：与 guide 同目录（agent 数据目录下 life-guide/），README 存原始文本
// ---------------------------------------------------------------------------

interface DiskMeta {
	savedAt?: string;
}

/** 读磁盘缓存；文件缺失或解析不出条目时返回空快照。 */
export function loadLongevitySnapshotFromDisk(dir = getGuideCacheDir()): LongevitySnapshot {
	const rawPath = join(dir, LONGEVITY_CACHE_FILE);
	if (!existsSync(rawPath)) return { entries: [], complete: false };
	let entries: LongevityEntry[] = [];
	try {
		entries = parseLongevityReadme(readFileSync(rawPath, "utf-8"));
	} catch {
		entries = [];
	}
	if (entries.length === 0) return { entries: [], complete: false };
	let meta: DiskMeta = {};
	try {
		meta = JSON.parse(readFileSync(join(dir, LONGEVITY_META_FILE), "utf-8")) as DiskMeta;
	} catch {
		// meta 缺失/损坏：照常返回条目。
	}
	return { entries, ...(meta.savedAt ? { savedAt: meta.savedAt } : {}), complete: true };
}

function writeLongevityToDisk(raw: string, savedAt: string | undefined, dir = getGuideCacheDir()): void {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, LONGEVITY_CACHE_FILE), raw, "utf-8");
		if (savedAt) writeFileSync(join(dir, LONGEVITY_META_FILE), JSON.stringify({ savedAt }), "utf-8");
	} catch {
		// 缓存目录不可写：内存里的数据本次调用仍可用。
	}
}

/**
 * 拉取 README 并解析；失败时沿用 oldRaw，保证刷新不会让本地内容变少。
 * savedAt 只在拉取成功且解析出条目时记为今天；沿用旧原文时保留磁盘上的旧日期。
 */
export async function fetchLongevitySnapshot(
	options: { oldRaw?: string; signal?: AbortSignal } = {},
): Promise<LongevitySnapshot> {
	const previous = loadLongevitySnapshotFromDisk();
	let fetched: string | undefined;
	try {
		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const response = await fetch(LONGEVITY_RAW_URL, { signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		fetched = await response.text();
	} catch {
		fetched = undefined;
	}
	const raw = fetched ?? options.oldRaw;
	if (raw === undefined) return { entries: [], complete: false };
	const entries = parseLongevityReadme(raw);
	if (entries.length === 0) return { entries, complete: false };
	const savedAt = fetched !== undefined ? new Date().toISOString().slice(0, 10) : previous.savedAt;
	writeLongevityToDisk(raw, savedAt);
	return { entries, ...(savedAt ? { savedAt } : {}), complete: true };
}

/**
 * 取当前可用快照：有磁盘缓存直接用（离线可用），否则拉一次上游。
 * refresh 为 true 时跳过缓存强制刷新。
 */
export async function ensureLongevitySnapshot(
	options: { refresh?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<LongevitySnapshot> {
	if (!options.refresh) {
		const cached = loadLongevitySnapshotFromDisk();
		if (cached.entries.length > 0) return cached;
	}
	options.onProgress?.(1, 1);
	const rawPath = join(getGuideCacheDir(), LONGEVITY_CACHE_FILE);
	const oldRaw = existsSync(rawPath) ? readFileSync(rawPath, "utf-8") : undefined;
	return fetchLongevitySnapshot({
		...(oldRaw !== undefined ? { oldRaw } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
}
