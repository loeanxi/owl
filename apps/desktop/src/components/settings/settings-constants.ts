import type { OwlImageProvider, SkillCenterTab } from "../../bridge/protocol.ts";
import type { FileIconThemeId } from "../../file-icons/file-icon-theme.ts";
import type { TextKey } from "../../i18n/index.ts";
import { type OwlGlassMode, type OwlPresetId, PRESET_DEFAULT_COLORS } from "../../owl-appearance.ts";

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

/** 工作过程动效逐条开关：id 与 work-process-effects.ts 的清单一致，顺序即展示顺序。 */
export const WORK_EFFECT_FIELDS = [
	{ id: "rail", titleKey: "settings.general.workEffectRail", descKey: "settings.general.workEffectRailDesc" },
	{ id: "enter", titleKey: "settings.general.workEffectEnter", descKey: "settings.general.workEffectEnterDesc" },
	{ id: "morph", titleKey: "settings.general.workEffectMorph", descKey: "settings.general.workEffectMorphDesc" },
	{ id: "count", titleKey: "settings.general.workEffectCount", descKey: "settings.general.workEffectCountDesc" },
	{ id: "spine", titleKey: "settings.general.workEffectSpine", descKey: "settings.general.workEffectSpineDesc" },
	{ id: "stream", titleKey: "settings.general.workEffectStream", descKey: "settings.general.workEffectStreamDesc" },
	{ id: "breathe", titleKey: "settings.general.workEffectBreathe", descKey: "settings.general.workEffectBreatheDesc" },
	{ id: "nudge", titleKey: "settings.general.workEffectNudge", descKey: "settings.general.workEffectNudgeDesc" },
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
	{ id: "claude", labelKey: "settings.appearance.presetClaude", preview: { bg: "#f5f4f1", rail: "#eceae4", line: "#d8d5cd", panel: "#ffffff" } },
	{
		id: "liquid-glass",
		labelKey: "settings.appearance.presetLiquidGlass",
		preview: {
			bg: "radial-gradient(80% 90% at 0% 0%, #4070ff, transparent 70%), radial-gradient(70% 80% at 100% 100%, #b052ff, transparent 70%), radial-gradient(60% 60% at 100% 0%, #00c4b4, transparent 70%), #141733",
			rail: "rgb(255 255 255 / 12%)",
			line: "rgb(255 255 255 / 30%)",
			panel: "rgb(255 255 255 / 18%)",
		},
	},
	{
		id: "frost",
		labelKey: "settings.appearance.presetFrost",
		preview: {
			bg: "linear-gradient(160deg, #c9cbd2, #a9abb4)",
			rail: "rgb(24 26 38 / 10%)",
			line: "rgb(24 26 38 / 45%)",
			panel: "rgb(40 42 58 / 55%)",
		},
	},
	{ id: "ink", labelKey: "settings.appearance.presetInk", preview: { bg: "#181818", rail: "#101010", line: "#2c2c2c", panel: "#1f1f1f" } },
	{ id: "polar-night", labelKey: "settings.appearance.presetPolarNight", preview: { bg: "#1e2127", rail: "#15171c", line: "#323743", panel: "#272c36" } },
	{ id: "ink-hc", labelKey: "settings.appearance.presetInkHc", preview: { bg: "#0a0a0a", rail: "#000000", line: "#3a3a3a", panel: "#141414" } },
	{ id: "vscode-modern", labelKey: "settings.appearance.presetVscodeModern", preview: { bg: "#1f1f1f", rail: "#141414", line: "#333333", panel: "#282828" } },
	{ id: "vscode-classic", labelKey: "settings.appearance.presetVscodeClassic", preview: { bg: "#1e1e1e", rail: "#333333", line: "#3c3c3c", panel: "#252526" } },
	{ id: "monokai", labelKey: "settings.appearance.presetMonokai", preview: { bg: "#272822", rail: "#191a17", line: "#414339", panel: "#34352f" } },
	{ id: "monokai-dimmed", labelKey: "settings.appearance.presetMonokaiDimmed", preview: { bg: "#1e1e1e", rail: "#353535", line: "#404040", panel: "#272727" } },
	{ id: "solarized", labelKey: "settings.appearance.presetSolarized", preview: { bg: "#002b36", rail: "#001b23", line: "#0f4a58", panel: "#073642" } },
	{ id: "abyss", labelKey: "settings.appearance.presetAbyss", preview: { bg: "#0e1726", rail: "#060b15", line: "#293b55", panel: "#182538" } },
	{ id: "tomorrow-night-blue", labelKey: "settings.appearance.presetTomorrowNightBlue", preview: { bg: "#002451", rail: "#001733", line: "#2a4373", panel: "#003064" } },
	{ id: "kimbie-dark", labelKey: "settings.appearance.presetKimbieDark", preview: { bg: "#221a0f", rail: "#17110a", line: "#51412c", panel: "#362712" } },
	{ id: "red", labelKey: "settings.appearance.presetRed", preview: { bg: "#390000", rail: "#2a0000", line: "#6b1a1a", panel: "#480000" } },
	{ id: "quiet-light", labelKey: "settings.appearance.presetQuietLight", preview: { bg: "#f5f5f5", rail: "#ededf5", line: "#d6d6d6", panel: "#ffffff" } },
	{ id: "high-contrast", labelKey: "settings.appearance.presetHighContrast", preview: { bg: "#000000", rail: "#000000", line: "#6fc3df", panel: "#0b0b0b" } },
];

export const GLASS_MODE_LABEL_KEYS: Record<OwlGlassMode, TextKey> = {
	clear: "settings.appearance.glassClear",
	blur: "settings.appearance.glassBlur",
	acrylic: "settings.appearance.glassAcrylic",
};

export const FILE_ICON_THEME_LABEL_KEYS: Record<FileIconThemeId, TextKey> = {
	none: "settings.appearance.fileIconNone",
	minimal: "settings.appearance.fileIconMinimal",
	seti: "settings.appearance.fileIconSeti",
	material: "settings.appearance.fileIconMaterial",
};

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
