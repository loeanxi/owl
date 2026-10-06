/** 「高性价比人生指南」（github.com/eternity4719/HowToLiveBetter，正文 CC BY 4.0）的内容层。
 *  数据源走 jsDelivr CDN（raw.githubusercontent 国内不稳），拉回的原始 markdown 按章节缓存进
 *  localStorage，之后离线可用；解析依赖上游统一格式：`### N. 标题` + `<!-- 成本标签: … -->`
 *  注释 + 成本/说人话/收益/证据等级/来源/备注 字段行。 */

export const GUIDE_REPO_URL = "https://github.com/eternity4719/HowToLiveBetter";
export const GUIDE_LICENSE_URL = "https://github.com/eternity4719/HowToLiveBetter/blob/main/LICENSE";
const GUIDE_RAW_BASE = "https://cdn.jsdelivr.net/gh/eternity4719/HowToLiveBetter@main/book/";
const GUIDE_CACHE_META = "owl.guide.meta.v1";
const GUIDE_CACHE_CHAPTER = "owl.guide.chapter.v1.";

export interface GuideChapterMeta {
	/** book/ 下的文件名（不含 .md），如 "01-不要早死"。 */
	file: string;
	no: number;
	/** 文件名里的章节短标题；抓取成功后被文内 H1 覆盖。 */
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
	/** 原始 markdown（缓存层直接存这个）。 */
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
				cost: "", plain: "", benefit: "", grade: "", sources: "", remark: "",
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
			field = fieldMatch[1] === "成本" ? "cost"
				: fieldMatch[1] === "说人话" ? "plain"
				: fieldMatch[1] === "收益" ? "benefit"
				: fieldMatch[1] === "证据等级" ? "grade"
				: fieldMatch[1] === "来源" ? "sources"
				: "remark";
			append(fieldMatch[2].trim());
			continue;
		}
		// 字段的折行 / 未知列表行：一律并进当前字段，不丢内容。
		append(line.trim());
	}

	const gradeOf = (value: string): GuideTip["grade"] => /^[ABC]/.test(value.trim()) ? (value.trim().charAt(0) as GuideTip["grade"]) : "C";
	const tips: GuideTip[] = drafts.map((draft) => ({
		...draft,
		grade: gradeOf(draft.grade),
		disputed: /^争议/.test(draft.remark.trim()),
	}));
	return { no, title, intro: intro.join("\n"), tips, file: meta.file, raw };
}

/** 逐章抓取；单章失败不影响其他章，返回成功解析的章节（按章号排序）与失败数。 */
export async function fetchGuideChapters(onProgress?: (done: number, total: number) => void): Promise<{ chapters: GuideChapter[]; failed: number }> {
	const total = GUIDE_CHAPTERS.length;
	let done = 0;
	const settled = await Promise.all(GUIDE_CHAPTERS.map(async (meta) => {
		try {
			const response = await fetch(GUIDE_RAW_BASE + encodeURIComponent(`${meta.file}.md`), { signal: AbortSignal.timeout(30000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const raw = await response.text();
			return parseGuideChapter(meta, raw);
		} catch {
			return undefined;
		} finally {
			done += 1;
			onProgress?.(done, total);
		}
	}));
	const chapters = settled.filter((chapter): chapter is GuideChapter => Boolean(chapter)).sort((a, b) => a.no - b.no);
	return { chapters, failed: total - chapters.length };
}

const storage = (): Storage | undefined => {
	try {
		return typeof localStorage !== "undefined" ? localStorage : undefined;
	} catch {
		return undefined;
	}
};

export interface GuideCache {
	savedAt?: string;
	chapters: GuideChapter[];
}

/** 读本地缓存：章节按存储时机各自独立，坏一章丢一章，不影响其余。 */
export function loadCachedGuide(): GuideCache {
	const store = storage();
	if (!store) return { chapters: [] };
	try {
		const meta = JSON.parse(store.getItem(GUIDE_CACHE_META) ?? "{}") as { savedAt?: string };
		const chapters: GuideChapter[] = [];
		for (const chapterMeta of GUIDE_CHAPTERS) {
			const raw = store.getItem(GUIDE_CACHE_CHAPTER + chapterMeta.no);
			if (raw === null) continue;
			try {
				chapters.push(JSON.parse(raw) as GuideChapter);
			} catch {
				// 单章缓存损坏：跳过。
			}
		}
		chapters.sort((a, b) => a.no - b.no);
		return { savedAt: meta.savedAt, chapters };
	} catch {
		return { chapters: [] };
	}
}

/** 写缓存并返回快照时间。localStorage 写满时静默放弃（本次会话仍在内存里可用）。 */
export function saveCachedGuide(chapters: GuideChapter[]): string {
	const savedAt = new Date().toISOString().slice(0, 10);
	const store = storage();
	if (!store) return savedAt;
	try {
		for (const chapter of chapters) {
			store.setItem(GUIDE_CACHE_CHAPTER + chapter.no, JSON.stringify(chapter));
		}
		store.setItem(GUIDE_CACHE_META, JSON.stringify({ savedAt }));
	} catch {
		// 配额不足：放弃持久化，内存里的数据仍可用。
	}
	return savedAt;
}

export function clearGuideCache(): void {
	const store = storage();
	if (!store) return;
	try {
		store.removeItem(GUIDE_CACHE_META);
		for (const chapterMeta of GUIDE_CHAPTERS) store.removeItem(GUIDE_CACHE_CHAPTER + chapterMeta.no);
	} catch {
		// 忽略。
	}
}

/** 章节原文的 GitHub 页（署名栏「查看本章原文」用）。 */
export function guideChapterUrl(file: string): string {
	return `${GUIDE_REPO_URL}/blob/main/book/${encodeURIComponent(file)}.md`;
}
