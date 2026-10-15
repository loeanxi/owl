import { describe, expect, it, vi } from "vitest";
import { fetchCurrentLiveBench, parseCurrentLiveBenchData } from "../../src/core/news/livebench-current.ts";

const metadata = `export const modelLinks = {
    "current-alpha": { displayName: "Current Alpha", organization: "Example", url: "https://example.com/alpha", effort: "max" },
    "current-beta": { displayName: "Current Beta", url: "javascript:alert(1)" },
    "current-gamma": { displayName: "Current Gamma" },
};`;
const categories = { Reasoning: ["logic_a", "logic_b"], Coding: ["coding"], Browser: ["browser"] };
const csv = [
	"model,logic_a,logic_b,coding,browser",
	"current-alpha,100,100,80,0",
	"current-beta,n/a,,90,",
	"current-gamma,50,50,,50",
	"unknown,100,100,100,100",
].join("\n");

describe("current LiveBench deployment", () => {
	it("matches the website mean, excludes ungraded suites, includes zero and keeps coding separate", () => {
		const result = parseCurrentLiveBenchData(csv, categories, metadata);
		expect(result.entries.map(({ id, score, rank }) => ({ id, score, rank }))).toEqual([
			{ id: "current-beta", score: 90, rank: 1 },
			{ id: "current-alpha", score: 60, rank: 2 },
			{ id: "current-gamma", score: 50, rank: 3 },
		]);
		expect(result.codingEntries.map(({ id, score }) => ({ id, score }))).toEqual([
			{ id: "current-beta", score: 90 },
			{ id: "current-alpha", score: 80 },
		]);
		expect(result.entries.find((entry) => entry.id === "current-beta")?.url).toBeUndefined();
		expect(result.entries.find((entry) => entry.id === "current-alpha")?.detail).toContain("max");
	});

	it("discovers the deployed bundle and current label, ignoring the archived v1 metadata", async () => {
		const sourceMap = {
			sources: ["v1/lib/constants.js", "lib/constants.js", "v1/Table/modelLinks.js", "Table/modelLinks.js"],
			sourcesContent: [
				'export const RELEASES = ["2025-01-01"];',
				'export const RELEASES = ["2026-09-02", "2026-07-01"]; const RELEASE_LABELS = { "2026-09-02": "2026-10-14" };',
				"throw new Error('must not execute source text');",
				metadata,
			],
		};
		const getText = vi.fn(async (url: string) => {
			if (url === "https://livebench.ai/")
				return '<script src="https://example.com/static/js/main.other.js"></script><script defer src="./static/js/main.current.js"></script>';
			if (url === "https://livebench.ai/static/js/main.current.js.map") return JSON.stringify(sourceMap);
			if (url === "https://livebench.ai/table_2026_09_02.csv?v=main.current.js") return csv;
			if (url === "https://livebench.ai/categories_2026_09_02.json?v=main.current.js")
				return JSON.stringify(categories);
			throw new Error(`Unexpected request ${url}`);
		});
		const result = await fetchCurrentLiveBench(getText);
		expect(result.updatedAt).toBe("2026-10-14");
		expect(result.dataUrl).toBe("https://livebench.ai/table_2026_09_02.csv?v=main.current.js");
		expect(result.entries).toHaveLength(3);
		expect(getText).toHaveBeenCalledTimes(4);
	});

	it("uses the version date if the current deployment has no display-date mapping", async () => {
		const getText = async (url: string) => {
			if (url.endsWith(".map"))
				return JSON.stringify({
					sources: ["src/lib/constants.js", "src/Table/modelLinks.js"],
					sourcesContent: ['export const RELEASES = ["2026-11-12"];', metadata],
				});
			if (url.includes(".csv")) return csv;
			if (url.includes(".json")) return JSON.stringify(categories);
			return '<script src="/static/js/main.next-version.js"></script>';
		};
		expect((await fetchCurrentLiveBench(getText)).updatedAt).toBe("2026-11-12");
	});

	it("fails visibly when the current index or scores change instead of serving archived results as current", async () => {
		await expect(fetchCurrentLiveBench(async () => "<html>new deployment</html>")).rejects.toThrow("入口已变化");
		await expect(
			fetchCurrentLiveBench(async (url) =>
				url.endsWith(".map")
					? JSON.stringify({ sources: ["v1/lib/constants.js"], sourcesContent: ["old"] })
					: '<script src="/static/js/main.abc.js"></script>',
			),
		).rejects.toThrow("缺少 lib/constants.js");
		expect(() => parseCurrentLiveBenchData(csv.replace(",80,", ",101,"), categories, metadata)).toThrow("无效分数");
		expect(() => parseCurrentLiveBenchData(csv, { Coding: ["missing"] }, metadata)).toThrow("缺少评测子任务");
		expect(() => parseCurrentLiveBenchData(csv, categories, "throw new Error('never run')")).toThrow("目录格式");
	});
});
