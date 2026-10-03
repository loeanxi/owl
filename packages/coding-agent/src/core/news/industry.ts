/**
 * Adapted from KKKKhazix/AIHOT (main cc66cceb).
 * MIT License
 *
 * Copyright (c) 2026 数字生命卡兹克
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { NewsConfiguration, NewsSourceInput, NewsTopic } from "./types.ts";

// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（教程、观点）：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
	{
		key: "ai-models",
		label: "模型",
		section: "模型发布/更新",
		guide: "模型本身的发布、版本、权重开放、能力或价格变化，以及既有榜单上的模型成绩。公布一次跑分不是发布新基准，也不是教程。",
	},
	{
		key: "ai-products",
		label: "产品",
		section: "产品发布/更新",
		guide: "可使用的 AI 产品、功能、应用、工具、API、平台和工程组件的发布更新。模型厂商发布的推理框架、算子库、硬件适配组件仍是产品，不能因为厂商名归成模型。",
	},
	{
		key: "industry",
		label: "行业",
		section: "行业动态",
		guide: "已发生的公司经营、融资并购、人事、合作、诉讼、政策、真实安全事故及调查进展。新闻由当事人发帖、带有态度，也不因此变成观点。",
	},
	{
		key: "paper",
		label: "论文",
		section: "论文研究",
		guide: "以新研究方法、实验设计与发现为核心的论文、技术报告、新基准或研究数据集。系统性红队实验属于研究；既有榜单成绩归模型，真实事故的新闻调查归行业。",
	},
	{
		key: "tip",
		label: "教程",
		section: "技巧与观点",
		guide: "读者可以照着使用的方法、提示词、工具用法、工程实践复盘与技术讲解。重点是可复用的做法；单纯发布工具归产品，只有态度和预测而无做法归观点。",
		commentary: true,
	},
	{
		key: "opinion",
		label: "观点",
		section: "技巧与观点",
		guide: "重点是作者的解释、判断、主张、预测、评论或访谈观点。讨论市场不自动归行业，作者是名人不自动归观点。",
		commentary: true,
	},
] as const satisfies ReadonlyArray<{ key: string; label: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布（AI 行业是新模型）：日报报头的“N 个新模型”、改分类后修订已出的报告、
 * 公司编年史的上面一行都按它数。category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 * 没有这样一类的行业设成 null，报头就不显示这个数。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = {
	category: "ai-models",
	tag: "模型发布",
	unit: "个新模型",
};

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["ai", "api", "llm", "gpu", "agi", "ceo", "ipo"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = [
	"model_release",
	"product_launch",
	"tool_or_prompt",
	"research_paper",
	"industry_event",
	"opinion_analysis",
	"tutorial_explainer",
] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
	"产品更新",
	"模型发布",
	"论文/研究",
	"开源/仓库",
	"教程/实践",
	"现象/趋势",
	"大佬观点",
	"评测/基准",
	"安全/对齐",
	"行业动态",
	"政策/监管",
	"非AI/通用工具",
	"其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
	"Agent",
	"编码",
	"推理",
	"多模态",
	"语音",
	"视频",
	"图像生成",
	"RAG",
	"端侧",
	"数据/训练",
	"搜索",
	"部署/工程",
	"开源生态",
	"具身智能",
	"MCP/工具调用",
] as const;

/** 可选的实体标签（公司、机构、平台）。 */
export const ENTITY_TAGS = [
	"OpenAI",
	"Anthropic",
	"DeepSeek",
	"DeepMind",
	"Google",
	"Meta",
	"Microsoft",
	"xAI",
	"Hugging Face",
	"GitHub",
	"arXiv",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
	"教程/玩法": "教程/实践",
	"技巧/最佳实践": "教程/实践",
	"合作/生态": "行业动态",
	"融资/收购": "行业动态",
	公司动态: "行业动态",
	合作: "行业动态",
	生态: "行业动态",
	融资: "行业动态",
	收购: "行业动态",
	投资: "行业动态",
	并购: "行业动态",
	政策: "政策/监管",
	监管: "政策/监管",
	法规: "政策/监管",
	安全: "安全/对齐",
	对齐: "安全/对齐",
	论文: "论文/研究",
	研究: "论文/研究",
	paper: "论文/研究",
	papers: "论文/研究",
	"open-source": "开源/仓库",
	开源: "开源/仓库",
	仓库: "开源/仓库",
	repo: "开源/仓库",
	教程: "教程/实践",
	玩法: "教程/实践",
	指南: "教程/实践",
	技巧: "教程/实践",
	最佳实践: "教程/实践",
	实践: "教程/实践",
	产品: "产品更新",
	更新: "产品更新",
	发布: "模型发布",
	模型: "模型发布",
	趋势: "现象/趋势",
	现象: "现象/趋势",
	观点: "大佬观点",
	视频生成: "视频",
	非ai: "非AI/通用工具",
	"non-ai": "非AI/通用工具",
	通用工具: "非AI/通用工具",
	工程工具: "非AI/通用工具",
	安全扫描: "非AI/通用工具",
	devops: "非AI/通用工具",
	行业: "行业动态",
	动态: "行业动态",
};

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 公司主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * aliases 给结构抽取模型看；otherNames 是公司自己的其他称呼（官方账号名、子品牌），
 * 把事实的主体对到发布方时也认它们。
 */
