import type { WorkspaceSettingsSection } from "../../workspace-memory.ts";

/**
 * 设置分区搜索索引：每个分区一行「中文名 + 英文名 + 中英别名」。
 * 设置页 22 个分区没有搜索，找一个具体开关只能靠记忆猜分区；
 * 这里故意静态化（不扫 DOM、不依赖运行时 t()），matcher 纯函数可单测。
 * 别名挑用户实际会输入的词（如「字号」「壁纸」「token」「MCP」），宁全勿缺。
 */
export const SETTINGS_SEARCH_INDEX: Record<WorkspaceSettingsSection, string> = {
	general: "general 通用 设置 语言 字号 行高 font language",
	accounts: "accounts 账号 账户 登录 登出 密码 api key 令牌 account auth login",
	models: "models 模型 供应商 服务 商业化 额度 限流 上下文 思考 推理 model provider",
	plugins: "plugins 插件 扩展 mcp server plugin",
	skills: "skills 技能 斜杠命令 skill slash",
	presets: "presets 预设 智能体 人设 agent preset",
	sidebar: "sidebar 侧栏 侧边栏 项目卡片 会话分组 sidebar",
	prompts: "prompts 提示词 自定义指令 prompt",
	memory: "memory 记忆 长期记忆 memory",
	image: "image 图像 图片 壁纸播放器 image",
	appearance: "appearance 外观 主题 深色 浅色 字体 背景 强调色 壁纸 纸感 theme font wallpaper accent",
	animation: "animation 动效 动画 执行过程过程动效 过程 motion",
	notifications: "notifications 通知 提醒 完成提醒 notification",
	usage: "usage 用量 统计 token 成本 花费 曲线 热力 usage",
	archived: "archived 归档 已归档会话 archive",
	json: "json settings.json 配置文件 原始配置",
	diagnostics: "diagnostics 诊断 生命体征 健康检查 diagnostics",
	"execution-anomalies": "execution-anomalies 执行异常 异常 失败 归档 anomaly failure",
	changelog: "changelog 更新日志 版本说明 changelog",
	about: "about 关于 版本 检查更新 about",
};

/** 返回命中的分区集合；空查询返回 null（= 不过滤，全部显示）。 */
export function matchSettingsSections(query: string): Set<WorkspaceSettingsSection> | null {
	const needle = query.trim().toLowerCase();
	if (!needle) return null;
	const hits = new Set<WorkspaceSettingsSection>();
	for (const [section, haystack] of Object.entries(SETTINGS_SEARCH_INDEX)) {
		if (haystack.toLowerCase().includes(needle)) hits.add(section as WorkspaceSettingsSection);
	}
	return hits;
}
