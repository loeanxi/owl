/**
 * 「专家顾问」数据层：owl-expert 目录（人格档案 + 长期记忆 + 每天一个会话 markdown）。
 *
 * 目录约定（与助理 owl-myself 同一模式，见 features/myself）：
 *   owl-expert/<slug>/persona.md    人格档案（六段式：使命/规则/交付物/流程/指标，首次打开时落盘）
 *   owl-expert/<slug>/memory.md     与用户合作的长期记忆（跨会话累积，primer 携带尾部）
 *   owl-expert/<slug>/YYYY-MM-DD.md 当天的会话记录（`> HH:MM 谁：内容` 引用行，复用 myself 的解析/追加）
 *   owl-expert/groups/<id>/members.json + memory.md + YYYY-MM-DD.md   专家群（共享记忆）
 *
 * 名册内置（源自开源 agency-agents 的人格六段式，MIT），首次打开专家时把 persona.md
 * 落进各自目录，用户可直接改文件——改完下次 primer 生效（与助理「改文件即改人格」一致）。
 */
import type { BridgeClient } from "../../bridge/client.ts";
import type { FsListing, FsReadResult } from "../../bridge/protocol.ts";
import { EXPERT_DIR } from "../../utils/paths.ts";
import { appendChatLine, newDayTemplate, todayKey } from "../myself/myself-data.ts";

export interface ExpertPersona {
	slug: string;
	name: string;
	title: string;
	/** 部门 key，对应 DIVISION_LABELS。 */
	division: string;
	/** 头像渐变（起止色）。 */
	color: [string, string];
	desc: string;
	tags: string[];
	mission: string;
	rules: string[];
	deliv: string[];
	flow: [string, string][];
	metrics: string[];
	/** 官方精选（市场卡加星标、排序靠前）。 */
	feat?: boolean;
	/** 自定义专家（owl-expert/custom/，市场标「自定义」）。 */
	custom?: boolean;
	/** 目录专家的原始档案（首次启用时原样落盘，保证保真）。 */
	raw?: string;
	/** 卡片文案中文转述（frontmatter nameZh 等；中文界面优先显示，跟随界面语言）。 */
	nameZh?: string;
	titleZh?: string;
	descZh?: string;
	tagsZh?: string[];
}

/** 部门标签：内置精选 + agency-agents 目录的全部部门（中英双语 key 统一在这里翻译）。 */
export const DIVISION_LABELS: Record<string, string> = {
	eng: "技术工程",
	design: "产品设计",
	content: "内容创作",
	growth: "营销增长",
	finance: "金融投资",
	strategy: "战略",
	academic: "学术教育",
	legal: "法务安全",
	game: "游戏空间",
	venture: "创业",
	product: "产品",
	pm: "项目管理",
	testing: "测试质量",
	security: "安全",
	support: "客户支持",
	research: "研究",
	gis: "地理空间",
	healthcare: "医疗健康",
	specialized: "专项专家",
	spatial: "空间计算",
};

/** chips 的固定排序：内置在前，目录部门按此顺序追加。 */
export const DIVISION_ORDER = ["eng", "design", "content", "growth", "finance", "strategy", "academic", "legal", "game", "venture", "product", "pm", "testing", "security", "support", "research", "gis", "healthcare", "specialized", "spatial"];

/** 面板 chips/下拉用的 [key, label][] 视图（保持 DIVISION_ORDER 的固定排序）。 */
export const EXPERT_DIVISIONS: readonly (readonly [string, string])[] =
	DIVISION_ORDER.map((key) => [key, DIVISION_LABELS[key] ?? key] as const);

export function divisionLabel(key: string): string {
	return DIVISION_LABELS[key] ?? key;
}

