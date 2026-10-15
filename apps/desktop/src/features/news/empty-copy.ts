import type { UiLanguage } from "../../i18n/index.ts";

const zh = {
	collectedTitle: "暂时没有新的精选",
	collectedHint: "最新资讯里还有更多内容，可以先看看各家发布了什么。",
	viewAll: "查看最新资讯",
	emptyTitle: "暂时没有可读资讯",
	emptyHint: "资讯来自已启用的信源，阅读无需配置模型。可以点击更新重试。",
	update: "更新资讯",
	updating: "正在更新…",
	savedTitle: "还没有收藏资讯",
	savedHint: "在感兴趣的资讯下点击「收藏」，以后就能在这里找到。",
	filteredTitle: "没有找到匹配的资讯",
	filteredHint: "试试其他关键词，或清除筛选查看最新资讯。",
	clearFilters: "清除筛选",
};

type NewsEmptyCopy = { [Key in keyof typeof zh]: string };

const en: NewsEmptyCopy = {
	collectedTitle: "No new featured stories yet",
	collectedHint: "There is more to read in Latest news. See what publishers have shared.",
	viewAll: "View latest news",
	emptyTitle: "No stories available yet",
	emptyHint:
		"Public updates come from enabled sources. No model setup is needed to read. Choose Update news to try again.",
	update: "Update news",
	updating: "Updating…",
	savedTitle: "No saved stories yet",
	savedHint: "Choose Save on a story to keep it here for later.",
	filteredTitle: "No matching stories",
	filteredHint: "Try a different keyword or clear the filters to see the latest news.",
	clearFilters: "Clear filters",
};

export const newsEmptyCopy: Record<UiLanguage, NewsEmptyCopy> = { zh, en };
