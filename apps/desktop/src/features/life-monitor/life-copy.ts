import { getUiLanguage, useT } from "../../i18n/index.ts";
import type { LifeLevel } from "../../bridge/protocol.ts";

const zhNames: Record<string, string> = {
	bridge: "本地桥", mcp: "MCP", package: "包能否加载", "subagent-entry": "子智能体入口", model: "当前模型", "last-run": "最近一次运行",
	skills: "技能", plugins: "插件", prompts: "提示词", memory: "跨会话记忆", "ask-user": "向用户提问", "safety-net": "安全网", "diff-approval": "改动审批", context: "上下文",
	terminal: "终端", browser: "浏览器", files: "文件", editor: "编辑器", changes: "变更", document: "文档", drama: "短剧", sidechat: "侧边对话", image: "图片", tasks: "任务", impression: "印象",
	"computer-use": "电脑操作", "web-access": "网页访问", genui: "生成界面", office: "Office", "image-gen": "图像生成", codemode: "代码沙箱", billion: "长上下文", background: "后台任务", lens: "代码透镜",
	news: "资讯", map: "地图", mail: "邮件", media: "音乐", evaluation: "模型测评", research: "研究工作台", guide: "人生指南", career: "Token 生涯", myself: "我自己",
	shell: "命令壳", models: "模型库", sessions: "会话", usage: "使用统计", island: "灵动岛", notifications: "通知", archive: "归档清理", wallpaper: "动态壁纸",
};

const enNames: Record<string, string> = {
	bridge: "Local bridge", mcp: "MCP", package: "Package resolve", "subagent-entry": "Subagent entry", model: "Current model", "last-run": "Latest run",
	skills: "Skills", plugins: "Plugins", prompts: "Prompts", memory: "Memory", "ask-user": "Ask user", "safety-net": "Safety net", "diff-approval": "Diff approval", context: "Context",
	terminal: "Terminal", browser: "Browser", files: "Files", editor: "Editor", changes: "Changes", document: "Document", drama: "Drama", sidechat: "Side chat", image: "Image", tasks: "Tasks", impression: "Impression",
	"computer-use": "Computer use", "web-access": "Web access", genui: "GenUI", office: "Office", "image-gen": "Image generation", codemode: "Code sandbox", billion: "Long context", background: "Background tasks", lens: "Code lens",
	news: "News", map: "Map", mail: "Mail", media: "Music", evaluation: "Evaluation", research: "Research", guide: "Life guide", career: "Token career", myself: "Myself",
	shell: "Shell", models: "Model catalog", sessions: "Sessions", usage: "Usage stats", island: "Island", notifications: "Notifications", archive: "Archive cleanup", wallpaper: "Wallpaper",
};

const zhGroups: Record<string, string> = { link: "连接", agent: "智能体", bench: "工作台", power: "能力", desk: "桌面", body: "机体" };
const enGroups: Record<string, string> = { link: "Link", agent: "Agent", bench: "Workbench", power: "Capabilities", desk: "Desk", body: "Shell" };

const zhLevel: Record<LifeLevel, string> = { ok: "平稳", bad: "危急", warn: "注意", idle: "未测", off: "停用" };
const enLevel: Record<LifeLevel, string> = { ok: "Steady", bad: "Critical", warn: "Attention", idle: "Unchecked", off: "Off" };

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
	"model.no-url": "这个供应商没有地址。",
	"model.unknown": "模型库里没有这个供应商。",
	"model.unknown-model": "这个供应商下没有选中的模型。",
	"model.ok": "供应商和地址都在。不显示 key。",
	"mail.no-account": "还没有配好发信账号。不显示地址。",
	"myself.unwired": "导航类型里有这个名字，没有页面。不算告警。",
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
	"model.no-url": "This provider has no base URL.",
	"model.unknown": "This provider is not in the model catalog.",
	"model.unknown-model": "The selected model is not under this provider.",
	"model.ok": "The provider and address are configured. The key is not shown.",
	"mail.no-account": "No sending account is configured. Addresses are not shown.",
	"myself.unwired": "The navigation type exists and there is no page. Not an alarm.",
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
	title: "OWL 生命监护",
	cadence: "整台 {n} 处 · 每 15 秒一轮 · 只读",
	alarms: "{n} 个告警",
	noAlarms: "没有告警",
	critical: "危急",
	attention: "注意",
	steady: "平稳",
	unchecked: "未测",
	open: "打开生命监护",
	back: "回到会话",
	bannerDown: "本地桥没有连上。下面仍留着上一轮。",
	bannerFailed: "这一轮没查完。下面仍留着上一轮。",
	bannerSteady: "{n} 处都在墙上。停用和未接通不算告警。",
	changed: "变化",
	round: "这一轮",
};
const enShell: { [K in keyof typeof zhShell]: string } = {
	title: "OWL life monitor",
	cadence: "{n} channels · every 15 seconds · read only",
	alarms: "{n} alarms",
	noAlarms: "No alarms",
	critical: "Critical",
	attention: "Attention",
	steady: "Steady",
	unchecked: "Unchecked",
	open: "Open life monitor",
	back: "Back to chat",
	bannerDown: "The local bridge is down. The previous round is still shown.",
	bannerFailed: "This round did not finish. The previous round is still shown.",
	bannerSteady: "All {n} channels are on the wall. Off and unwired channels are not alarms.",
	changed: "Changed",
	round: "This round",
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
	return text.replace(/\{(\w+)\}/g, (raw, name: string) => vars && name in vars ? String(vars[name]) : raw);
}

export function useLifeCopy(): void {
	useT();
}