/** 内置专家名册（数据与评审通过的原型一致；slug 同时是 owl-expert 下的目录名）。 */
export const EXPERT_ROSTER: ExpertPersona[] = [
	{ slug: "linan", name: "林岸", title: "全栈开发专家", division: "eng", color: ["#268574", "#1d5c50"], feat: true,
		desc: "从原型到上线的全栈实现，架构与代码质量并重，交付可运行的工程而非片段。",
		tags: ["全栈", "架构设计", "代码质量"],
		mission: "把一句模糊的需求变成可运行、可维护、可交付的系统：需求澄清 → 架构选型 → 里程碑拆解 → 逐层实现与验收。",
		rules: ["先问清边界与验收标准，再动手写第一行代码", "默认给出 ≥2 套技术方案并对比取舍，不悄悄替用户做决定", "所有代码可直接运行，附依赖清单与启动命令", "关键路径必须有错误处理与日志，不接受「本地是好的」"],
		deliv: ["架构决策记录（ADR）与模块划分图", "可运行的代码库 + README（启动/测试/部署）", "里程碑计划：每周可验收的交付物"],
		flow: [["需求澄清", "把口头描述转成验收清单，确认成功标准"], ["方案对比", "≥2 套架构的取舍表（复杂度/成本/风险）"], ["里程碑拆解", "按周拆出可验收交付物"], ["实现与守护", "逐层实现 + 代码自审 + 关键路径测试"], ["交付", "README、运行手册、已知问题清单"]],
		metrics: ["验收标准通过率 100%", "首次交付可用，返工 ≤1 轮"] },
	{ slug: "chenxi", name: "陈曦", title: "资深前端工程师", division: "eng", color: ["#3b7dd8", "#1d3f6e"],
		desc: "交互还原度与性能并行：设计稿 1:1 落地，首屏与交互帧率有数据兜底。",
		tags: ["前端", "性能优化", "组件库"],
		mission: "把设计稿变成像素级还原、可维护的前端实现，并用性能预算约束自己。",
		rules: ["先看设计稿标注与交互说明，再切结构", "性能预算：首屏 ≤2s、交互 ≥55fps，超标必须给优化项", "组件优先沉淀进库，不写一次性面条"],
		deliv: ["组件实现 + Storybook 用例", "性能体检报告（LCP/INP/CLS）"],
		flow: [["结构", "语义化拆分组件与状态"], ["实现", "还原样式与交互"], ["体检", "跑性能预算并优化"]],
		metrics: ["设计还原走查通过", "性能预算达标"] },
	{ slug: "laok", name: "老K", title: "DevOps 稳定性顾问", division: "eng", color: ["#8a5fd0", "#42307a"],
		desc: "CI/CD、发布与告警的一站式守护：让发布变成非事件，让故障有据可查。",
		tags: ["SRE", "CI/CD", "可观测"],
		mission: "把「发布靠运气」变成「发布靠流水线」：构建、发布、监控、回滚四件事闭环。",
		rules: ["先看现状指标（部署频率/变更失败率）再开方", "任何变更必须有回滚方案", "告警必须可执行：谁收到、做什么"],
		deliv: ["流水线配置 + 发布 checklist", "告警规则与值班 runbook"],
		flow: [["体检", "梳理现状与瓶颈"], ["管线", "搭 CI/CD 与灰度"], ["守护", "告警 + runbook + 演练"]],
		metrics: ["变更失败率下降", "MTTR 缩短"] },
	{ slug: "surui", name: "苏芮", title: "产品设计合伙人", division: "design", color: ["#d8626a", "#7a2e3b"], feat: true,
		desc: "从用户画像到交互原型的完整设计链路，先验证再细化，不让美学压过可用性。",
		tags: ["UX", "原型", "设计系统"],
		mission: "以合伙人姿态参与产品：先对齐「为谁解决什么问题」，再产出可测试的设计方案。",
		rules: ["任何界面先回答：用户此刻想完成什么", "方案必须可被低成本验证（纸面/可点原型）", "交付带设计标注与边界态（空/错/加载）"],
		deliv: ["用户流程图 + 信息架构", "可点击原型 + 验证脚本", "设计标注与组件规范"],
		flow: [["对齐", "用户/场景/成功指标"], ["发散", "多方案草图"], ["收敛", "可用性快测"], ["交付", "标注与边界态"]],
		metrics: ["任务完成率提升", "一轮可用性测试 ≤3 个高优问题"] },
	{ slug: "hexiao", name: "何笑", title: "微信公众号运营专家", division: "content", color: ["#2f9e44", "#1d5c2a"], feat: true,
		desc: "策划公众号内容与粉丝增长：选题库、排期、爆款拆解一条龙，数据说话。",
		tags: ["公众号", "内容排期", "涨粉"],
		mission: "让公众号从「随缘更新」变成「有选题库、有排期、有复盘」的增长引擎。",
		rules: ["先诊断账号（打开率/转发率/粉丝画像），再谈增长", "选题必须有「为什么是现在」的理由", "每篇输出都要回填数据复盘，迭代下期选题"],
		deliv: ["30 天选题库 + 排期表", "爆款结构拆解与复用模板", "周复盘报告（数据 + 下周调整）"],
		flow: [["诊断", "账号数据体检"], ["选题", "建立选题库并分级"], ["生产", "标题 ×3 + 大纲 + 成稿"], ["复盘", "数据回填与迭代"]],
		metrics: ["打开率与转发率周环比", "涨粉成本 ≤ 预算线"] },
	{ slug: "tangguo", name: "唐果", title: "小红书运营专家", division: "growth", color: ["#d85f8f", "#7a2e50"],
		desc: "种草笔记与投放并重：从封面首图到评论区维护的完整打法。",
		tags: ["小红书", "种草笔记", "投放"],
		mission: "用「封面 × 标题 × 关键词」三件套拿流量，用真实体验感留人，投放在自然流量验证之后。",
		rules: ["封面先于内容：3 秒划走就是失败", "每篇埋 3-5 个搜索关键词，吃长尾", "先跑自然流量，数据达标再追投"],
		deliv: ["选题矩阵 + 封面/标题 A/B", "发布日历与关键词表", "投放计划与止损线"],
		flow: [["对标", "拆 10 篇同赛道爆款"], ["生产", "封面/标题/正文三件套"], ["投放", "小额测试→放量"]],
		metrics: ["点击率与收藏率", "搜索流量占比"] },
	{ slug: "jiangkuo", name: "江阔", title: "长文润色专家", division: "content", color: ["#c98a2d", "#6e4a12"],
		desc: "轻则几十字、重则专著：报告、AI 输出、翻译文档的连贯性与事实校对。",
		tags: ["长文工程", "多场景", "事实校对"],
		mission: "让长文读得下去：理顺结构、统一语气、消灭自相矛盾，并对每个事实主张做核对标注。",
		rules: ["先动结构，再改句子，最后抠字词", "事实性主张逐条标注「已核实/存疑/无来源」", "保留作者 voice，不把文章改成翻译腔"],
		deliv: ["结构诊断单（问题清单）", "润色稿 + 修订对照", "事实核查附录"],
		flow: [["通读", "结构与逻辑诊断"], ["重构", "大纲与段落级调整"], ["润色", "句子与用词"], ["核查", "事实标注"]],
		metrics: ["逻辑断点清零", "存疑主张全部有标注"] },
	{ slug: "guxing", name: "顾行", title: "股票研究专家", division: "finance", color: ["#2d6f5e", "#153f33"],
		desc: "行研框架 + 财报拆解 + 估值敏感性，只给逻辑和证据，不给荐股。",
		tags: ["行研", "财报", "估值"],
		mission: "用卖方分析师的方法论帮普通投资者读懂一门生意：商业模式 → 财报验证 → 估值区间 → 风险清单。",
		rules: ["永远先问「这门生意靠什么赚钱」", "所有结论给反方观点，标注关键假设", "不预测短期股价，只谈区间与赔率"],
		deliv: ["公司一页纸（生意拆解）", "财报关键科目变动表", "估值敏感性表 + 风险清单"],
		flow: [["生意", "商业模式与竞争位"], ["验证", "财报与经营数据交叉"], ["估值", "多方法区间"], ["风控", "反方清单"]],
		metrics: ["关键假设可追溯", "风险清单覆盖 ≥5 条"] },
	{ slug: "shenlue", name: "沈略", title: "战略咨询合伙人", division: "strategy", color: ["#33415c", "#141c2e"], feat: true,
		desc: "假设驱动、以证为据、溯源与证伪，产出能拍板的决策报告与汇报 PPT。",
		tags: ["战略分析", "决策备忘", "PPT交付"],
		mission: "在不确定里帮决策者拍板：把模糊问题拆成假设树，用证据逐枝证伪，最后给「可以签字」的选项与代价。",
		rules: ["先立假设树，再收证据，禁止先找素材再拼结论", "每个结论标注证据强度（硬数据/专家判断/推测）", "交付必须含「不做的代价」与止损条件"],
		deliv: ["议题树与假设清单", "证据墙（来源分级）", "决策备忘：选项 × 代价 × 触发条件", "汇报 PPT（金字塔结构）"],
		flow: [["定义问题", "把焦虑翻译成可回答的问题"], ["拆解", "议题树 + 优先验证枝"], ["取证", "内外部证据与访谈"], ["综合", "选项对比与建议"], ["交付", "备忘 + 汇报"]],
		metrics: ["决策会一次通过", "关键假设 100% 有来源"] },
	{ slug: "yuwen", name: "郁文", title: "论文写作导师", division: "academic", color: ["#5c7aa8", "#26364f"],
		desc: "基于严格检索的辅助论文全流程：选题、开题、文献综述、期刊匹配与回复审稿。",
		tags: ["论文全流程", "文献与论证", "答辩"],
		mission: "以导师身份带研究新手走完全流程：从「有个想法」到「能过答辩」，强调学术诚信与论证质量。",
		rules: ["文献必须真实可查，给出 DOI/链接，禁止编造", "先研究问题，再选方法，最后动笔", "查重与引用规范红线，绝不代写核心论证"],
		deliv: ["选题论证单 + 开题报告框架", "文献矩阵（主题 × 观点 × 缺口）", "审稿意见逐条回复信"],
		flow: [["选题", "把兴趣收敛成研究问题"], ["综述", "文献矩阵找缺口"], ["设计", "方法与数据"], ["成稿", "结构化写作"], ["投稿", "期刊匹配与回复"]],
		metrics: ["文献引用 100% 可溯源", "审稿意见回复通过率"] },
	{ slug: "chenglv", name: "程律", title: "资深合同法务专家", division: "legal", color: ["#6b6b6b", "#2e2e2e"],
		desc: "合同检索、风险条款与谈判要点：先把雷排掉，再谈生意。",
		tags: ["合同审查", "风险条款", "财税合规"],
		mission: "把合同里的隐性风险翻译成商业语言：哪个条款会让你亏钱、亏多少、怎么谈回来。",
		rules: ["逐条标注风险等级（高/中/低）与修改建议", "引用具体法条或判例，不给「建议咨询律师」式空话", "先明确交易结构与立场，再审条款"],
		deliv: ["风险条款清单（按等级）", "红线修订版 + 谈判要点", "合规检查表"],
		flow: [["定调", "交易结构与双方立场"], ["审查", "逐条排雷"], ["修订", "红线版"], ["谈判", "要点与让步预案"]],
		metrics: ["高风险条款清零", "谈判要点可执行"] },
	{ slug: "luoqi", name: "洛奇", title: "Godot 游戏脚本工程师", division: "game", color: ["#4a9d5f", "#1d4a2a"],
		desc: "节点搭建与 GDScript 手把手：原型优先，两周摸到可玩版本。",
		tags: ["Godot", "GDScript", "关卡原型"],
		mission: "用最短路径把玩法想法变成可玩原型：先灰盒验证核心循环，再谈美术与内容量。",
		rules: ["核心循环 48 小时内必须可玩", "灰盒阶段禁止打磨美术", "每个机制都要回答「为什么好玩」"],
		deliv: ["可运行 Godot 工程", "核心循环设计一页纸", "迭代 backlog（按乐趣排序）"],
		flow: [["定义", "核心循环一句话"], ["灰盒", "可玩原型"], ["测试", "找 3 个人玩"], ["迭代", "按数据调参"]],
		metrics: ["核心循环留存（自测 10 局）", "迭代节奏 ≥2 版/周"] },
	{ slug: "maisui", name: "麦穗", title: "创业伙伴", division: "venture", color: ["#d8912d", "#6e4a12"],
		desc: "创始人的陪跑伙伴：先活下去再谈增长，把孤独的决策变成有结构的对话。",
		tags: ["创业判断", "GTM落地", "客户心法"],
		mission: "做创始人的陪跑伙伴：把孤独的决策变成有结构的对话，先活下去，再谈增长。",
		rules: ["先看现金流 runway，再谈任何机会", "每个想法先找 10 个真实客户聊，再写计划书", "拒绝虚荣指标，只认留存与付费"],
		deliv: ["一页纸商业假设卡", "客户访谈脚本与纪要模板", "GTM 90 天计划"],
		flow: [["诊断", "runway 与阶段判定"], ["验证", "客户访谈"], ["聚焦", "砍到一件事"], ["推进", "90 天节奏表"]],
		metrics: ["访谈完成 ≥10 场/月", "北极星指标周环比"] },
	{ slug: "bailu", name: "白鹭", title: "求职教练", division: "academic", color: ["#7a5fa8", "#35265c"],
		desc: "把「投了没回音」变成可诊断的漏斗问题：定位 → 简历 → 渠道 → 面试 → 谈薪。",
		tags: ["求职诊断", "简历自述", "模拟面试"],
		mission: "把「投了没回音」变成可诊断的漏斗问题：定位 → 简历 → 渠道 → 面试 → 谈薪，逐段修复。",
		rules: ["先定位目标岗位画像，再改简历，顺序不能反", "每条经历用 STAR 重写并量化", "模拟面试必须给逐题反馈"],
		deliv: ["岗位画像与差距分析", "简历/自述改写稿", "高频面试题库 + 模拟面评"],
		flow: [["定位", "岗位画像与差距"], ["包装", "STAR 化经历"], ["演练", "模拟面试"], ["谈判", "offer 比较与谈薪"]],
		metrics: ["简历回复率提升", "面试转化漏斗逐段改善"] },
];

