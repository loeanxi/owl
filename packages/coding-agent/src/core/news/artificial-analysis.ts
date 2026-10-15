import { parseHTML } from "linkedom";
import type { NewsLeaderboardEntry } from "./types.ts";

export const ARTIFICIAL_ANALYSIS_URL = "https://artificialanalysis.ai/leaderboards/models";

/** Read the published server-rendered table, not private APIs or executable Flight payloads. */
export function parseArtificialAnalysisLeaderboard(html: string): {
	entries: NewsLeaderboardEntry[];
	updatedAt: string | null;
} {
	const { document } = parseHTML(html);
	const table = [...document.querySelectorAll("table")].find((candidate) =>
		candidate.querySelector("thead")?.textContent?.includes("Artificial Analysis Intelligence Index"),
	);
	if (!table) throw new Error("Artificial Analysis 公开榜单结构已变化");
	const headers = [...(table.querySelectorAll("thead tr") ?? [])].at(-1)?.querySelectorAll("th");
	const labels = [...(headers ?? [])].map((cell) => cell.textContent?.trim() ?? "").filter(Boolean);
	const modelIndex = labels.indexOf("Model");
	const organizationIndex = labels.indexOf("Creator");
	const scoreIndex = labels.findIndex((label) => label.replace(/\s+/g, "") === "ArtificialAnalysisIntelligenceIndex");
	const priceIndex = labels.findIndex((label) => label.replace(/\s+/g, "").startsWith("CostperTask"));
	const speedIndex = labels.findIndex((label) => label.replace(/\s+/g, "").includes("Tokens/s"));
	if (modelIndex < 0 || organizationIndex < 0 || scoreIndex < 0)
		throw new Error("Artificial Analysis 榜单缺少模型、机构或智能指数列");
	const entries: NewsLeaderboardEntry[] = [];
	const seen = new Set<string>();
	for (const row of table.querySelectorAll("tbody tr")) {
		const cells = [...row.querySelectorAll("td")];
		if (cells.length !== labels.length) throw new Error("Artificial Analysis 榜单列数不一致");
		const model = cells[modelIndex]?.textContent?.trim();
		const rawScore = cells[scoreIndex]?.textContent?.trim() ?? "";
		if (!model || !/^\d+(?:\.\d+)?\*?$/.test(rawScore)) continue;
		const score = Number.parseFloat(rawScore);
		if (!Number.isFinite(score) || score < 0 || score > 100) continue;
		const href = [...row.querySelectorAll("a[href]")]
			.map((link) => link.getAttribute("href"))
			.find((link) => link && /^\/models\/[^/]+$/.test(link));
		const url = href ? new URL(href, ARTIFICIAL_ANALYSIS_URL).toString() : undefined;
		const id = `${href ?? "aa"}:${model}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const price = priceIndex >= 0 ? cells[priceIndex]?.textContent?.trim() : undefined;
		const speed = speedIndex >= 0 ? cells[speedIndex]?.textContent?.trim() : undefined;
		entries.push({
			id,
			rank: 0,
			model,
			organization: cells[organizationIndex]?.textContent?.trim() || undefined,
			score,
			url,
			detail: [
				price && /^\$[\d,.]+$/.test(price) ? `${price} / task` : undefined,
				speed && /^[\d,.]+$/.test(speed) ? `${speed} tokens/s` : undefined,
				rawScore.endsWith("*") ? "部分测评缺失，官方标记 *" : undefined,
			]
				.filter(Boolean)
				.join(" · "),
		});
	}
	if (!entries.length) throw new Error("Artificial Analysis 未返回有效的公开测评分数");
	entries.sort((a, b) => b.score - a.score);
	let rank = 0;
	return {
		entries: entries.map((entry, index) => {
			if (!index || entries[index - 1]?.score !== entry.score) rank = index + 1;
			return { ...entry, rank };
		}),
		// The public table does not disclose an assessment update date. Never use fetch time as one.
		updatedAt: null,
	};
}
