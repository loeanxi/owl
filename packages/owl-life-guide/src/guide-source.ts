/**
 * 「高性价比人生指南」（github.com/eternity4719/HowToLiveBetter，正文 CC BY 4.0）
 * 的 Node 侧数据层：上游章节清单、markdown 解析、jsDelivr 抓取与 agent 数据
 * 目录下的磁盘缓存。解析规则与桌面端 features/guide/guide-content.ts 保持一致：
 * `### N. 标题` + `<!-- 成本标签: … -->` 注释 + 成本/说人话/收益/证据等级/来源/备注
 * 字段行；上游格式变化时两处要一起改。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GUIDE_REPO_URL = "https://github.com/eternity4719/HowToLiveBetter";
export const GUIDE_LICENSE_URL = "https://github.com/eternity4719/HowToLiveBetter/blob/main/LICENSE";
const GUIDE_RAW_BASE = "https://cdn.jsdelivr.net/gh/eternity4719/HowToLiveBetter@main/book/";
const GUIDE_META_FILE = "meta.json";
/** 单章抓取超时；上游是静态 CDN 文件，超时基本等于断网。 */
const CHAPTER_TIMEOUT_MS = 30_000;

export interface GuideChapterMeta {
	/** book/ 下的文件名（不含 .md），如 "01-不要早死"。 */
	file: string;
	no: number;
	title: string;
}

/** 上游 34 章的固定清单（README 官方目录）。 */
export const GUIDE_CHAPTERS: GuideChapterMeta[] = [
	{ file: "01-不要早死", no: 1, title: "不要早死" },
	{ file: "02-不要慢慢死", no: 2, title: "不要慢慢死" },
	{ file: "03-不要浪费精力", no: 3, title: "不要浪费精力" },
	{ file: "04-不要浪费时间", no: 4, title: "不要浪费时间" },
	{ file: "05-不要浪费钱", no: 5, title: "不要浪费钱" },
	{ file: "06-反面清单", no: 6, title: "反面清单" },
	{ file: "07-没钱的时候怎么活", no: 7, title: "没钱的时候怎么活" },
	{ file: "08-别把自己搭进去", no: 8, title: "别把自己搭进去" },
	{ file: "09-普通人容易踩的法律红线", no: 9, title: "普通人容易踩的法律红线" },
	{ file: "10-恋爱和结婚划不划算", no: 10, title: "恋爱和结婚划不划算" },
	{ file: "11-程序员和技术人容易踩的红线", no: 11, title: "程序员和技术人容易踩的红线" },
	{ file: "12-创业与做生意", no: 12, title: "创业与做生意" },
	{ file: "13-紧急情况", no: 13, title: "紧急情况" },
	{ file: "14-账号与信息安全", no: 14, title: "账号与信息安全" },
	{ file: "15-租房与买房", no: 15, title: "租房与买房" },
	{ file: "16-得了慢性病之后怎么活", no: 16, title: "得了慢性病之后怎么活" },
	{ file: "17-家里有老人", no: 17, title: "家里有老人" },
	{ file: "18-养孩子划不划算", no: 18, title: "养孩子划不划算" },
	{ file: "19-在职离职和工伤", no: 19, title: "在职离职和工伤" },
	{ file: "20-刚出生的孩子怎么带", no: 20, title: "刚出生的孩子怎么带" },
	{ file: "21-出国旅行与境外安全", no: 21, title: "出国旅行与境外安全" },
	{ file: "22-怎么放松", no: 22, title: "怎么放松" },
	{ file: "23-学什么技能划算", no: 23, title: "学什么技能划算" },
	{ file: "24-看病", no: 24, title: "看病" },
	{ file: "25-人走了以后要办什么", no: 25, title: "人走了以后要办什么" },
	{ file: "26-做一个网站或平台", no: 26, title: "做一个网站或平台" },
	{ file: "27-怀孕和生产", no: 27, title: "怀孕和生产" },
	{ file: "28-别为了外形把身体搞坏", no: 28, title: "别为了外形把身体搞坏" },
	{ file: "29-遭遇重大打击之后", no: 29, title: "遭遇重大打击之后" },
	{ file: "30-上学以后的孩子", no: 30, title: "上学以后的孩子" },
	{ file: "31-十八岁之后有哪几条路", no: 31, title: "十八岁之后有哪几条路" },
	{ file: "32-出国留学", no: 32, title: "出国留学" },
	{ file: "33-残疾之后怎么活", no: 33, title: "残疾之后怎么活" },
	{ file: "34-家里的常备药别吃出事", no: 34, title: "家里的常备药别吃出事" },
];