export function expertBySlug(slug: string): ExpertPersona | undefined {
	return EXPERT_ROSTER.find((expert) => expert.slug === slug);
}

/** 预设专家团（与原型一致；「专家团」tab + 精选场景的成团来源）。 */
export const EXPERT_TEAMS = [
	{ id: "t1", name: "公众号增长会诊团", desc: "内容 × 增长 × 长文，一篇爆款的三种视角。", members: ["hexiao", "tangguo", "jiangkuo"] },
	{ id: "t2", name: "新品上线突击队", desc: "从定位到上线的完整链路：设计 + 研发 + 增长 + 战略。", members: ["surui", "linan", "tangguo", "shenlue"] },
	{ id: "t3", name: "代码评审委员会", desc: "全栈 × 前端 × SRE，三层视角过一遍 PR。", members: ["linan", "chenxi", "laok"] },
	{ id: "t4", name: "融资准备顾问团", desc: "战略 × 行研 × 法务 × 创业伙伴，材料与谈判双线。", members: ["shenlue", "guxing", "chenglv", "maisui"] },
	{ id: "t5", name: "全景独董会", desc: "把一件难事摆上桌面：战略、财务、法务、创业四位「独董」各自表态。", members: ["shenlue", "guxing", "chenglv", "maisui"] },
] as const;

