// longevity-search：关键词 AND、小节过滤、排序与排版。用最小条目样本锁行为，
// 不依赖网络与磁盘。
import { describe, expect, it } from "vitest";
import {
	formatLongevityNoMatches,
	formatLongevityOverview,
	formatLongevityResults,
	formatLongevitySingle,
	searchLongevity,
} from "../src/longevity-search.ts";
import type { LongevityEntry } from "../src/longevity-source.ts";

function makeEntry(
	sectionNo: string,
	section: string,
	name: string,
	disputed: boolean,
	details: string[],
	links: Array<{ text: string; url: string }> = [],
): LongevityEntry {
	return {
		sectionNo,
		section,
		key: `${sectionNo}/${name}`,
		name,
		disputed,
		links,
		details,
	};
}

const entries: LongevityEntry[] = [
	makeEntry(
		"6.1.2",
		"6.1.2 液体",
		"牛奶",
		false,
		["全因死亡风险下降了17%"],
		[{ text: "《柳叶刀》调研", url: "https://example.com/milk" }],
	),
	makeEntry("6.1.2", "6.1.2 液体", "酒", true, ["戒酒（否则+~50% ACM）"], []),
	makeEntry("6.2.1", "6.2.1 挥拍运动", "挥拍运动", false, ["一周三次，降低~47%全因死亡率"], []),
];

describe("searchLongevity", () => {
	it("关键词按子串 AND 匹配，命中主题与明细", () => {
		const { hits, matched } = searchLongevity(entries, { query: "牛奶", limit: 8 });
		expect(matched).toBe(1);
		expect(hits[0].entry.key).toBe("6.1.2/牛奶");

		const and = searchLongevity(entries, { query: "全因 风险", limit: 8 });
		expect(and.hits.map((hit) => hit.entry.name)).toEqual(["牛奶"]);
	});

	it("section 过滤按小节号或小节名子串匹配", () => {
		const byNo = searchLongevity(entries, { query: "", section: "6.2", limit: 8 });
		expect(byNo.hits.map((hit) => hit.entry.key)).toEqual(["6.2.1/挥拍运动"]);

		const byName = searchLongevity(entries, { query: "", section: "液体", limit: 8 });
		expect(byName.hits.map((hit) => hit.entry.name)).toEqual(["牛奶", "酒"]);
	});

	it("无关键词时按小节号排序返回全部", () => {
		const { hits } = searchLongevity(entries, { query: "", limit: 8 });
		expect(hits.map((hit) => hit.entry.key)).toEqual(["6.1.2/牛奶", "6.1.2/酒", "6.2.1/挥拍运动"]);
	});

	it("未命中时给出改写建议", () => {
		const { hits } = searchLongevity(entries, { query: "不存在的东西", limit: 8 });
		expect(hits).toHaveLength(0);
		const text = formatLongevityNoMatches({ query: "不存在的东西", limit: 8 });
		expect(text).toContain("未命中");
	});
});

describe("longevity 排版", () => {
	it("检索结果头部带统计与快照日期，条目带 key 与争议标记", () => {
		const { hits, matched } = searchLongevity(entries, { query: "酒", limit: 8 });
		const text = formatLongevityResults(entries, hits, matched, { savedAt: "2026-10-14", complete: true }, 8, false);
		expect(text).toContain("《程序员延寿指南》命中 1 条");
		expect(text).toContain("本地快照 2026-10-14");
		expect(text).toContain("〔6.1.2/酒〕");
		expect(text).toContain("存在争议");
	});

	it("单条全文附来源仓库地址", () => {
		const text = formatLongevitySingle(entries[0], { savedAt: "2026-10-14", complete: true });
		expect(text).toContain("〔6.1.2/牛奶〕");
		expect(text).toContain("github.com/geekan/HowToLiveLonger");
		expect(text).toContain("https://example.com/milk");
	});

	it("概览列小节目录与条数", () => {
		const text = formatLongevityOverview(entries, { complete: true });
		expect(text).toContain("6.1.2 液体（2 条）");
		expect(text).toContain("6.2.1 挥拍运动（1 条）");
	});
});