export interface GuideTip {
	/** 章内编号。 */
	no: number;
	/** 全书唯一键：`${章号}.${条号}`。 */
	key: string;
	title: string;
	/** 成本标签注释里的键值对（钱/时间/毅力/收益/口径）。 */
	tags: Array<{ k: string; v: string }>;
	cost: string;
	/** 「说人话」字段：作者写的日常版摘要。 */
	plain: string;
	benefit: string;
	grade: "A" | "B" | "C";
	sources: string;
	remark: string;
	/** 备注 以「争议」开头 —— 上游的争议标记。 */
	disputed: boolean;
}

export interface GuideChapter {
	no: number;
	title: string;
	intro: string;
	tips: GuideTip[];
	/** book/ 文件名（不含 .md），回链原文用。 */
	file: string;
	/** 原始 markdown（磁盘缓存存这个，不存解析结果）。 */
	raw: string;
}

const H1_RE = /^#\s+(\d+)\s*[.．、]\s*(.*)$/;
const TIP_RE = /^#{3}\s+(\d+)\s*[.．、]\s*(.*)$/;
const TAGS_RE = /^<!--\s*成本标签\s*[:：]\s*(.*?)\s*-->$/;
const FIELD_RE = /^-\s*(成本|说人话|收益|证据等级|来源|备注)\s*[:：]\s*(.*)$/;

interface TipDraft {
	no: number;
	key: string;
	title: string;
	tags: Array<{ k: string; v: string }>;
	cost: string;
	plain: string;
	benefit: string;
	grade: string;
	sources: string;
	remark: string;
}

export function parseGuideChapter(meta: GuideChapterMeta, raw: string): GuideChapter {
	const lines = raw.split("\n");
	let no = meta.no;
	let title = meta.title;
	const intro: string[] = [];
	const drafts: TipDraft[] = [];
	let tip: TipDraft | undefined;
	let field: "cost" | "plain" | "benefit" | "grade" | "sources" | "remark" | undefined;
	let inBody = false;

	const append = (text: string): void => {
		if (!tip || !field) return;
		const current = tip[field];
		tip[field] = current ? `${current}\n${text}` : text;
	};

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;
		const h1 = H1_RE.exec(line);
		if (h1) {
			no = Number(h1[1]) || meta.no;
			title = h1[2].trim() || meta.title;
			inBody = true;
			continue;
		}
		const tipMatch = TIP_RE.exec(line);
		if (tipMatch) {
			tip = {
				no: Number(tipMatch[1]),
				key: `${no}.${tipMatch[1]}`,
				title: tipMatch[2].trim(),
				tags: [],
				cost: "",
				plain: "",
				benefit: "",
				grade: "",
				sources: "",
				remark: "",
			};
			drafts.push(tip);
			field = undefined;
			continue;
		}
		if (!tip) {
			// H1 之前的导言行（如「[← 回总目录](…)」）与 H1 后第一段都算章首说明。
			if (inBody && !/^\[/m.test(line)) intro.push(line);
			continue;
		}
		const tags = TAGS_RE.exec(line);
		if (tags) {
			tip.tags = Array.from(tags[1].matchAll(/(\S+?)=(\S+)/g)).map((m) => ({ k: m[1], v: m[2] }));
			field = undefined;
			continue;
		}
		const fieldMatch = FIELD_RE.exec(line);
		if (fieldMatch) {
			field =
				fieldMatch[1] === "成本"
					? "cost"
					: fieldMatch[1] === "说人话"
						? "plain"
						: fieldMatch[1] === "收益"
							? "benefit"
							: fieldMatch[1] === "证据等级"
								? "grade"
								: fieldMatch[1] === "来源"
									? "sources"
									: "remark";
			append(fieldMatch[2].trim());
			continue;
		}
		// 字段的折行 / 未知列表行：一律并进当前字段，不丢内容。
		append(line.trim());
	}

	const gradeOf = (value: string): GuideTip["grade"] =>
		/^[ABC]/.test(value.trim()) ? (value.trim().charAt(0) as GuideTip["grade"]) : "C";
	const tips: GuideTip[] = drafts.map((draft) => ({
		...draft,
		grade: gradeOf(draft.grade),
		disputed: /^争议/.test(draft.remark.trim()),
	}));
	return { no, title, intro: intro.join("\n"), tips, file: meta.file, raw };
}

// ---------------------------------------------------------------------------
// 磁盘缓存：agent 数据目录下 life-guide/，原始 markdown 一章一个文件
// ---------------------------------------------------------------------------