/** 精选场景：场景 = 预设顾问团 + 首问模板，点开即以该团开一场群聊。 */
export const EXPERT_SCENARIOS = [
	{ name: "求职冲刺季", emoji: "🎓", color: ["#268574", "#1d5c50"] as [string, string], team: "t1", members: ["yuwen", "bailu"], question: "两周后面试，帮我做一份冲刺计划" },
	{ name: "内容创作", emoji: "✍️", color: ["#d85f8f", "#7a2e50"] as [string, string], team: "t1", members: ["hexiao", "tangguo", "jiangkuo"], question: "公众号阅读量停滞 3 个月，预算 5000/月，怎么破局？" },
	{ name: "投资分析", emoji: "📈", color: ["#2d6f5e", "#153f33"] as [string, string], team: "t4", members: ["guxing", "shenlue"], question: "帮我把持有的仓位做一次体检" },
	{ name: "合同与法务", emoji: "⚖️", color: ["#6b6b6b", "#2e2e2e"] as [string, string], team: "t4", members: ["chenglv"], question: "这份合同里有哪些要谈的条款？" },
	{ name: "新品上线", emoji: "🚀", color: ["#3b7dd8", "#1d3f6e"] as [string, string], team: "t2", members: ["surui", "linan"], question: "新品两周后上线，帮我排上线前的关键路径" },
	{ name: "游戏原型周末", emoji: "🎮", color: ["#4a9d5f", "#1d4a2a"] as [string, string], team: "t3", members: ["luoqi", "linan"], question: "周末两天，帮我把一个玩法想法做成可玩原型" },
] as const;

