import type { LifeLevel } from "../../bridge/protocol.ts";
import { getUiLanguage, useT } from "../../i18n/index.ts";

const zhNames: Record<string, string> = {
	bridge: "本地桥",
	mcp: "MCP",
	package: "包能否加载",
	"subagent-entry": "子智能体入口",
	model: "当前模型",
	"last-run": "最近一次运行",
	skills: "技能",
	plugins: "插件",
	prompts: "提示词",
	memory: "跨会话记忆",
	"ask-user": "向用户提问",
	"safety-net": "安全网",
	"diff-approval": "改动审批",
	context: "上下文",
	terminal: "终端",
	browser: "浏览器",
	files: "文件",
	editor: "编辑器",
	changes: "变更",
	document: "文档",
	drama: "短剧",
	sidechat: "侧边对话",
	image: "图片",
	tasks: "任务",
	impression: "印象",
	manager: "号池",
	presets: "Agent 预设",
	trajectory: "任务轨迹",
	"computer-use": "电脑操作",
	"web-access": "网页访问",
	genui: "生成界面",
	office: "Office",
	"image-gen": "图像生成",
	codemode: "代码沙箱",
	billion: "长上下文",
	background: "后台任务",
	lens: "代码透镜",
	news: "资讯",
	map: "地图",
	mail: "邮件",
	media: "音乐",
	evaluation: "模型测评",
	research: "研究工作台",
	guide: "人生指南",
	career: "Token 生涯",
	myself: "我的助理",
	projects: "项目",
	automation: "自动化任务",
	expert: "专家顾问",
	bagu: "八股对练",
	market: "插件市场",
	shell: "命令壳",
	models: "模型库",
	sessions: "会话",
	usage: "使用统计",
	island: "灵动岛",
	notifications: "通知",
	archive: "归档清理",
	wallpaper: "动态壁纸",
};

const enNames: Record<string, string> = {
	bridge: "Local bridge",
	mcp: "MCP",
	package: "Package resolve",
	"subagent-entry": "Subagent entry",
	model: "Current model",
	"last-run": "Latest run",
	skills: "Skills",
	plugins: "Plugins",
	prompts: "Prompts",
	memory: "Memory",
	"ask-user": "Ask user",
	"safety-net": "Safety net",
	"diff-approval": "Diff approval",
	context: "Context",
	terminal: "Terminal",
	browser: "Browser",
	files: "Files",
	editor: "Editor",
	changes: "Changes",
	document: "Document",
	drama: "Drama",
	sidechat: "Side chat",
	image: "Image",
	tasks: "Tasks",
	impression: "Impression",
	manager: "Account pool",
	presets: "Agent presets",
	trajectory: "Trajectory",
	"computer-use": "Computer use",
	"web-access": "Web access",
	genui: "GenUI",
	office: "Office",
	"image-gen": "Image generation",
	codemode: "Code sandbox",
	billion: "Long context",
	background: "Background tasks",
	lens: "Code lens",
	news: "News",
	map: "Map",
	mail: "Mail",
	media: "Music",
	evaluation: "Evaluation",
	research: "Research",
	guide: "Life guide",
	career: "Token career",
	myself: "My assistant",
	projects: "Projects",
	automation: "Automation",
	expert: "Experts",
	bagu: "Interview drill",
	market: "Plugin market",
	shell: "Shell",
	models: "Model catalog",
	sessions: "Sessions",
	usage: "Usage stats",
	island: "Island",
	notifications: "Notifications",
	archive: "Archive cleanup",
	wallpaper: "Wallpaper",
};

const zhGroups: Record<string, string> = {
	link: "连接",
	agent: "智能体",
	bench: "工作台",
	power: "能力",
	desk: "桌面",
	body: "机体",
};
const enGroups: Record<string, string> = {
	link: "Link",
	agent: "Agent",
	bench: "Workbench",
	power: "Capabilities",
	desk: "Desk",
	body: "Shell",
};

