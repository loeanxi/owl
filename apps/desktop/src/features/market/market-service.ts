/**
 * 「插件市场」数据服务：实时聚合两个社区源。owl 与 pi 已分轨、也不兼容 DSH，
 * 两个源的插件引入时【全部】交给 Agent 自适应改造，没有原生兼容档。
 *  · pi 生态 —— npm 上带 pi-package 关键词的扩展/技能/主题（registry.npmjs.org，CORS 开放）
 *  · DSH 社区 —— awesome-dsh-plugin.com/plugins.json（dsh-market 读取的同一注册表，CORS 开放）
 * DSH 注册表 5MB+：内存缓存 10 分钟；两源各自拉取、失败互不影响，可单独重试。
 * pi 生态按热度取前若干页（npm search 单页上限 250），月下载量用 npm 批量接口补齐。
 */

export type MarketSrc = "pi" | "dsh";

export type MarketPlugin = {
	/** src + id，页面内唯一。 */
	key: string;
	src: MarketSrc;
	/** 源内标识：npm 包名 / DSH 插件名。 */
	id: string;
	name: string;
	owner: string;
	ver?: string;
	/** 月下载量（拉不到为 null，展示为 —）。 */
	dl: number | null;
	stars: number;
	descZh: string;
	descEn: string;
	/** MARKET_CATS 里的 key。 */
	cat: string;
	/** 权限声明（注册表披露）。 */
	caps: string[];
	/** 权限红线（涉及 shell/网络等高危能力）。 */
	red: string[];
	/** 仓库或详情页。 */
	url: string;
	/** 源自带的安装命令（仅展示；owl 一律走 Agent 改造）。 */
	install?: string;
	added?: string;
};

export type MarketCat = { key: string; zh: string; en: string };

/** 分类沿用 DSH 注册表的类目（22 类），pi 包按关键词映射进同一套。 */
export const MARKET_CATS: MarketCat[] = [
	{ key: "ui", zh: "UI 增强", en: "UI Enhancements" },
	{ key: "tools", zh: "工具与能力", en: "Tools & Capabilities" },
	{ key: "dev", zh: "开发与运行时", en: "Development & Runtime" },
	{ key: "session", zh: "会话与消息", en: "Sessions & Messages" },
	{ key: "workflow", zh: "工作流与自动化", en: "Workflow & Automation" },
	{ key: "usage", zh: "用量与计费", en: "Usage & Billing" },
	{ key: "model", zh: "模型与接入", en: "Models & Providers" },
	{ key: "memory", zh: "记忆", en: "Memory" },
	{ key: "skill", zh: "技能包", en: "Skills" },
	{ key: "notify", zh: "通知与集成", en: "Notifications" },
	{ key: "theme", zh: "主题与外观", en: "Themes & Appearance" },
	{ key: "security", zh: "安全与权限", en: "Security & Permissions" },
	{ key: "remote", zh: "远程与移动端", en: "Remote & Mobile" },
	{ key: "fun", zh: "娱乐", en: "Just for Fun" },
	{ key: "git", zh: "Git 与评审", en: "Git & Review" },
	{ key: "vision", zh: "视觉与多模态", en: "Vision & Multimodal" },
	{ key: "browser", zh: "浏览器与网页", en: "Browser & Web" },
	{ key: "market", zh: "市场与管理", en: "Markets & Managers" },
	{ key: "docs", zh: "文档与渲染", en: "Docs & Rendering" },
	{ key: "agi", zh: "AGI 架构探索", en: "AGI Architecture" },
];

export const MARKET_CAT_KEYS = new Set(MARKET_CATS.map((c) => c.key));

const DSH_REGISTRY_URL = "https://awesome-dsh-plugin.com/plugins.json";
const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-month";
/** npm search 单页上限 250；取两页覆盖热度头部。 */
const PI_PAGES = 2;
const PI_PAGE_SIZE = 250;
const CACHE_TTL_MS = 10 * 60_000;

export type MarketSnapshot = {
	plugins: MarketPlugin[];
	dshTotal: number;
	piTotal: number;
	/** 各源最近一次成功拉取时间（失败则该源为空、错误单独给）。 */
	dshAt?: number;
	piAt?: number;
	dshError?: string;
	piError?: string;
};

type CacheEntry = { at: number; snapshot: MarketSnapshot };
let cache: CacheEntry | undefined;
let inflight: Promise<MarketSnapshot> | undefined;

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function fetchJson(url: string, timeoutMs = 30_000): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/** DSH 注册表：原字段即双语描述 + 能力声明 + 红线，规范化后直接可用。
 *  注册表里存在同名重复条目（4,414 条 ≈ 4,121 个唯一名），按名字去重、保留下载量最高的一条。 */
