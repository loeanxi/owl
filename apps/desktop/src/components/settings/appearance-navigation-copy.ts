import { DEFAULT_CHAT_APPEARANCE } from "../../chat-appearance.ts";
import { getUiLanguage, useT } from "../../i18n/index.ts";

const zh = {
	navigation: "外观设置分组",
	interface: "界面",
	reading: "阅读",
	theme: "主题",
	wallpaper: "壁纸",
	readingDescription: "调整聊天文字、行距和内容列宽度，点击“保存阅读设置”后生效，不会改变模型回答。",
} as const;

const en: Record<keyof typeof zh, string> = {
	navigation: "Appearance sections",
	interface: "Interface",
	reading: "Reading",
	theme: "Theme",
	wallpaper: "Wallpaper",
	readingDescription:
		"Adjust chat text, line spacing and column width, then save to apply. Model answers are unchanged.",
};

export const appearanceNavigationText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];

export function useAppearanceNavigationText(): typeof appearanceNavigationText {
	useT();
	return appearanceNavigationText;
}

const readingDescriptions = {
	zh: {
		fontSize: "调整回答正文和聊天消息的文字大小，不影响输入框和侧栏字号。默认 {value} px。",
		codeFontSize: "调整代码块、命令和工具输出的文字大小，普通聊天文字不变。默认 {value} px。",
		lineHeight: "调整回答中每行文字之间的距离，数值越大越疏松，不会放大文字。默认 {value} 倍。",
		width: "控制聊天正文与输入区的最大宽度，窄窗口会自动收缩。默认 {value} px。",
	},
	en: {
		fontSize: "Size of answer text and chat messages; input and sidebar text are unchanged. Default: {value} px.",
		codeFontSize:
			"Size of code blocks, commands and tool output; ordinary chat text is unchanged. Default: {value} px.",
		lineHeight: "Distance between answer lines. Higher values add space without enlarging text. Default: {value}×.",
		width: "Maximum width of chat text and the input column. Both fit narrower windows automatically. Default: {value} px.",
	},
};

/** Help text follows the same defaults as Reset, including the shared chat/composer width. */
export function appearanceReadingFieldDescription(field: keyof typeof readingDescriptions.zh): string {
	return readingDescriptions[getUiLanguage()][field].replace("{value}", String(DEFAULT_CHAT_APPEARANCE[field]));
}