// ---------------------------------------------------------------------------
// 目录与文件（桥 fs.*；write 会递归建父目录，见 coding-agent sidebar-fs）
// ---------------------------------------------------------------------------

export function expertDir(slug: string): string {
	return `${EXPERT_DIR}/${slug}`;
}

export function expertGroupDir(groupId: string): string {
	return `${EXPERT_DIR}/groups/${groupId}`;
}

async function readText(client: BridgeClient, cwd: string, path: string): Promise<string | null> {
	try {
		const response = await client.request<FsReadResult>({ type: "fs.read", cwd, path });
		if (!response.ok || response.result?.kind !== "text") return null;
		return response.result.content;
	} catch {
		return null;
	}
}

async function writeText(client: BridgeClient, cwd: string, path: string, content: string): Promise<void> {
	const response = await client.request<{ path: string; size: number }>({ type: "fs.write", cwd, path, content });
	if (!response.ok) throw new Error(response.error ?? "fs.write failed");
}

/** 人格档案 markdown（六段式；与面板抽屉展示一致，用户可直接改文件改人格）。 */
export function personaMarkdown(p: ExpertPersona): string {
	return [
		`---`,
		`name: ${p.name}`,
		`title: ${p.title}`,
		`division: ${p.division}`,
		`tags: ${p.tags.join("、")}`,
		`---`,
		``,
		`# ${p.name} · ${p.title}`,
		``,
		`## 身份与记忆`,
		``,
		p.desc,
		`每次会话携带身份与历史摘要进入；与用户合作的长期记忆存于同目录 memory.md。`,
		``,
		`## 核心使命`,
		``,
		p.mission,
		``,
		`## 领域规则`,
		``,
		...p.rules.map((rule) => `- ${rule}`),
		``,
		`## 交付物`,
		``,
		...p.deliv.map((item) => `- ${item}`),
		``,
		`## 工作流程`,
		``,
		...p.flow.map(([name, detail], index) => `${index + 1}. **${name}** — ${detail}`),
		``,
		`## 成功指标`,
		``,
		...p.metrics.map((metric) => `- ${metric}`),
		``,
	].join("\n");
}

const MEMORY_TEMPLATE = `# 长期记忆（与用户合作累积）

> 用条目记录偏好、进行中的事与结论；每行一条，新的写下面。会话开场会把本文件尾部带进上下文。
`;

/**
 * 确保某专家的目录就绪：persona.md 缺失时落盘（目录专家用原始档案，内置用再生成；
 * 用户改过则不动），memory.md 缺失时建骨架。返回 (persona.md 是否新落盘, memory.md 内容)。
 */
export async function ensureExpertDir(client: BridgeClient, p: ExpertPersona): Promise<{ seeded: boolean; memory: string }> {
	const dir = expertDir(p.slug);
	const existing = await readText(client, dir, "persona.md");
	if (existing === null) await writeText(client, dir, "persona.md", p.raw ?? personaMarkdown(p));
	let memory = await readText(client, dir, "memory.md");
	if (memory === null) {
		memory = MEMORY_TEMPLATE;
		await writeText(client, dir, "memory.md", memory);
	}
	return { seeded: existing === null, memory };
}

/** 读取某专家的长期记忆（目录还没建时返回空串）。 */
export async function readExpertMemory(client: BridgeClient, slug: string): Promise<string> {
	return (await readText(client, expertDir(slug), "memory.md")) ?? "";
}

/** 把今天的会话行（用户或专家）追加进 `YYYY-MM-DD.md`；没有当天文件就先建骨架。 */
export async function logExpertChatLine(client: BridgeClient, cwd: string, who: string, text: string): Promise<void> {
	const date = todayKey();
	const base = (await readText(client, cwd, `${date}.md`)) ?? newDayTemplate(date, "zh");
	await writeText(client, cwd, `${date}.md`, appendChatLine(base, timeHHMM(), who, text));
}

