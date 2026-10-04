import type { UiLanguage } from "../../i18n/index.ts";

const zh = {
	action: "补充正文",
	hint: "粘贴从原文浏览器读取的完整正文；保存后按当前模型重新分析。",
	label: "完整正文",
	placeholder: "在这里粘贴原文完整正文…",
	limit: "最多 500000 个字符。",
	save: "保存并重新分析",
	saving: "正在保存正文…",
	saved: "正文已保存，已提交重新分析。",
	empty: "请先粘贴完整正文。",
	tooLong: "正文不能超过 500000 个字符。",
	unavailable: "当前内容状态已变化，请刷新详情后再补充正文。",
};

type NewsBodyCopy = { [Key in keyof typeof zh]: string };

const en: NewsBodyCopy = {
	action: "Add full article",
	hint: "Paste the complete article from the original browser page. Save to analyze it again with the current model.",
	label: "Full article text",
	placeholder: "Paste the complete original article here…",
	limit: "Up to 500000 characters.",
	save: "Save and analyze again",
	saving: "Saving article text…",
	saved: "Article text saved and submitted for analysis.",
	empty: "Paste the complete article first.",
	tooLong: "The article must not exceed 500000 characters.",
	unavailable: "The item has changed. Refresh the details before adding the article text.",
};

export const newsBodyCopy: Record<UiLanguage, NewsBodyCopy> = { zh, en };
