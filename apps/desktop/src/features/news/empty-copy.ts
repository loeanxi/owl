import type { UiLanguage } from "../../i18n/index.ts";

const zh = {
	collectedTitle: "资讯已采集，暂未入选精选",
	collectedHint: "精选会按评分和原文证据筛选。你可以先在全部动态阅读已完成分析的资讯。",
	viewAll: "查看全部动态",
};

type NewsEmptyCopy = { [Key in keyof typeof zh]: string };

const en: NewsEmptyCopy = {
	collectedTitle: "News collected, with no featured items yet",
	collectedHint:
		"Featured items are chosen by score and source evidence. Open All updates to read items that have finished processing.",
	viewAll: "View all updates",
};

export const newsEmptyCopy: Record<UiLanguage, NewsEmptyCopy> = { zh, en };