async function fetchDshPlugins(): Promise<{ plugins: MarketPlugin[]; total: number }> {
	const raw = await fetchJson(DSH_REGISTRY_URL);
	const root = (raw ?? {}) as Record<string, unknown>;
	const list = Array.isArray(root.plugins) ? root.plugins : [];
	const byName = new Map<string, MarketPlugin>();
	for (const item of list) {
		const p = (item ?? {}) as Record<string, unknown>;
		const desc = (p.description ?? {}) as Record<string, unknown>;
		const name = text(p.name) || text(p.npm);
		if (!name) continue;
		const category = text(p.category);
		const plugin: MarketPlugin = {
			key: `dsh:${name}`,
			src: "dsh",
			id: name,
			name,
			owner: text(p.owner),
			ver: text(p.version) || undefined,
			dl: typeof p.downloads === "number" ? p.downloads : null,
			stars: typeof p.stars === "number" ? p.stars : 0,
			descZh: text(desc.zh),
			descEn: text(desc.en) || text(desc.zh),
			cat: MARKET_CAT_KEYS.has(category) ? category : "tools",
			caps: strArray(p.capabilities),
			red: strArray(p.capabilityRedLines),
			url: text(p.url) || text(p.page),
			install: text(p.install) || undefined,
			added: text(p.added) || undefined,
		};
		const prev = byName.get(name);
		if (!prev || (plugin.dl ?? 0) > (prev.dl ?? 0)) byName.set(name, plugin);
	}
	const plugins = [...byName.values()];
	plugins.sort((a, b) => (b.dl ?? 0) - (a.dl ?? 0));
	return { plugins, total: typeof root.count === "number" ? root.count : plugins.length };
}

/** pi 包关键词 → 市场分类（命中优先级从上到下）。 */
function inferPiCat(keywords: string[], name: string): string {
	const joined = `${name} ${keywords.join(" ")}`.toLowerCase();
	const rules: Array<[string, string[]]> = [
		["skill", ["skill", "skills"]],
		["memory", ["memory", "context", "compaction", "rag"]],
		["theme", ["theme", "appearance"]],
		["browser", ["web", "search", "browser", "fetch", "youtube"]],
		["dev", ["lsp", "lens", "lint", "typecheck", "diagnostic", "observability", "trace"]],
		["docs", ["doc", "wiki", "docs"]],
		["git", ["git", "review", "commit"]],
		["notify", ["notify", "notification", "im", "telegram", "slack"]],
		["model", ["provider", "model", "router", "proxy"]],
		["session", ["session", "history", "transcript"]],
	];
	for (const [cat, words] of rules) {
		if (words.some((w) => joined.includes(w))) return cat;
	}
	return "tools";
}

/** npm search（关键词 pi-package）翻页拉取，规范化成市场条目。 */
async function fetchPiPlugins(): Promise<{ plugins: MarketPlugin[]; total: number }> {
	const seen = new Map<string, MarketPlugin>();
	let total = 0;
	for (let page = 0; page < PI_PAGES; page++) {
		const url = `${NPM_SEARCH_URL}?text=keywords:pi-package&size=${PI_PAGE_SIZE}&from=${page * PI_PAGE_SIZE}`;
		const raw = await fetchJson(url, 20_000);
		const root = (raw ?? {}) as Record<string, unknown>;
		if (page === 0 && typeof root.total === "number") total = root.total;
		const objects = Array.isArray(root.objects) ? root.objects : [];
		if (objects.length === 0) break;
		for (const object of objects) {
			const entry = (object ?? {}) as Record<string, unknown>;
			const pkg = (entry.package ?? {}) as Record<string, unknown>;
			const name = text(pkg.name);
			if (!name || seen.has(name)) continue;
			const keywords = strArray(pkg.keywords);
			const links = (pkg.links ?? {}) as Record<string, unknown>;
			const publisher = (pkg.publisher ?? {}) as Record<string, unknown>;
			seen.set(name, {
				key: `pi:${name}`,
				src: "pi",
				id: name,
				name,
				owner: text(publisher.username) || name.split("/")[0]?.replace(/^@/, "") || "",
				ver: text(pkg.version) || undefined,
				dl: null,
				stars: 0,
				descZh: "",
				descEn: text(pkg.description),
				cat: inferPiCat(keywords, name),
				caps: [],
				red: [],
				url: text(links.repository) || text(links.homepage) || `https://www.npmjs.com/package/${encodeURIComponent(name).replace(/%2F/g, "/")}`,
				added: text(pkg.date) ? new Date(text(pkg.date)).toISOString().slice(0, 10) : undefined,
			});
		}
	}
	// 月下载量补齐：普通包走 npm 批量接口（每批 100）；批量接口不支持 scope 包，小并发单查。
	// 失败的留空（展示为 —），不影响列表本身。
	const downloads = new Map<string, number>();
	const names = [...seen.keys()];
	const plain = names.filter((n) => !n.startsWith("@"));
	const scoped = names.filter((n) => n.startsWith("@"));
	for (let offset = 0; offset < plain.length; offset += 100) {
		const chunk = plain.slice(offset, offset + 100);
		try {
			const raw = await fetchJson(`${NPM_DOWNLOADS_URL}/${chunk.map(encodeURIComponent).join(",")}`, 20_000);
			const root = (raw ?? {}) as Record<string, unknown>;
			for (const name of chunk) {
				const item = root[name] as Record<string, unknown> | undefined;
				if (item && typeof item.downloads === "number") downloads.set(name, item.downloads);
			}
		} catch {
			// 整批失败就放弃这一批，下载量留空。
		}
	}
	{
		let cursor = 0;
		const concurrency = Math.min(6, scoped.length);
		await Promise.all(Array.from({ length: concurrency }, async () => {
			while (cursor < scoped.length) {
				const name = scoped[cursor++];
				try {
					const raw = await fetchJson(`${NPM_DOWNLOADS_URL}/${encodeURIComponent(name)}`, 12_000);
					const item = (raw ?? {}) as Record<string, unknown>;
					if (typeof item.downloads === "number") downloads.set(name, item.downloads);
				} catch {
					// 单查失败留空。
				}
			}
		}));
	}
	for (const plugin of seen.values()) plugin.dl = downloads.get(plugin.id) ?? null;
	const plugins = [...seen.values()];
	plugins.sort((a, b) => (b.dl ?? 0) - (a.dl ?? 0));
	return { plugins, total: total || plugins.length };
}