export function getGuideCacheDir(): string {
	const explicitDir = process.env.OWL_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	if (explicitDir) return join(explicitDir, "life-guide");
	return join(homedir(), ".owl", "agent", "life-guide");
}

export interface GuideSnapshot {
	chapters: GuideChapter[];
	/** 最近一次完整快照的日期（YYYY-MM-DD）；不完整时缺省。 */
	savedAt?: string;
	/** 34 章是否齐全。 */
	complete: boolean;
}

interface DiskMeta {
	savedAt?: string;
}

/** 读磁盘缓存；坏一章丢一章，meta 损坏当作无日期。 */
export function loadGuideSnapshotFromDisk(dir = getGuideCacheDir()): GuideSnapshot {
	const chapters: GuideChapter[] = [];
	if (!existsSync(dir)) return { chapters, complete: false };
	let meta: DiskMeta = {};
	try {
		meta = JSON.parse(readFileSync(join(dir, GUIDE_META_FILE), "utf-8")) as DiskMeta;
	} catch {
		// meta 缺失/损坏：照常读章节文件。
	}
	for (const chapterMeta of GUIDE_CHAPTERS) {
		const path = join(dir, `${chapterMeta.file}.md`);
		if (!existsSync(path)) continue;
		try {
			chapters.push(parseGuideChapter(chapterMeta, readFileSync(path, "utf-8")));
		} catch {
			// 单章损坏：跳过。
		}
	}
	chapters.sort((a, b) => a.no - b.no);
	const complete = chapters.length === GUIDE_CHAPTERS.length;
	return {
		chapters,
		...(complete && meta.savedAt ? { savedAt: meta.savedAt } : {}),
		complete,
	};
}

function writeSnapshotToDisk(chapters: GuideChapter[], savedAt: string | undefined, dir: string): void {
	try {
		mkdirSync(dir, { recursive: true });
		for (const chapter of chapters) {
			writeFileSync(join(dir, `${chapter.file}.md`), chapter.raw, "utf-8");
		}
		if (savedAt) writeFileSync(join(dir, GUIDE_META_FILE), JSON.stringify({ savedAt }), "utf-8");
	} catch {
		// 缓存目录不可写：内存里的数据本次调用仍可用。
	}
}

/**
 * 拉取全书；单章失败不影响其他章。传入 oldRaw 时，失败章节沿用旧原文，
 * 保证刷新不会让本地内容变少。savedAt 只在 34 章齐全时记为今天。
 */
export async function fetchGuideSnapshot(
	options: {
		oldRaw?: Map<string, string>;
		signal?: AbortSignal;
		onProgress?: (done: number, total: number) => void;
	} = {},
): Promise<GuideSnapshot> {
	const total = GUIDE_CHAPTERS.length;
	let done = 0;
	const settled = await Promise.all(
		GUIDE_CHAPTERS.map(async (meta) => {
			try {
				const timeout = AbortSignal.timeout(CHAPTER_TIMEOUT_MS);
				const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
				const response = await fetch(GUIDE_RAW_BASE + encodeURIComponent(`${meta.file}.md`), { signal });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const raw = await response.text();
				return parseGuideChapter(meta, raw);
			} catch {
				const old = options.oldRaw?.get(meta.file);
				return old === undefined ? undefined : parseGuideChapter(meta, old);
			} finally {
				done += 1;
				options.onProgress?.(done, total);
			}
		}),
	);
	const chapters = settled.filter((chapter): chapter is GuideChapter => Boolean(chapter)).sort((a, b) => a.no - b.no);
	const complete = chapters.length === total;
	const savedAt = complete ? new Date().toISOString().slice(0, 10) : undefined;
	writeSnapshotToDisk(chapters, savedAt, getGuideCacheDir());
	return { chapters, ...(savedAt ? { savedAt } : {}), complete };
}

/**
 * 取当前可用快照：有磁盘缓存直接用（离线可用），否则拉一次上游。
 * refresh 为 true 时跳过缓存强制刷新。
 */
export async function ensureGuideSnapshot(
	options: { refresh?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<GuideSnapshot> {
	if (!options.refresh) {
		const cached = loadGuideSnapshotFromDisk();
		if (cached.chapters.length > 0) return cached;
	}
	const oldRaw = new Map<string, string>();
	for (const chapter of loadGuideSnapshotFromDisk().chapters) oldRaw.set(chapter.file, chapter.raw);
	return fetchGuideSnapshot({ oldRaw, signal: options.signal, onProgress: options.onProgress });
}
