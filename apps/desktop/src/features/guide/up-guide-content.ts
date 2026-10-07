/** 「人生进阶指南」（github.com/byoungd/up，正文 CC BY-NC 4.0）的内容层。
 *  与 guide-content.ts（高性价比人生指南）同构：jsDelivr 拉原始 markdown，localStorage
 *  按章缓存原文，离线可用。上游是长文书稿（frontmatter + 正文），不做条目级解析，
 *  只摘 frontmatter 的 title/updated 给阅读面板用。 */

export const UP_GUIDE_REPO_URL = "https://github.com/byoungd/up";
export const UP_GUIDE_LICENSE_URL = "https://github.com/byoungd/up/blob/main/LICENSE-CONTENT.md";
const UP_GUIDE_RAW_BASE = "https://cdn.jsdelivr.net/gh/byoungd/up@main/";
const UP_GUIDE_CACHE_META = "owl.upguide.meta.v1";
const UP_GUIDE_CACHE_CHAPTER = "owl.upguide.chapter.v1.";

export interface UpGuidePartMeta {
	/** 部名（上游 SUMMARY 的分组标题）。 */
	title: string;
}

/** 上游 SUMMARY 的部结构（词表/工具箱/归档等附属材料不进阅读目录）。 */
export const UP_GUIDE_PARTS: UpGuidePartMeta[] = [
	{ title: "开始" },
	{ title: "第一部 · 打开输入" },
	{ title: "第二部 · 把自己放回生活" },
	{ title: "第三部 · 借工具放大能力" },
	{ title: "第四部 · 实践与恢复" },
	{ title: "第五部 · 行动与长期改变" },
	{ title: "第六部 · 与自己做终身朋友" },
	{ title: "后记" },
];

export interface UpGuideChapterMeta {
	/** 仓库内路径，如 "docs/threads/part-1/1-understanding.md"。 */
	path: string;
	/** 全书阅读序号（1 起，目录与抓取缓存共用的键）。 */
	no: number;
	/** 目录短标题（上游 SUMMARY 的链接文字，去掉了序号前缀）。 */
	title: string;
	/** 所属部（UP_GUIDE_PARTS 下标）。 */
	part: number;
}