async function refresh(): Promise<MarketSnapshot> {
	const [dsh, pi] = await Promise.allSettled([fetchDshPlugins(), fetchPiPlugins()]);
	const snapshot: MarketSnapshot = { plugins: [], dshTotal: 0, piTotal: 0 };
	if (dsh.status === "fulfilled") {
		snapshot.plugins.push(...dsh.value.plugins);
		snapshot.dshTotal = dsh.value.total;
		snapshot.dshAt = Date.now();
	} else {
		snapshot.dshError = dsh.reason instanceof Error ? dsh.reason.message : String(dsh.reason);
	}
	if (pi.status === "fulfilled") {
		snapshot.plugins.push(...pi.value.plugins);
		snapshot.piTotal = pi.value.total;
		snapshot.piAt = Date.now();
	} else {
		snapshot.piError = pi.reason instanceof Error ? pi.reason.message : String(pi.reason);
	}
	cache = { at: Date.now(), snapshot };
	return snapshot;
}

/** 拉取市场数据：缓存未过期直接返回；force 时绕过缓存重拉。 */
export async function loadMarket(force = false): Promise<MarketSnapshot> {
	if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.snapshot;
	if (!inflight) {
		inflight = refresh().finally(() => {
			inflight = undefined;
		});
	}
	return inflight;
}

/** 组装「引入给 Agent」的改造任务提示词（会话语言由用户输入决定，这里固定中文任务书）。 */
export function buildImportPrompt(plugin: MarketPlugin, agentDir: string, workspaceDir: string): string {
	const dir = agentDir.trim() || "~/.owl/agent";
	const srcLabel = plugin.src === "pi" ? "pi 生态（npm）" : "DSH 社区（DeepSeek Harness）";
	const perms = plugin.caps.length ? plugin.caps.join("、") : "未声明";
	const reds = plugin.red.length ? plugin.red.join("、") : "无";
	return [
		"请把下面的社区插件自适应改造为 Owl 的原生能力。Owl 与 pi / DSH 的插件 API 不兼容，需要你分析后改造，不要假设接口可直接使用。",
		"",
		`插件：${plugin.name}（${srcLabel}${plugin.ver ? ` · ${plugin.ver}` : ""}）`,
		`来源：${plugin.url}`,
		`简介：${plugin.descZh || plugin.descEn}`,
		`权限声明：${perms}；权限红线：${reds}`,
		"",
		"请按以下流程工作：",
		"1. 拉取并阅读源码；先审查再运行，不要执行来源不明的构建脚本。",
		"2. 分析它的集成点：扩展注册、钩子、命令、UI 注入、技能/主题格式等。",
		"3. 给出改造方案：把每个源机制映射到 Owl 的对应能力（桌面端视图/面板、扩展、技能 SKILL.md、主题），标注哪些可直接复用、哪些需要写垫片；方案先给我确认。",
		"4. 我确认后再实施改造，产物安装到 agent 目录：",
		`   扩展 → ${dir}/npm ，技能 → ${dir}/skills ，主题 → ${dir}/themes`,
		"5. 安装后做最小验证（重载生效/冒烟调用），最后汇报：装了什么、改了哪些文件、如何卸载。",
		"",
		`当前工作目录：${workspaceDir}`,
		plugin.src === "dsh"
			? "注意：若它依赖 DSH 专有 API（如侧栏 Tab 注册、会话钩子），请以 Owl 的等价机制替代；确实无法替代的部分要明确说明，并给出最接近的 Owl 方案。"
			: "注意：它是 pi 扩展/技能，接口以 Owl 现状为准做适配；无法复用的部分明确说明。",
	].join("\n");
}
