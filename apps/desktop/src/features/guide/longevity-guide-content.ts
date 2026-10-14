/** 「程序员延寿指南」（github.com/geekan/HowToLiveLonger，Unlicense 公共领域）的内容层。
 *  与 up-guide-content.ts 同构但更简：上游是单篇 README，jsDelivr 拉原始 markdown，
 *  localStorage 缓存原文，离线可用；不解析条目，只剥 H1 供标题，其余正文交给
 *  markdown-it 渲染，标题注入锚点 id 供左侧目录跳转。 */

export const LONGEVITY_REPO_URL = "https://github.com/geekan/HowToLiveLonger";
export const LONGEVITY_LICENSE_URL = "https://github.com/geekan/HowToLiveLonger/blob/main/LICENSE";
export const LONGEVITY_SOURCE_URL = "https://github.com/geekan/HowToLiveLonger/blob/main/README.md";
const LONGEVITY_RAW_URL = "https://cdn.jsdelivr.net/gh/geekan/HowToLiveLonger@main/README.md";
const LONGEVITY_CACHE_RAW = "owl.longevity.raw.v1";
const LONGEVITY_CACHE_META = "owl.longevity.meta.v1";

export interface LongevityDoc {
	/** 首个 H1（剥出正文，标题由阅读头渲染）。 */
	title: string;
	/** 去掉 H1 后的正文 markdown。 */
	body: string;
	/** 原始 markdown（缓存层直接存这个）。 */
	raw: string;
}

const H1_RE = /^#\s+(.+?)\s*(?:\r?\n)+/;
const FALLBACK_TITLE = "程序员延寿指南";

/** 剥掉首个 H1 作为标题；其余原样保留。 */
export function parseLongevityDoc(raw: string): LongevityDoc {
	const head = raw.replace(/^\uFEFF/, "");
	const match = H1_RE.exec(head);
	const title = match?.[1]?.trim() || FALLBACK_TITLE;
	const body = (match ? head.slice(match[0].length) : head).replace(/^(?:\r?\n)+/, "");
	return { title, body, raw };
}

export interface LongevityTocEntry {
	/** 注入到标题上的锚点 id（渲染后 HTML 内唯一）。 */
	id: string;
	/** 标题级别（h2-h6）。 */
	level: number;
	/** 纯文本标题（去掉内联标签）。 */
	title: string;
	/** GitHub 风格 slug，用于匹配上游正文里的 `#锚点` 链接。 */
	slug: string;
}

const HEADING_TAG_RE = /<h([2-6])>([\s\S]*?)<\/h\1>/g;

/** 给渲染后的标题逐个注入 id，并同时产出目录；两边顺序一致，锚点天然对齐。 */
export function injectHeadingIds(html: string): { html: string; toc: LongevityTocEntry[] } {
	const toc: LongevityTocEntry[] = [];
	let index = 0;
	const withIds = html.replace(HEADING_TAG_RE, (_raw, level: string, inner: string) => {
		const text = inner.replace(/<[^>]+>/g, "").trim();
		const id = `lon-h-${index++}`;
		toc.push({ id, level: Number(level), title: text, slug: githubSlug(text) });
		return `<h${level} id="${id}">${inner}</h${level}>`;
	});
	return { html: withIds, toc };
}

/** 近似 GitHub 的标题 slug（小写、去标点、空格转连字符），匹配上游目录里的 `#锚点`。 */
export function githubSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
}

/** 正文里的相对链接 → 仓库内绝对地址；已是绝对协议原样返回。 */
export function resolveLongevityUrl(href: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
	try {
		return new URL(href, LONGEVITY_SOURCE_URL).toString();
	} catch {
		return href;
	}
}

/** 拉取 README；失败抛错（调用方落 error 态）。 */
export async function fetchLongevityDoc(): Promise<LongevityDoc> {
	const response = await fetch(LONGEVITY_RAW_URL, { signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return parseLongevityDoc(await response.text());
}

const storage = (): Storage | undefined => {
	try {
		return typeof localStorage !== "undefined" ? localStorage : undefined;
	} catch {
		return undefined;
	}
};

export interface LongevityCache {
	savedAt?: string;
	doc?: LongevityDoc;
}

/** 读本地缓存；无缓存或原文损坏时返回空。 */
export function loadCachedLongevity(): LongevityCache {
	const store = storage();
	if (!store) return {};
	try {
		const raw = store.getItem(LONGEVITY_CACHE_RAW);
		if (!raw) return {};
		const meta = JSON.parse(store.getItem(LONGEVITY_CACHE_META) ?? "{}") as { savedAt?: string };
		return { ...(meta.savedAt ? { savedAt: meta.savedAt } : {}), doc: parseLongevityDoc(raw) };
	} catch {
		return {};
	}
}

/** 写缓存并返回快照时间。localStorage 写满时静默放弃（本次会话仍在内存里可用）。 */
export function saveCachedLongevity(doc: LongevityDoc): string {
	const savedAt = new Date().toISOString().slice(0, 10);
	const store = storage();
	if (!store) return savedAt;
	try {
		store.setItem(LONGEVITY_CACHE_RAW, doc.raw);
		store.setItem(LONGEVITY_CACHE_META, JSON.stringify({ savedAt }));
	} catch {
		// 配额不足：放弃持久化，内存里的数据仍可用。
	}
	return savedAt;
}