/** 上游 46 章的固定清单（docs/SUMMARY.md 官方阅读顺序）。 */
export const UP_GUIDE_CHAPTERS: UpGuideChapterMeta[] = [
	{ path: "docs/threads/part-0/reader-guide.md", no: 1, title: "阅读指南：把书放回生活", part: 0 },
	{ path: "docs/threads/part-0/prologue.md", no: 2, title: "序章：先不要急着改变人生", part: 0 },
	{ path: "docs/threads/part-1/open-input.md", no: 3, title: "导语：打开输入", part: 1 },
	{ path: "docs/threads/part-1/0-cefr.md", no: 4, title: "CEFR 目标与自测", part: 1 },
	{ path: "docs/threads/part-1/1-understanding.md", no: 5, title: "认知与训练原则", part: 1 },
	{ path: "docs/threads/part-1/2-vocabulary.md", no: 6, title: "词汇系统", part: 1 },
	{ path: "docs/threads/part-1/grammar.md", no: 7, title: "语法篇：让结构服务于意思", part: 1 },
	{ path: "docs/threads/part-1/3-listening.md", no: 8, title: "听力训练", part: 1 },
	{ path: "docs/threads/part-1/4-reading.md", no: 9, title: "阅读训练", part: 1 },
	{ path: "docs/threads/part-1/5-speaking.md", no: 10, title: "口语训练", part: 1 },
	{ path: "docs/threads/part-1/6-writing.md", no: 11, title: "写作训练", part: 1 },
	{ path: "docs/threads/part-1/7-ai.md", no: 12, title: "用 AI 学英语", part: 1 },
	{ path: "docs/threads/part-1/8-job-search-english.md", no: 13, title: "求职英语与远程协作", part: 1 },
	{ path: "docs/threads/part-2/return-to-life.md", no: 14, title: "导语：把自己放回生活", part: 2 },
	{ path: "docs/threads/part-2/my-story.md", no: 15, title: "我的故事", part: 2 },
	{ path: "docs/threads/part-2/depression-anxiety-recovery.md", no: 16, title: "我还在这里：从抑郁焦虑的黑暗中走出来", part: 2 },
	{ path: "docs/threads/part-2/narrative-and-evidence.md", no: 17, title: "叙事与证据篇：不把经历写成命运", part: 2 },
	{ path: "docs/threads/part-2/x-misc.md", no: 18, title: "回声篇：不要把逃避写成浪漫", part: 2 },
	{ path: "docs/threads/part-2/recovery.md", no: 19, title: "恢复篇：先把自己接住", part: 2 },
	{ path: "docs/threads/part-2/decision.md", no: 20, title: "选择篇：在不确定中做决定", part: 2 },
	{ path: "docs/threads/part-2/relationships.md", no: 21, title: "关系篇：在关系中成为成年人", part: 2 },
	{ path: "docs/threads/part-2/care-and-carry-on.md", no: 22, title: "珍惜篇：从爱与牵挂中获得力量", part: 2 },
	{ path: "docs/threads/part-2/entrepreneurship.md", no: 23, title: "创业篇：从野心到使命", part: 2 },
	{ path: "docs/threads/part-3/amplify-ability.md", no: 24, title: "导语：借工具放大能力", part: 3 },
	{ path: "docs/threads/part-3/1-ai-learning.md", no: 25, title: "使用 AI 学习一切", part: 3 },
	{ path: "docs/threads/part-3/6-ai-trends-and-learning-roadmap.md", no: 26, title: "AI 趋势与学习路线：把变化变成能力", part: 3 },
	{ path: "docs/threads/part-3/3-attention-and-judgment.md", no: 27, title: "注意力篇：把注意力还给自己", part: 3 },
	{ path: "docs/threads/part-3/4-artifacts-and-delivery.md", no: 28, title: "作品篇：把学会变成做出", part: 3 },
	{ path: "docs/threads/part-3/5-evidence-and-transfer.md", no: 29, title: "证据篇：变化要如何被看见", part: 3 },
	{ path: "docs/threads/part-3/2-ai-development-and-resource-layer.md", no: 30, title: "AI 开发与资源层创业", part: 3 },
	{ path: "docs/projects.md", no: 31, title: "作者项目与现实实践", part: 3 },
	{ path: "docs/threads/part-4/practice-and-recovery.md", no: 32, title: "导语：实践与恢复", part: 4 },
	{ path: "docs/threads/part-4/week-1.md", no: 33, title: "实践篇：先把第一周过完", part: 4 },
	{ path: "docs/threads/part-4/family-learning.md", no: 34, title: "家庭学习篇：把成长还给孩子", part: 4 },
	{ path: "docs/threads/part-4/daily-system.md", no: 35, title: "生活系统篇：把改变安放在日子里", part: 4 },
	{ path: "docs/threads/part-4/rhythm-and-compounding.md", no: 36, title: "节律篇：让小事穿过时间", part: 4 },
	{ path: "docs/threads/part-5/long-term-action.md", no: 37, title: "导语：行动与长期改变", part: 5 },
	{ path: "docs/threads/part-5/90-day-plan.md", no: 38, title: "行动篇：九十天，把生活交还给自己", part: 5 },
	{ path: "docs/threads/part-5/book-as-proof.md", no: 39, title: "案例篇：让这本书证明它的方法", part: 5 },
	{ path: "docs/threads/part-5/after-90-days.md", no: 40, title: "九十天以后：把改变留在生活里", part: 5 },
	{ path: "docs/threads/part-6/1-understanding-yourself.md", no: 41, title: "了解自己：先看见自己如何运作", part: 6 },
	{ path: "docs/threads/part-6/2-knowing-yourself.md", no: 42, title: "认识自己：从角色与评价中收回定义权", part: 6 },
	{ path: "docs/threads/part-6/3-being-kind-to-yourself.md", no: 43, title: "善待自己：建立不依赖羞耻的恢复系统", part: 6 },
	{ path: "docs/threads/part-6/4-improving-yourself.md", no: 44, title: "提升自己：让成长成为可验证的长期实验", part: 6 },
	{ path: "docs/threads/part-6/5-being-your-own-lifelong-friend.md", no: 45, title: "与自己做终身朋友：在变化中持续相处", part: 6 },
	{ path: "docs/threads/part-6/afterword.md", no: 46, title: "人生最大的进阶，是找到真正的自己", part: 7 },
];