function timeHHMM(): string {
	const at = new Date();
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 专家群（owl-expert/groups/<id>）
// ---------------------------------------------------------------------------

export interface ExpertGroup {
	id: string;
	name: string;
	memberSlugs: string[];
	/** 记忆模式：shared = 群共享一份（groups/<id>/memory.md）；own = 各专家沿用自己目录的记忆。 */
	memory: "shared" | "own";
}

export async function listExpertGroups(client: BridgeClient): Promise<ExpertGroup[]> {
	try {
		const response = await client.request<FsListing>({ type: "fs.tree", cwd: EXPERT_DIR, path: "groups" });
		const dirs = (response.ok ? response.result?.entries ?? [] : []).filter((entry) => entry.isDir && !entry.hidden).map((entry) => entry.name);
		const groups = await Promise.all(dirs.map(async (id) => {
			const raw = await readText(client, expertGroupDir(id), "members.json");
			if (!raw) return null;
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				if (typeof parsed.name !== "string" || !Array.isArray(parsed.memberSlugs)) return null;
				return {
					id,
					name: parsed.name,
					memberSlugs: parsed.memberSlugs.filter((v): v is string => typeof v === "string"),
					memory: parsed.memory === "own" ? "own" : "shared",
				} satisfies ExpertGroup;
			} catch {
				return null;
			}
		}));
		return groups.filter((group): group is ExpertGroup => group !== null);
	} catch {
		return [];
	}
}

export async function createExpertGroup(client: BridgeClient, name: string, memberSlugs: string[], memory: "shared" | "own" = "shared"): Promise<ExpertGroup> {
	const id = `g-${Date.now().toString(36)}`;
	const group: ExpertGroup = { id, name, memberSlugs, memory };
	await writeText(client, expertGroupDir(id), "members.json", JSON.stringify({ name, memberSlugs, memory, createdAt: new Date().toISOString() }, null, 2));
	if (memory === "shared") await writeText(client, expertGroupDir(id), "memory.md", `# 群共享记忆（${name}）\n\n> 全员可读写；每行一条，新的写下面。\n`);
	return group;
}

/** 群设置：改名 / 增删成员 / 切记忆模式（members.json 重写）。 */
export async function updateExpertGroup(client: BridgeClient, group: ExpertGroup, patch: Partial<Pick<ExpertGroup, "name" | "memberSlugs" | "memory">>): Promise<ExpertGroup> {
	const next: ExpertGroup = { ...group, ...patch };
	await writeText(client, expertGroupDir(next.id), "members.json", JSON.stringify({ name: next.name, memberSlugs: next.memberSlugs, memory: next.memory, createdAt: new Date().toISOString() }, null, 2));
	if (next.memory === "shared") {
		const existing = await readText(client, expertGroupDir(next.id), "memory.md");
		if (existing === null) await writeText(client, expertGroupDir(next.id), "memory.md", `# 群共享记忆（${next.name}）\n\n> 全员可读写；每行一条，新的写下面。\n`);
	}
	return next;
}

/** 群共享记忆内容（own 模式返回空串）。 */
export async function readGroupMemory(client: BridgeClient, group: ExpertGroup): Promise<string> {
	if (group.memory === "own") return "";
	return (await readText(client, expertGroupDir(group.id), "memory.md")) ?? "";
}

/**
 * 确保群目录在盘上存在：会话的 cwd 指向它，目录不存在时 agent 会拒绝工作。
 * 临时团（场景/团队一键会诊，无 members.json，不进「我的群」清单）也走这里。
 */
export async function ensureGroupDir(client: BridgeClient, groupId: string, memory: "shared" | "own"): Promise<void> {
	const dir = expertGroupDir(groupId);
	if (memory === "shared") {
		const memoryRaw = await readText(client, dir, "memory.md");
		if (memoryRaw === null) await writeText(client, dir, "memory.md", "# 群共享记忆\n\n> 全员可读写；每行一条，新的写下面。\n");
		return;
	}
	const keep = await readText(client, dir, ".keep");
	if (keep === null) await writeText(client, dir, ".keep", "");
}

// ---------------------------------------------------------------------------
// Primer：新线程首轮提示词的角色铺垫（之后靠会话记忆，不重复）
// ---------------------------------------------------------------------------

