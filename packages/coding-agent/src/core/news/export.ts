import type { NewsItem, NewsSource } from "./types.ts";

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/** Export has a separate full-text grant from the desktop reader's grant. */
export function exportNewsItems(
	format: "rss" | "json" | "markdown",
	items: NewsItem[],
	sources: NewsSource[],
	fulltext = false,
): {
	content: string;
	filename: string;
	mimeType: string;
} {
	const visible = items.filter(
		(item) =>
			item.status === "ready" && item.relevance !== "block" && item.participation === "editorial" && !item.withdrawn,
	);
	const bodyFor = (item: NewsItem) =>
		fulltext && sources.find((source) => source.id === item.sourceId)?.syndicateFulltext
			? item.body || item.originalBody
			: null;
	const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
	if (format === "json")
		return {
			content: JSON.stringify(
				{
					title: "Owl 资讯",
					exportedAt: new Date().toISOString(),
					items: visible.map((item) => ({
						id: item.id,
						title: item.title,
						summary: item.summary,
						url: item.url,
						source: item.sourceName,
						publishedAt: item.publishedAt,
						category: item.category,
						tags: item.tags,
						selected: item.selected,
						storyId: item.storyId,
						body: bodyFor(item),
					})),
				},
				null,
				2,
			),
			filename: `owl-news-${date}.json`,
			mimeType: "application/json; charset=utf-8",
		};
	if (format === "markdown")
		return {
			content:
				`# Owl 资讯\n\n导出时间：${date}\n\n` +
				visible
					.map(
						(item) =>
							`## ${item.title}\n\n${item.summary}\n\n来源：${item.sourceName} · ${item.publishedAt}\n\n[查看原文](${item.url})${bodyFor(item) ? `\n\n${bodyFor(item)}` : ""}`,
					)
					.join("\n\n---\n\n"),
			filename: `owl-news-${date}.md`,
			mimeType: "text/markdown; charset=utf-8",
		};
	return {
		content:
			`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Owl 资讯</title><link>https://owl.local/</link><description>Owl 行业资讯</description>` +
			visible
				.map(
					(item) =>
						`<item><guid isPermaLink="false">${xml(item.id)}</guid><title>${xml(item.title)}</title><link>${xml(item.url)}</link><pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate><description>${xml(bodyFor(item) || item.summary)}</description><source>${xml(item.sourceName)}</source></item>`,
				)
				.join("") +
			"</channel></rss>",
		filename: `owl-news-${date}.xml`,
		mimeType: "application/rss+xml; charset=utf-8",
	};
}