export interface UpGuideChapter {
	/** 阅读序号（UP_GUIDE_CHAPTERS 的 no）。 */
	no: number;
	/** frontmatter 的 title（比目录短标题完整）；缺 frontmatter 时回落目录标题。 */
	title: string;
	/** frontmatter 的 updated（YYYY-MM-DD）。 */
	updated?: string;
	/** 去掉 frontmatter 与首个 H1 后的正文 markdown。 */
	body: string;
	/** 原始 markdown（缓存层直接存这个）。 */
	raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const META_TITLE_RE = /^title:\s*"?(.*?)"?\s*$/m;
const META_UPDATED_RE = /^updated:\s*"?(.*?)"?\s*$/m;
const H1_RE = /^#\s+(.+)(?:\r?\n)+/;

/** 摘 frontmatter 元信息并剥掉它和首个 H1（标题由阅读头渲染，正文不重复）。 */
export function parseUpGuideChapter(meta: UpGuideChapterMeta, raw: string): UpGuideChapter {
	const front = FRONTMATTER_RE.exec(raw);
	const head = front?.[1] ?? "";
	const title = META_TITLE_RE.exec(head)?.[1]?.trim() || meta.title;
	const updated = META_UPDATED_RE.exec(head)?.[1]?.trim() || undefined;
	// frontmatter 与 H1 之间常有空行，先吃掉行首空行再剥 H1。
	const body = raw.slice(front ? front[0].length : 0).replace(/^(?:\r?\n)+/, "").replace(H1_RE, "");
	return { no: meta.no, title, ...(updated ? { updated } : {}), body, raw };
}

/** 逐章抓取；单章失败不影响其他章，返回成功解析的章节（按序号排序）与失败数。 */
export async function fetchUpGuideChapters(onProgress?: (done: number, total: number) => void): Promise<{ chapters: UpGuideChapter[]; failed: number }> {
	const total = UP_GUIDE_CHAPTERS.length;
	let done = 0;
	const settled = await Promise.all(UP_GUIDE_CHAPTERS.map(async (meta) => {
		try {
			const response = await fetch(UP_GUIDE_RAW_BASE + meta.path, { signal: AbortSignal.timeout(30000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const raw = await response.text();
			return parseUpGuideChapter(meta, raw);
		} catch {
			return undefined;
		} finally {
			done += 1;
			onProgress?.(done, total);
		}
	}));
	const chapters = settled.filter((chapter): chapter is UpGuideChapter => Boolean(chapter)).sort((a, b) => a.no - b.no);
	return { chapters, failed: total - chapters.length };
}

const storage = (): Storage | undefined => {
	try {
		return typeof localStorage !== "undefined" ? localStorage : undefined;
	} catch {
		return undefined;
	}
};

export interface UpGuideCache {
	savedAt?: string;
	chapters: UpGuideChapter[];
}

/** 读本地缓存：章节按存储时机各自独立，坏一章丢一章，不影响其余。 */
export function loadCachedUpGuide(): UpGuideCache {
	const store = storage();
	if (!store) return { chapters: [] };
	try {
		const meta = JSON.parse(store.getItem(UP_GUIDE_CACHE_META) ?? "{}") as { savedAt?: string };
		const byNo = new Map(UP_GUIDE_CHAPTERS.map((chapterMeta) => [chapterMeta.no, chapterMeta]));
		const chapters: UpGuideChapter[] = [];
		for (const [key, value] of Object.entries(store)) {
			if (!key.startsWith(UP_GUIDE_CACHE_CHAPTER)) continue;
			const meta2 = byNo.get(Number(key.slice(UP_GUIDE_CACHE_CHAPTER.length)));
			if (!meta2 || typeof value !== "string") continue;
			try {
				chapters.push(parseUpGuideChapter(meta2, value));
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
export function saveCachedUpGuide(chapters: UpGuideChapter[]): string {
	const savedAt = new Date().toISOString().slice(0, 10);
	const store = storage();
	if (!store) return savedAt;
	try {
		for (const chapter of chapters) {
			store.setItem(UP_GUIDE_CACHE_CHAPTER + chapter.no, chapter.raw);
		}
		store.setItem(UP_GUIDE_CACHE_META, JSON.stringify({ savedAt }));
	} catch {
		// 配额不足：放弃持久化，内存里的数据仍可用。
	}
	return savedAt;
}

export function clearUpGuideCache(): void {
	const store = storage();
	if (!store) return;
	try {
		store.removeItem(UP_GUIDE_CACHE_META);
		for (const chapterMeta of UP_GUIDE_CHAPTERS) store.removeItem(UP_GUIDE_CACHE_CHAPTER + chapterMeta.no);
	} catch {
		// 忽略。
	}
}

/** 章节原文的 GitHub 页（阅读头「查看本章原文」用）。 */
export function upGuideChapterUrl(path: string): string {
	return `${UP_GUIDE_REPO_URL}/blob/main/${path}`;
}

/** 章节文件在仓库里的目录（相对链接与图片的解析基准）。 */
function chapterDir(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? "" : path.slice(0, cut + 1);
}

const UP_GUIDE_PATH_BY_TARGET = new Map<string, UpGuideChapterMeta>();
for (const chapterMeta of UP_GUIDE_CHAPTERS) {
	// 站内绝对形式（VitePress）：/threads/part-1/2-vocabulary 或 /projects
	const stripped = chapterMeta.path.replace(/^docs\//, "").replace(/\.md$/, "");
	UP_GUIDE_PATH_BY_TARGET.set(`/${stripped}`, chapterMeta);
	// 相对引用用的文件名形式：2-vocabulary
	const base = stripped.slice(stripped.lastIndexOf("/") + 1);
	UP_GUIDE_PATH_BY_TARGET.set(base, chapterMeta);
}

/** 章内相对链接 / 站内绝对链接 → 目录章节；解析不了返回 undefined（调用方回落 GitHub）。 */
export function resolveUpGuideLink(fromPath: string, href: string): UpGuideChapterMeta | undefined {
	if (/^(https?:)?\/\//.test(href) || href.startsWith("#")) return undefined;
	const clean = href.split("#")[0]!.replace(/\.md$/, "").replace(/^\.\//, "");
	if (clean.startsWith("/")) return UP_GUIDE_PATH_BY_TARGET.get(clean);
	// 相对路径：基于当前章节目录逐级归一化。
	const segments = (chapterDir(fromPath).replace(/^docs\/?/, "") + clean).split("/");
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment === "..") resolved.pop();
		else if (segment && segment !== ".") resolved.push(segment);
	}
	return UP_GUIDE_PATH_BY_TARGET.get(`/${resolved.join("/")}`) ?? UP_GUIDE_PATH_BY_TARGET.get(resolved[resolved.length - 1] ?? "");
}

/** 相对目标（链接/图片）基于当前章节目录归一化成仓库内路径；解析不了返回 undefined。 */
export function resolveUpGuideRepoPath(fromPath: string, target: string): string | undefined {
	if (/^(https?:)?\/\//.test(target) || target.startsWith("data:") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
	const segments = (chapterDir(fromPath) + target.replace(/^\.\//, "")).split("/");
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment === "..") resolved.pop();
		else if (segment && segment !== ".") resolved.push(segment);
	}
	return resolved.join("/") || undefined;
}

/** 相对资源（图片）→ jsDelivr 绝对地址；已是绝对地址原样返回。 */
export function resolveUpGuideAsset(fromPath: string, src: string): string {
	if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) return src;
	return UP_GUIDE_RAW_BASE + (resolveUpGuideRepoPath(fromPath, src) ?? src);
}