export const ENTITIES: Record<
	string,
	{ name: string; displayTag: string | null; aliases: string[]; otherNames?: string[] }
> = {
	openai: {
		name: "OpenAI",
		displayTag: "OpenAI",
		aliases: ["OpenAI", "ChatGPT", "Sora", "Codex", "GPT"],
		otherNames: ["OpenAI Developers"],
	},
	anthropic: {
		name: "Anthropic",
		displayTag: "Anthropic",
		aliases: ["Anthropic", "Claude"],
		otherNames: ["Claude Code"],
	},
	google: {
		name: "Google",
		displayTag: "Google",
		aliases: ["Google", "DeepMind", "Gemini", "谷歌"],
		otherNames: ["Google DeepMind", "Google Research", "Google AI", "Google Labs", "Google Cloud"],
	},
	deepseek: { name: "DeepSeek", displayTag: "DeepSeek", aliases: ["DeepSeek", "深度求索"] },
	qwen: {
		name: "千问 Qwen",
		displayTag: null,
		aliases: ["Qwen", "通义", "阿里"],
		otherNames: [
			"通义千问",
			"千问",
			"千问APP",
			"Qwen Team",
			"通义实验室",
			"阿里巴巴",
			"Alibaba",
			"阿里云",
			"Alibaba Cloud",
		],
	},
	kimi: {
		name: "Kimi / 月之暗面",
		displayTag: null,
		aliases: ["Kimi", "月之暗面", "Moonshot"],
		otherNames: ["Moonshot AI"],
	},
	minimax: { name: "MiniMax", displayTag: null, aliases: ["MiniMax", "海螺"], otherNames: ["稀宇科技"] },
	zhipu: {
		name: "智谱 GLM",
		displayTag: null,
		aliases: ["智谱", "GLM", "Z.ai"],
		otherNames: ["智谱AI", "Zhipu", "Zhipu AI"],
	},
	xai: { name: "xAI", displayTag: "xAI", aliases: ["xAI", "Grok"], otherNames: ["SpaceXAI"] },
	meta: { name: "Meta", displayTag: "Meta", aliases: ["Meta", "Llama"], otherNames: ["Meta AI", "AI at Meta"] },
	microsoft: {
		name: "Microsoft",
		displayTag: "Microsoft",
		aliases: ["Microsoft", "微软", "Copilot"],
		otherNames: ["Microsoft Research", "Microsoft AI"],
	},
	nvidia: { name: "NVIDIA", displayTag: null, aliases: ["NVIDIA", "英伟达"] },
	"hugging-face": {
		name: "Hugging Face",
		displayTag: "Hugging Face",
		aliases: ["Hugging Face"],
		otherNames: ["HuggingFace"],
	},
	cursor: { name: "Cursor", displayTag: null, aliases: ["Cursor", "Anysphere"] },
	openrouter: { name: "OpenRouter", displayTag: null, aliases: ["OpenRouter"] },
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 行业没有这个问题时可以留空数组。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
	{ id: "openai", name: "OpenAI", patterns: [/openai|chatgpt|\bgpt-?[o\d]|\bsora\b|\bcodex\b/i] },
	{
		id: "anthropic",
		name: "Anthropic",
		patterns: [
			/anthropic|\bclaude\b/i,
			/\b(?:opus|sonnet|haiku)\s*\d+(?:[.-]\d+)*\b/i,
			/\bfable\s*\d+(?:[.-]\d+)*\b|\bmythos\b/i,
		],
	},
	{
		id: "google",
		name: "Google / Gemini",
		patterns: [/google|deepmind|\bgemini\b|notebooklm|\bveo\s?\d|\bAlphaFold\b|\bAMIE\b/i],
	},
	{ id: "deepseek", name: "DeepSeek", patterns: [/deepseek|深度求索/i] },
	{ id: "xai", name: "xAI / Grok", patterns: [/\bxai\b|\bgrok\b/i] },
	{ id: "meta", name: "Meta / Llama", patterns: [/\bMeta\b/, /\bmeta\s?ai\b|\bllama\b/i] },
	{ id: "microsoft", name: "Microsoft / Copilot", patterns: [/microsoft|copilot|微软/i] },
	{
		id: "nvidia",
		name: "NVIDIA",
		patterns: [/nvidia|英伟达|\bnemotron\b|\bnemo\b|\bblackwell\b|\brubin(?:\s+ultra)?\b|\bcuda\b/i],
	},
	{ id: "qwen", name: "千问 Qwen", patterns: [/\bqwen|通义|千问/i] },
	{ id: "hugging-face", name: "Hugging Face", patterns: [/hugging\s?face/i] },
	{ id: "cursor", name: "Cursor", patterns: [/\bCursor\b/] },
	{ id: "kimi", name: "Kimi / 月之暗面", patterns: [/\bkimi\b|月之暗面|\bmoonshot\s?ai\b/i] },
	{ id: "openrouter", name: "OpenRouter", patterns: [/openrouter/i] },
	{ id: "minimax", name: "MiniMax", patterns: [/minimax/i] },
	{ id: "zhipu", name: "智谱 GLM", patterns: [/智谱|\bglm-?[4-9]/i] },
	{ id: "hunyuan", name: "腾讯混元", patterns: [/混元|hunyuan/i] },
	{ id: "doubao", name: "字节豆包", patterns: [/豆包|doubao|字节跳动|bytedance/i] },
	{ id: "mistral", name: "Mistral", patterns: [/mistral/i] },
	{ id: "perplexity", name: "Perplexity", patterns: [/\bPerplexity\b/] },
	{ id: "runway", name: "Runway", patterns: [/\brunway\b/i] },
	{ id: "suno", name: "Suno", patterns: [/\bsuno\b/i] },
	{ id: "midjourney", name: "Midjourney", patterns: [/midjourney/i] },
	{ id: "stability-ai", name: "Stability AI", patterns: [/stability\s?ai/i] },
	{ id: "elevenlabs", name: "ElevenLabs", patterns: [/eleven\s?labs/i] },
	{ id: "vllm", name: "vLLM", patterns: [/\bvllm\b/i] },
	{ id: "ollama", name: "Ollama", patterns: [/\bollama\b/i] },
	{ id: "windsurf", name: "Windsurf", patterns: [/windsurf/i] },
	{ id: "devin", name: "Devin", patterns: [/\bdevin\b/i] },
	{ id: "manus", name: "Manus", patterns: [/\bmanus\b/i] },
	{ id: "apple", name: "Apple AI", patterns: [/\bapple\s?(intelligence|silicon|ai)\b|苹果(智能|\s?AI)/i] },
	{ id: "amazon", name: "Amazon / AWS", patterns: [/amazon|\baws\b|亚马逊/i] },
	{ id: "baidu", name: "百度文心", patterns: [/百度|baidu|文心|\bernie\s?bot\b/i] },
];

