import type { OwlImageProvider, SkillCenterTab } from "../../bridge/protocol.ts";
import type { TextKey } from "../../i18n/index.ts";
import { type OwlPresetId, PRESET_DEFAULT_COLORS } from "../../owl-appearance.ts";

export const API_OPTIONS = [
	{ value: "openai-completions", labelKey: "settings.models.apiOpenaiCompat" },
	{ value: "anthropic-messages", labelKey: "settings.models.apiAnthropicCompat" },
	{ value: "openai-responses", labelKey: "settings.models.apiOpenaiResponses" },
] as const;

export const CHAT_READING_FIELDS = [
	{ key: "fontSize", titleKey: "settings.general.fieldFontSize", descKey: "settings.general.fieldFontSizeDesc", min: 14, max: 22, step: 1, unit: "px" },
	{ key: "codeFontSize", titleKey: "settings.general.fieldCodeFontSize", descKey: "settings.general.fieldCodeFontSizeDesc", min: 11, max: 18, step: 1, unit: "px" },
	{ key: "lineHeight", titleKey: "settings.general.fieldLineHeight", descKey: "settings.general.fieldLineHeightDesc", min: 1.5, max: 2, step: 0.05, unitKey: "settings.general.unitLines" },
	{ key: "width", titleKey: "settings.general.fieldWidth", descKey: "settings.general.fieldWidthDesc", min: 640, max: 960, step: 1, unit: "px" },
] as const;

/** 强调色预置色板（跟随主题的默认松石绿居首；自定义走原生拾色器）。 */
export const ACCENT_PRESETS = [
	{ value: "", labelKey: "settings.appearance.accentDefault" },
	{ value: "#3b82f6", labelKey: "settings.appearance.accentBlue" },
	{ value: "#06b6d4", labelKey: "settings.appearance.accentCyan" },
	{ value: "#8b5cf6", labelKey: "settings.appearance.accentViolet" },
	{ value: "#ec4899", labelKey: "settings.appearance.accentPink" },
	{ value: "#ef4444", labelKey: "settings.appearance.accentRed" },
	{ value: "#f97316", labelKey: "settings.appearance.accentOrange" },
	{ value: "#eab308", labelKey: "settings.appearance.accentAmber" },
] as const;

/** 壁纸类型徽标文案：video/web 直渲，scene 显示「预览图」表明是降级画面。 */
export const WALLPAPER_TYPE_LABEL = {
	video: "settings.appearance.wallpaperTypeVideo",
	web: "settings.appearance.wallpaperTypeWeb",
	scene: "settings.appearance.wallpaperTypeScene",
	application: "settings.appearance.wallpaperTypeApp",
} as const;

/** 主题预设（整套深色配色）。preview 是预览小卡用的示意色，与 index.css 各预设令牌保持一致。 */
export const OWL_THEME_PRESETS: { id: OwlPresetId; labelKey: TextKey; preview: { bg: string; rail: string; line: string; panel: string } }[] = [
	{ id: "", labelKey: "settings.appearance.presetGraphite", preview: { bg: "#1e1e1e", rail: "#151515", line: "#3d3d3d", panel: "#262626" } },
	{ id: "owl-green", labelKey: "settings.appearance.presetOwlGreen", preview: { bg: "#262624", rail: "#1a1918", line: "#45443e", panel: "#2f2e2b" } },
	{ id: "codex", labelKey: "settings.appearance.presetCodex", preview: { bg: "#f7f6f3", rail: "#e7e6e3", line: "#d9d7d2", panel: "#ffffff" } },
];

/** 当前预设下某深浅档的默认底色/文字色（预设无自定义时的拾色器兜底与 hex 展示）。 */
export function presetDefaultColors(preset: OwlPresetId, mode: "dark" | "light") {
	return PRESET_DEFAULT_COLORS[preset][mode];
}

/** owl-image 的 provider 清单（顺序即下拉顺序；标签走 settings.image.p.* 字典）。 */
export const OWL_IMAGE_PROVIDERS: readonly OwlImageProvider[] = [
	"google",
	"openai",
	"openai-compat",
	"seedream",
	"dashscope",
	"xai",
	"zhipu",
	"comfyui",
	"google-sub",
];

/** owl-image 的 BYOK provider（有 API key 输入行的子集）。 */
export const OWL_IMAGE_BYOK: readonly Exclude<OwlImageProvider, "comfyui" | "google-sub">[] = ["google", "openai", "openai-compat", "seedream", "dashscope", "xai", "zhipu"];

export const OWL_IMAGE_PROVIDER_LABEL_KEYS: Record<OwlImageProvider, TextKey> = {
	google: "settings.image.p.google",
	openai: "settings.image.p.openai",
	"openai-compat": "settings.image.p.openai-compat",
	seedream: "settings.image.p.seedream",
	dashscope: "settings.image.p.dashscope",
	xai: "settings.image.p.xai",
	zhipu: "settings.image.p.zhipu",
	comfyui: "settings.image.p.comfyui",
	"google-sub": "settings.image.p.google-sub",
};

/** 技能中心的 tab 元数据（groups 是 UI 层 tab：组是全局集合，不在 skills.list 的根目录里）。 */
export const SKILL_TABS: { tab: SkillCenterTab | "groups"; labelKey: TextKey; descKey: TextKey }[] = [
	{ tab: "personal", labelKey: "settings.skills.tabPersonal", descKey: "settings.skills.tabPersonalDesc" },
	{ tab: "global", labelKey: "settings.skills.tabGlobal", descKey: "settings.skills.tabGlobalDesc" },
	{ tab: "project", labelKey: "settings.skills.tabProject", descKey: "settings.skills.tabProjectDesc" },
	{ tab: "groups", labelKey: "settings.skills.tabGroups", descKey: "settings.skills.tabGroupsDesc" },
];

/** 内置提示词分区的展示名（顺序即渲染顺序）。 */
export const BUILTIN_SECTION_TITLES: Record<string, TextKey> = {
	preamble: "settings.prompts.secPreamble",
	tools: "settings.prompts.secTools",
	rules: "settings.prompts.secRules",
	docs: "settings.prompts.secDocs",
	addendum: "settings.prompts.secAddendum",
	project_context: "settings.prompts.secProjectContext",
	skills: "settings.prompts.secSkills",
	cwd: "settings.prompts.secCwd",
};