const zhLevel: Record<LifeLevel, string> = { ok: "正常", bad: "故障", warn: "注意", idle: "未测", off: "停用" };
const enLevel: Record<LifeLevel, string> = {
	ok: "OK",
	bad: "Broken",
	warn: "Attention",
	idle: "Unchecked",
	off: "Off",
};

const zhNote: Record<string, string> = {
	"bridge.down": "本地桥没有连上。",
	"package.missing": "运行时解不开这个包。",
	"package.ok": "子智能体运行时能够解析这个包。",
	"last-run.explained": "这次失败已经算在包上，不另计。",
	"last-run.none": "当前项目还没有子智能体运行。",
	"last-run.no-project": "没有打开项目，这条不亮。",
	"last-run.failed": "最近一次运行失败，而且不是包解析错误。",
	"last-run.wrote": "当前项目最近一次写出了结果。",
	"model.unselected": "输入框里没有选中模型。",
	"model.no-key": "这个供应商没有配好 key。不显示 key。",
	"model.unknown": "模型库里没有这个供应商。",
	"model.unknown-model": "这个供应商下没有选中的模型。",
	"model.ok": "供应商和模型都在。不显示 key。",
	"mail.no-account": "还没有配好发信账号。不显示地址。",
	"myself.absent": "默认助理目录不在。不显示路径。",
	"myself.ok": "助理记录目录在。",
	"expert.absent": "默认专家目录不在。不显示路径。",
	"expert.ok": "专家档案目录在。",
	"bagu.absent": "默认对练目录不在。不显示路径。",
	"bagu.ok": "对练记录目录在。",
	"automation.empty": "调度在，还没有定时任务。",
	"automation.ok": "定时任务清单在。不显示提示词。",
	"presets.ok": "还有自己写的预设。不显示提示词。",
	"manager.built-in": "号池面板在这一版里。这一轮没有去连它。",
	"market.built-in": "市场页在。这一轮没有去拉注册表。",
	"wallpaper.off": "壁纸层在，当前没开。",
	"wallpaper.on": "壁纸层开着。",
	"mcp.empty": "设置里没有登记外部工具服务。",
	"mcp.named": "设置里登记了外部工具服务。这一轮没有去连它。",
	absent: "清单里没有这一项。",
	missing: "登记了，但目录或文件不在。",
	disabled: "按配置停用。不算告警。",
	empty: "还没有内容。",
	"built-in": "这一版桌面里带有这一页。",
	"read-failed": "这一轮没有查成。下一轮再试。",
};

const enNote: Record<string, string> = {
	"bridge.down": "The local bridge is down.",
	"package.missing": "The runtime cannot resolve this package.",
	"package.ok": "The subagent runtime can resolve this package.",
	"last-run.explained": "This failure is already counted on the package check.",
	"last-run.none": "This project has no subagent run yet.",
	"last-run.no-project": "No project is open, so this stays quiet.",
	"last-run.failed": "The latest run failed for a reason other than package resolve.",
	"last-run.wrote": "The latest subagent run in this project produced output.",
	"model.unselected": "No model is selected in the composer.",
	"model.no-key": "This provider has no key configured. The key is not shown.",
	"model.unknown": "This provider is not in the model catalog.",
	"model.unknown-model": "The selected model is not under this provider.",
	"model.ok": "The provider and model are configured. The key is not shown.",
	"mail.no-account": "No sending account is configured. Addresses are not shown.",
	"myself.absent": "The default assistant folder is missing. The path is not shown.",
	"myself.ok": "The assistant notes folder is present.",
	"expert.absent": "The default experts folder is missing. The path is not shown.",
	"expert.ok": "The expert profiles folder is present.",
	"bagu.absent": "The default drill folder is missing. The path is not shown.",
	"bagu.ok": "The drill notes folder is present.",
	"automation.empty": "The scheduler is present and there are no tasks yet.",
	"automation.ok": "The task list is present. Prompts are not shown.",
	"presets.ok": "Custom presets are stored. Prompts are not shown.",
	"manager.built-in": "This build includes the account pool. This round did not connect to it.",
	"market.built-in": "The market page is present. This round did not fetch the registries.",
	"wallpaper.off": "The wallpaper layer is present and currently off.",
	"wallpaper.on": "The wallpaper layer is on.",
	"mcp.empty": "No external tool server is registered.",
	"mcp.named": "An external tool server is registered. This round did not connect to it.",
	absent: "It is not in the list.",
	missing: "It is registered, but the directory or file is missing.",
	disabled: "Turned off in configuration. Not an alarm.",
	empty: "Nothing is stored yet.",
	"built-in": "This desktop build includes this surface.",
	"read-failed": "This round could not check it. The next round will try again.",
};