/** 1:1 专家会话：人格档案 + 记忆尾部 + 数据目录说明。 */
export async function expertPrimer(client: BridgeClient, p: ExpertPersona): Promise<string> {
	const memory = await readExpertMemory(client, p.slug);
	const memoryTail = memory.trim().split(/\r?\n/).slice(-24).join("\n");
	return [
		`你是「${p.name}」，owl「专家顾问」面板里的专家——${p.title}（${divisionLabel(p.division)}）。`,
		`人格档案如下，全程保持这个人格、口吻与工作方式作答：`,
		`- 简介：${p.desc}`,
		`- 核心使命：${p.mission}`,
		`- 领域规则：`,
		...p.rules.map((rule) => `  · ${rule}`),
		`- 常规交付物：${p.deliv.join("；")}`,
		`- 工作流程：${p.flow.map(([name, detail]) => `${name}（${detail}）`).join(" → ")}`,
		`- 成功指标：${p.metrics.join("；")}`,
		`你的数据目录是 owl-expert/${p.slug}/：persona.md 是人格档案（用户可改，改了以文件为准），memory.md 是与用户的长期记忆（重要偏好与结论记一行进去），YYYY-MM-DD.md 是会话记录。`,
		memoryTail ? `记忆（最近几条）：\n${memoryTail}` : `记忆还是空的——第一次与用户合作。`,
		`回答简洁、直接进入专家角色，不说「作为 AI」。人格档案是英文时照常工作，但回答语言跟随用户提问的语言。`,
		`---`,
		``,
	].join("\n");
}

/** 专家群聊：一个会话扮演主持人 + 多位成员专家，按顺序接龙作答。 */
export function expertGroupPrimer(group: ExpertGroup, members: ExpertPersona[]): string {
	const roster = members.map((member, index) => `${index + 1}. 【${member.name}】${member.title}——${member.desc}`).join("\n");
	return [
		`你主持一个 owl「专家顾问」群聊「${group.name}」，成员是以下专家，各自有独立人格与立场：`,
		roster,
		`群聊规则：`,
		`- 用户提问后，由你依次以各成员专家的身份作答：每段以「【名字】」开头，只答与本题相关的成员，按 roster 顺序接龙；`,
		`- 用户 @了某位专家时，被点名的先答，其余可简短补充或不答；`,
		`- 多数成员已作答后，输出一段「【主持人·综合】」：拎出共识、分歧与建议动作（可分工到人）；`,
		`- 每位专家严格遵守各自人格（领域规则与工作流程），不要互相客套；`,
		group.memory === "shared"
			? `- 群共享记忆在本目录 memory.md，重要的共识与结论记一行进去。`
			: `- 本群不设共享记忆：各专家的长期记忆在各自目录（owl-expert/<slug>/memory.md），涉及结论时各自记到自己的记忆里。`,
		`回答语言跟随用户。`,
		`---`,
		``,
	].join("\n");
}

// ---------------------------------------------------------------------------
// 自定义专家（owl-expert/custom/<slug>/persona.md）
// ---------------------------------------------------------------------------

function customDir(slug: string): string {
	return `${EXPERT_DIR}/custom/${slug}`;
}

const CUSTOM_COLORS: [string, string][] = [
	["#268574", "#1d5c50"], ["#3b7dd8", "#1d3f6e"], ["#d8626a", "#7a2e3b"], ["#8a5fd0", "#42307a"], ["#c98a2d", "#6e4a12"],
];

/** 解析 persona.md（与 personaMarkdown 同一结构；宽容：缺段落给占位）。 */
export function parsePersonaMarkdown(raw: string, slug: string, opts?: { custom?: boolean }): ExpertPersona | null {
	const front: Record<string, string> = {};
	let body = raw;
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (fm) {
		for (const line of fm[1]!.split(/\r?\n/)) {
			const pair = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line.trim());
			if (pair) front[pair[1]!.toLowerCase()] = pair[2]!.trim();
		}
		body = raw.slice(fm[0].length);
	}
	const name = front.name;
	if (!name) return null;
	const section = (title: string): string[] => {
		const match = new RegExp(`##\\s*${title}[\\s\\S]*?\\n\\n([\\s\\S]*?)(?=\\n##\\s|$)`).exec(body);
		return (match?.[1] ?? "").split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
	};
	const flowLines = section("工作流程");
	const descLines = section("身份与记忆");
	return {
		slug, name,
		nameZh: front.namezh || undefined,
		title: front.title || (opts?.custom ? "自定义专家" : "Expert"),
		titleZh: front.titlezh || undefined,
		division: DIVISION_LABELS[front.division] ? front.division : "eng",
		color: front.color1 && front.color2 ? [front.color1, front.color2] : CUSTOM_COLORS[Math.abs([...slug].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)) % CUSTOM_COLORS.length]!,
		desc: front.desc || descLines[0] || "",
		descZh: front.desczh || undefined,
		tags: (front.tags || "").split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean),
		tagsZh: (front.tagszh || "").split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean),
		mission: section("核心使命").join(" "),
		rules: section("领域规则"),
		deliv: section("交付物"),
		flow: flowLines.map((line): [string, string] => {
			const named = /^\d+[.、]\s*\*\*(.+?)\*\*[—–-]*(.*)$/.exec(line);
			return named ? [named[1]!, named[2]!.trim()] : [line, ""];
		}),
		metrics: section("成功指标"),
		custom: opts?.custom ?? false,
	};
}

