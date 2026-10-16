import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	accept: "采纳下一句建议",
	acceptShort: "采纳",
	hint: "按 Tab 采纳建议，编辑后再发送；Esc 忽略。",
	setting: "下一句建议",
	settingHint: "回复结束后，使用当前模型生成下一句建议，会计入模型用量。",
} as const;

const en: Record<keyof typeof zh, string> = {
	accept: "Accept suggested prompt",
	acceptShort: "Accept",
	hint: "Press Tab to accept, then edit and send. Esc dismisses.",
	setting: "Suggested next prompt",
	settingHint: "Use the current model to suggest the next message after a reply; this counts toward model usage.",
};

export function composerPredictionText(key: keyof typeof zh): string {
	return (getUiLanguage() === "en" ? en : zh)[key];
}

export function useComposerPredictionText(): typeof composerPredictionText {
	useT();
	return composerPredictionText;
}