const zhShell = {
	title: "诊断",
	desc: "对本机 Owl 做一轮只读体检：设置、插件、模型和会话目录。不发模型请求，不显示 key 和完整路径。后台每 5 分钟查一次，有异常时标题栏才会亮。",
	recheck: "重新检查",
	checking: "检查中…",
	copy: "复制报告",
	copied: "已复制",
	checkedAt: "上次检查 {time}",
	never: "还没查过",
	issues: "{n} 项需要处理",
	allClear: "{n} 项都正常。停用和未配置的不算异常。",
	down: "本地桥没有连上，下面是上一轮的结果。",
	failed: "这一轮没查完，下面是上一轮的结果。",
	rest: "其余 {n} 项",
	notSetUp: "未配置",
	fixModels: "去模型设置",
	fixPlugins: "去插件设置",
	fixSkills: "去技能设置",
	reportTitle: "Owl 诊断报告",
	reportRest: "其余正常",
};
const enShell: { [K in keyof typeof zhShell]: string } = {
	title: "Diagnostics",
	desc: "A read-only checkup of this Owl install: settings, plugins, models and session folders. No model requests; keys and full paths are never shown. It runs in the background every 5 minutes and lights up the title bar only when something is wrong.",
	recheck: "Check again",
	checking: "Checking…",
	copy: "Copy report",
	copied: "Copied",
	checkedAt: "Last checked {time}",
	never: "Not checked yet",
	issues: "{n} need attention",
	allClear: "All {n} checks pass. Off and not-set-up items are not problems.",
	down: "The local bridge is down. Showing the previous round.",
	failed: "This round did not finish. Showing the previous round.",
	rest: "Other {n} checks",
	notSetUp: "Not set up",
	fixModels: "Open model settings",
	fixPlugins: "Open plugin settings",
	fixSkills: "Open skill settings",
	reportTitle: "Owl diagnostics report",
	reportRest: "Passing",
};

function pick(zh: string, en: string): string {
	return getUiLanguage() === "en" ? en : zh;
}

export function lifeName(id: string): string {
	return pick(zhNames[id] ?? id, enNames[id] ?? id);
}

export function lifeGroup(id: string): string {
	return pick(zhGroups[id] ?? id, enGroups[id] ?? id);
}

export function lifeLevel(level: LifeLevel, note: string): string {
	if (note === "unwired") return pick("未接通", "Not wired");
	if (level === "off" && note !== "disabled") return lifeShell("notSetUp");
	return pick(zhLevel[level], enLevel[level]);
}

export function lifeFact(id: string, note: string, level: LifeLevel): string {
	const specific = pick(zhNote[`${id}.${note}`] ?? "", enNote[`${id}.${note}`] ?? "");
	if (specific) return specific;
	const shared = pick(zhNote[note] ?? "", enNote[note] ?? "");
	if (shared) return shared;
	if (level === "idle") return pick(zhNote["read-failed"]!, enNote["read-failed"]!);
	if (level === "off") return pick(zhNote.disabled!, enNote.disabled!);
	if (level === "ok") return pick("在。", "Present.");
	if (level === "bad") return pick(zhNote.missing!, enNote.missing!);
	return pick(zhNote.absent!, enNote.absent!);
}

export function lifeShell<K extends keyof typeof zhShell>(key: K, vars?: Record<string, string | number>): string {
	const text = pick(zhShell[key], enShell[key]);
	return text.replace(/\{(\w+)\}/g, (raw, name: string) => (vars && name in vars ? String(vars[name]) : raw));
}

export function useLifeCopy(): void {
	useT();
}