/**
 * 列出 owl-expert/catalog/ 下的目录专家（agency-agents 全量转换，带原始档案保真）。
 * 270+ 个 md 逐个读一次；本地桥延迟下整体 1-2s，激活时加载一次。
 */
export async function listCatalogExperts(client: BridgeClient): Promise<ExpertPersona[]> {
	try {
		const response = await client.request<FsListing>({ type: "fs.tree", cwd: EXPERT_DIR, path: "catalog" });
		const files = (response.ok ? response.result?.entries ?? [] : [])
			.filter((entry) => !entry.isDir && !entry.hidden && entry.name.endsWith(".md"))
			.map((entry) => entry.name);
		const experts = await Promise.all(files.map(async (file) => {
			const raw = await readText(client, EXPERT_DIR, `catalog/${file}`);
			if (!raw) return null;
			const parsed = parsePersonaMarkdown(raw, file.replace(/\.md$/, ""));
			return parsed ? { ...parsed, raw } : null;
		}));
		return (experts as (ExpertPersona | null)[]).filter((expert): expert is ExpertPersona => expert !== null);
	} catch {
		return [];
	}
}

/** 列出 owl-expert/custom/ 下的自定义专家（读不通的跳过）。 */
export async function listCustomExperts(client: BridgeClient): Promise<ExpertPersona[]> {
	try {
		const response = await client.request<FsListing>({ type: "fs.tree", cwd: EXPERT_DIR, path: "custom" });
		const dirs = (response.ok ? response.result?.entries ?? [] : []).filter((entry) => entry.isDir && !entry.hidden).map((entry) => entry.name);
		const experts = await Promise.all(dirs.map(async (slug) => {
			const raw = await readText(client, customDir(slug), "persona.md");
			return raw ? parsePersonaMarkdown(raw, slug, { custom: true }) : null;
		}));
		return experts.filter((expert): expert is ExpertPersona => expert !== null);
	} catch {
		return [];
	}
}

export async function createCustomExpert(client: BridgeClient, draft: Pick<ExpertPersona, "name" | "title" | "division" | "tags" | "desc" | "mission" | "rules">): Promise<ExpertPersona> {
	const slug = `c-${Date.now().toString(36)}`;
	const persona: ExpertPersona = {
		...draft, slug, custom: true,
		color: CUSTOM_COLORS[Math.abs(slug.length * 7) % CUSTOM_COLORS.length]!,
		deliv: ["按领域规则产出的交付物"],
		flow: [["澄清", "确认目标与现状"], ["执行", "按领域规则推进"], ["交付", "给出结论与下一步"]],
		metrics: ["问题被解决"],
	};
	await writeText(client, customDir(slug), "persona.md", personaMarkdown(persona));
	await writeText(client, customDir(slug), "memory.md", MEMORY_TEMPLATE);
	return persona;
}

// ---------------------------------------------------------------------------
// 启用范围 / Agentfile（localStorage + owl-expert/Agentfile）
// ---------------------------------------------------------------------------

export type ExpertScope = "global" | "space" | "session";
const SCOPE_KEY = "owl.expert.scope";

export function getExpertScope(slug: string): ExpertScope {
	const all = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "{}") as Record<string, string>;
	return all[slug] === "global" || all[slug] === "session" ? all[slug] : "space";
}

export function setExpertScope(slug: string, scope: ExpertScope): void {
	const all = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "{}") as Record<string, string>;
	all[slug] = scope;
	localStorage.setItem(SCOPE_KEY, JSON.stringify(all));
}

/** Agentfile：启用清单 + 范围的纯文本导出（导入即恢复范围选择）。 */
export async function exportAgentfile(client: BridgeClient, slugs: string[]): Promise<string> {
	const lines = ["# owl Agentfile — 专家启用清单", ...slugs.map((slug) => `expert ${slug} scope=${getExpertScope(slug)}`)];
	await writeText(client, EXPERT_DIR, "Agentfile", `${lines.join("\n")}\n`);
	return `${lines.length - 1} 条`;
}

export async function importAgentfile(client: BridgeClient): Promise<number> {
	const raw = await readText(client, EXPERT_DIR, "Agentfile");
	if (!raw) return 0;
	let applied = 0;
	for (const line of raw.split(/\r?\n/)) {
		const match = /^expert\s+(\S+)\s+scope=(global|space|session)/.exec(line.trim());
		if (!match) continue;
		setExpertScope(match[1]!, match[2] as ExpertScope);
		applied++;
	}
	return applied;
}

/** 管理台状态：内置档案与盘上 persona.md 比对（有修改），自定义专家单列。 */
export type ExpertFileStatus = "ok" | "mod" | "custom";

export async function expertFileStatus(client: BridgeClient, p: ExpertPersona): Promise<ExpertFileStatus> {
	if (p.custom) return "custom";
	const raw = await readText(client, expertDir(p.slug), "persona.md");
	if (raw === null) return "ok";
	return raw.trim() === personaMarkdown(p).trim() ? "ok" : "mod";
}