/** 这些域名上的文章，发布方就是对应的公司（托管平台如 GitHub、arXiv 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
	{ entityId: "openai", domains: ["openai.com"] },
	{ entityId: "anthropic", domains: ["anthropic.com", "claude.com"] },
	{ entityId: "google", domains: ["deepmind.google", "ai.google", "blog.google"] },
	{ entityId: "deepseek", domains: ["deepseek.com"] },
	{ entityId: "xai", domains: ["x.ai"] },
	{ entityId: "meta", domains: ["ai.meta.com"] },
	{ entityId: "microsoft", domains: ["microsoft.com"] },
	{ entityId: "nvidia", domains: ["nvidia.com"] },
	{ entityId: "qwen", domains: ["qwen.ai"] },
	{ entityId: "cursor", domains: ["cursor.com"] },
	{ entityId: "openrouter", domains: ["openrouter.ai"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
	{ entityId: "meta", pattern: /@AIatMeta\b/i },
	{ entityId: "zhipu", pattern: /\bZhipu(?:\s+AI\b|['’]s\b)/i },
];

export const NEWS_CATEGORIES = CATEGORIES.map(({ key, label }) => ({ id: key, label }));

export const NEWS_TOPICS: NewsTopic[] = [
	{
		id: "openai",
		name: "OpenAI / ChatGPT",
		group: "company",
		tags: [],
		entities: ["openai"],
		count: 0,
	},
	{
		id: "anthropic",
		name: "Anthropic / Claude",
		group: "company",
		tags: [],
		entities: ["anthropic"],
		count: 0,
	},
	{
		id: "google",
		name: "Google / Gemini",
		group: "company",
		tags: [],
		entities: ["google"],
		count: 0,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		group: "company",
		tags: [],
		entities: ["deepseek"],
		count: 0,
	},
	{
		id: "qwen",
		name: "千问 Qwen",
		group: "company",
		tags: [],
		entities: ["qwen"],
		count: 0,
	},
	{
		id: "kimi",
		name: "Kimi / 月之暗面",
		group: "company",
		tags: [],
		entities: ["kimi"],
		count: 0,
	},
	{
		id: "minimax",
		name: "MiniMax",
		group: "company",
		tags: [],
		entities: ["minimax"],
		count: 0,
	},
	{
		id: "zhipu",
		name: "智谱 GLM",
		group: "company",
		tags: [],
		entities: ["zhipu"],
		count: 0,
	},
	{
		id: "xai",
		name: "xAI / Grok",
		group: "company",
		tags: [],
		entities: ["xai"],
		count: 0,
	},
	{
		id: "meta",
		name: "Meta / Llama",
		group: "company",
		tags: [],
		entities: ["meta"],
		count: 0,
	},
	{
		id: "microsoft",
		name: "Microsoft / Copilot",
		group: "company",
		tags: [],
		entities: ["microsoft"],
		count: 0,
	},
	{
		id: "nvidia",
		name: "NVIDIA 英伟达",
		group: "company",
		tags: [],
		entities: ["nvidia"],
		count: 0,
	},
	{
		id: "hugging-face",
		name: "Hugging Face",
		group: "company",
		tags: [],
		entities: ["hugging-face"],
		count: 0,
	},
	{
		id: "cursor",
		name: "Cursor",
		group: "company",
		tags: [],
		entities: ["cursor"],
		count: 0,
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		group: "company",
		tags: [],
		entities: ["openrouter"],
		count: 0,
	},
	{
		id: "agent",
		name: "Agent 智能体",
		group: "field",
		tags: ["Agent"],
		entities: [],
		count: 0,
	},
	{
		id: "coding",
		name: "AI 编码",
		group: "field",
		tags: ["编码"],
		entities: [],
		count: 0,
	},
	{
		id: "reasoning",
		name: "推理能力",
		group: "field",
		tags: ["推理"],
		entities: [],
		count: 0,
	},
	{
		id: "multimodal",
		name: "多模态",
		group: "field",
		tags: ["多模态"],
		entities: [],
		count: 0,
	},
	{
		id: "image-gen",
		name: "图像生成",
		group: "field",
		tags: ["图像生成"],
		entities: [],
		count: 0,
	},
	{
		id: "video",
		name: "AI 视频",
		group: "field",
		tags: ["视频"],
		entities: [],
		count: 0,
	},
	{
		id: "voice",
		name: "语音与音频",
		group: "field",
		tags: ["语音"],
		entities: [],
		count: 0,
	},
	{
		id: "embodied",
		name: "具身智能",
		group: "field",
		tags: ["具身智能"],
		entities: [],
		count: 0,
	},
	{
		id: "on-device",
		name: "端侧 AI",
		group: "field",
		tags: ["端侧"],
		entities: [],
		count: 0,
	},
	{
		id: "open-source",
		name: "开源生态",
		group: "field",
		tags: ["开源生态", "开源/仓库"],
		entities: [],
		count: 0,
	},
	{
		id: "engineering",
		name: "部署工程",
		group: "field",
		tags: ["部署/工程"],
		entities: [],
		count: 0,
	},
	{
		id: "data-training",
		name: "数据与训练",
		group: "field",
		tags: ["数据/训练"],
		entities: [],
		count: 0,
	},
	{
		id: "safety",
		name: "安全对齐",
		group: "field",
		tags: ["安全/对齐"],
		entities: [],
		count: 0,
	},
	{
		id: "mcp",
		name: "MCP 与工具调用",
		group: "field",
		tags: ["MCP/工具调用"],
		entities: [],
		count: 0,
	},
	{
		id: "model-releases",
		name: "模型发布",
		group: "genre",
		tags: ["模型发布"],
		entities: [],
		count: 0,
	},
	{
		id: "product-updates",
		name: "产品更新",
		group: "genre",
		tags: ["产品更新"],
		entities: [],
		count: 0,
	},
	{
		id: "papers",
		name: "论文研究",
		group: "genre",
		tags: ["论文/研究"],
		entities: [],
		count: 0,
	},
	{
		id: "benchmarks",
		name: "评测基准",
		group: "genre",
		tags: ["评测/基准"],
		entities: [],
		count: 0,
	},
	{
		id: "tutorials",
		name: "教程实践",
		group: "genre",
		tags: ["教程/实践"],
		entities: [],
		count: 0,
	},
	{
		id: "opinions",
		name: "大佬观点",
		group: "genre",
		tags: ["大佬观点"],
		entities: [],
		count: 0,
	},
	{
		id: "trends",
		name: "现象与趋势",
		group: "genre",
		tags: ["现象/趋势"],
		entities: [],
		count: 0,
	},
	{
		id: "industry",
		name: "行业动态",
		group: "genre",
		tags: ["行业动态"],
		entities: [],
		count: 0,
	},
	{
		id: "policy",
		name: "政策监管",
		group: "genre",
		tags: ["政策/监管"],
		entities: [],
		count: 0,
	},
];

export const DEMO_NEWS_SOURCES: NewsSourceInput[] = [
	{
		id: "rss-openai-news",
		name: "OpenAI News",
		kind: "rss",
		config: {
			feedUrl: "https://openai.com/news/rss.xml",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		owner: "openai",
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-google-deepmind",
		name: "Google DeepMind",
		kind: "rss",
		config: {
			feedUrl: "https://deepmind.google/blog/rss.xml",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		owner: "google",
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-google-research",
		name: "Google Research",
		kind: "rss",
		config: {
			feedUrl: "https://research.google/blog/rss/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		owner: "google",
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-hugging-face",
		name: "Hugging Face Blog",
		kind: "rss",
		config: {
			feedUrl: "https://huggingface.co/blog/feed.xml",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		owner: "hugging-face",
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-microsoft-research",
		name: "Microsoft Research",
		kind: "rss",
		config: {
			feedUrl: "https://www.microsoft.com/en-us/research/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		owner: "microsoft",
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-nvidia-blog",
		name: "NVIDIA Blog",
		kind: "rss",
		config: {
			feedUrl: "https://blogs.nvidia.com/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		owner: "nvidia",
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-aws-ml",
		name: "AWS Machine Learning Blog",
		kind: "rss",
		config: {
			feedUrl: "https://aws.amazon.com/blogs/machine-learning/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-github-ai",
		name: "GitHub Blog · AI & ML",
		kind: "rss",
		config: {
			feedUrl: "https://github.blog/ai-and-ml/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-mistral",
		name: "Mistral AI",
		kind: "rss",
		config: {
			feedUrl: "https://mistral.ai/rss.xml",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-bair",
		name: "Berkeley AI Research",
		kind: "rss",
		config: {
			feedUrl: "https://bair.berkeley.edu/blog/feed.xml",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T1",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 180,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-the-verge-ai",
		name: "The Verge · AI",
		kind: "rss",
		config: {
			feedUrl: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 60,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-techcrunch-ai",
		name: "TechCrunch · AI",
		kind: "rss",
		config: {
			feedUrl: "https://techcrunch.com/category/artificial-intelligence/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 60,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-ars-technica-ai",
		name: "Ars Technica · AI",
		kind: "rss",
		config: {
			feedUrl: "https://arstechnica.com/ai/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 60,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-mit-tech-review-ai",
		name: "MIT Technology Review · AI",
		kind: "rss",
		config: {
			feedUrl: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-the-decoder",
		name: "The Decoder",
		kind: "rss",
		config: {
			feedUrl: "https://the-decoder.com/feed/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 60,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-simon-willison",
		name: "Simon Willison",
		kind: "rss",
		config: {
			feedUrl: "https://simonwillison.net/atom/everything/",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 120,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-import-ai",
		name: "Import AI",
		kind: "rss",
		config: {
			feedUrl: "https://importai.substack.com/feed",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 180,
		siteFulltext: false,
		syndicateFulltext: false,
	},
	{
		id: "rss-latent-space",
		name: "Latent Space",
		kind: "rss",
		config: {
			feedUrl: "https://www.latent.space/feed",
			_aihot: {
				initialBackfillLimit: 8,
			},
		},
		tier: "T2",
		participation: "editorial",
		enabled: true,
		intervalMinutes: 180,
		siteFulltext: false,
		syndicateFulltext: false,
	},
];

export const DEFAULT_NEWS_CONFIGURATION: NewsConfiguration = {
	collectEnabled: false,
	modelCallsEnabled: false,
	intervalMinutes: 30,
	maxItemsPerSource: 30,
	retentionDays: 90,
	models: {},
	thresholds: { T1: 60, T1_5: 65, T2: 76, EXCLUDE_MP: null },
	understandFloor: 50,
	budget: { perMinute: 30, perHour: 300, perDay: 2000 },
	embedding: { enabled: false, baseUrl: "", model: "", dimensions: null },
	serviceStatus: {},
	allowPrivateNetwork: false,
};
