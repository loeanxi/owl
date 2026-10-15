import { describe, expect, it } from "vitest";
import { parseArtificialAnalysisLeaderboard } from "../../src/core/news/artificial-analysis.ts";

const table = `<table><thead><tr><th></th><th colspan="3">Intelligence</th></tr><tr><th></th><th>Model</th><th>Context Window</th><th>Creator</th><th>Artificial Analysis Intelligence Index</th><th>Cost per Task<span>USD</span></th><th>Median<span>Tokens/s</span></th><th>Further Analysis</th></tr></thead><tbody>
<tr><td>Recent model &amp; reasoning</td><td>1M</td><td>Test Lab</td><td>58</td><td>$0.72</td><td>48</td><td><a href="/models/recent-model">Model</a></td></tr>
<tr><td>Other model</td><td>1M</td><td>Another Lab</td><td>58</td><td>--</td><td>--</td><td><a href="/models/other">Model</a></td></tr>
<tr><td>Partial model</td><td>1M</td><td>Test Lab</td><td>35*</td><td>$1.00</td><td>12</td><td><a href="/models/partial">Model</a></td></tr>
<tr><td>Unmeasured</td><td>1M</td><td>Test Lab</td><td>--</td><td>--</td><td>--</td><td></td></tr>
</tbody></table>`;

describe("Artificial Analysis published leaderboard", () => {
	it("reads the published index, preserves effort names and original order for equal scores", () => {
		const result = parseArtificialAnalysisLeaderboard(`<html><body>${table}</body></html>`);
		expect(result.entries.map(({ model, score, rank }) => ({ model, score, rank }))).toEqual([
			{ model: "Recent model & reasoning", score: 58, rank: 1 },
			{ model: "Other model", score: 58, rank: 1 },
			{ model: "Partial model", score: 35, rank: 3 },
		]);
		expect(result.entries[0]).toMatchObject({
			organization: "Test Lab",
			url: "https://artificialanalysis.ai/models/recent-model",
			detail: "$0.72 / task · 48 tokens/s",
		});
		expect(result.entries[2]?.detail).toContain("官方标记 *");
		expect(result.updatedAt).toBeNull();
	});
	it("rejects missing or reordered-incompatible columns rather than reading a price as an intelligence score", () => {
		expect(() =>
			parseArtificialAnalysisLeaderboard(table.replace("Artificial Analysis Intelligence Index", "Price")),
		).toThrow("公开榜单结构");
		expect(() => parseArtificialAnalysisLeaderboard(table.replace("<td>58</td>", ""))).toThrow("列数不一致");
	});
	it("does not execute scripts or fabricate scores for unmeasured models", () => {
		const html = `<script>throw new Error("must not execute")</script>${table}`;
		expect(parseArtificialAnalysisLeaderboard(html).entries).toHaveLength(3);
		expect(() =>
			parseArtificialAnalysisLeaderboard(table.replaceAll(/<td>(?:58|35\*)<\/td>/g, "<td>--</td>")),
		).toThrow("有效");
	});
});
