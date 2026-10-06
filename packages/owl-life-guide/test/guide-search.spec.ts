// guide-search：AND 检索、加权排序、过滤与文本排版。纯函数，不触网。
import { describe, expect, it } from "vitest";
import {
	chapterCounts,
	flattenChapters,
	formatNoMatches,
	formatOverview,
	formatSearchResults,
	formatSingleTip,
	searchGuide,
} from "../src/guide-search.ts";
import { GUIDE_CHAPTERS, type GuideChapter, parseGuideChapter } from "../src/guide-source.ts";

function makeChapter(
	no: number,
	tips: Array<{ no: number; title: string; plain?: string; grade?: string; remark?: string }>,
): GuideChapter {
	const meta = GUIDE_CHAPTERS.find((c) => c.no === no) ?? GUIDE_CHAPTERS[0];
	const body = tips
		.map((tip) =>
			[
				`### ${tip.no}. ${tip.title}`,
				"<!-- 成本标签: 钱=0 收益=大 -->",
				`- 说人话：${tip.plain ?? `${tip.title}的做法。`}`,
				`- 证据等级：${tip.grade ?? "B"}`,
				...(tip.remark ? [`- 备注：${tip.remark}`] : []),
			].join("\n"),
		)
		.join("\n");
	return parseGuideChapter(meta, `# ${no}. ${meta.title}\n\n${body}\n`);
}

const chapters: GuideChapter[] = [
	makeChapter(1, [
		{ no: 1, title: "系安全带，前排后排都系", plain: "出车祸时被撞死的概率大约降一半。", grade: "A" },
		{ no: 2, title: "骑摩托车、电动自行车戴头盔并扣好", plain: "死亡的概率低约四成。", grade: "A" },
		{ no: 6, title: "电动自行车不推进楼道、不进电梯", plain: "火正好堵在你唯一的逃生通道上。", grade: "A" },
		{
			no: 9,
			title: "开车不超速、不酒驾",
			plain: "平均车速每高 1%，撞死人的概率高约 4%。",
			grade: "B",
			remark: "争议：酒精没有「喝一点没事」的安全线。",
		},
	]),
	makeChapter(15, [
		{ no: 3, title: "租房先查抵押与查封", plain: "租的房子被查封会被赶出去。", grade: "C" },
		{ no: 4, title: "被查酒驾时配合酒精检测", plain: "租的车位别装充电桩。", grade: "B" },
	]),
];

const snapshot = { savedAt: "2026-10-06", complete: true };

describe("searchGuide", () => {
	it("单关键词：标题命中的条目排在正文/备注命中之前", () => {
		const { hits } = searchGuide(chapters, { query: "安全带", limit: 10 });
		expect(hits).toHaveLength(1);
		expect(hits[0].tip.key).toBe("1.1");

		// 「酒精」在 15.4 的标题里（权重 6），只在 1.9 的备注里（权重 1）。
		const alcohol = searchGuide(chapters, { query: "酒精", limit: 10 });
		expect(alcohol.matched).toBe(2);
		expect(alcohol.hits[0].tip.key).toBe("15.4");
		expect(alcohol.hits[1].tip.key).toBe("1.9");
	});

	it("多关键词 AND：不满足任一词即淘汰", () => {
		const both = searchGuide(chapters, { query: "电动 自行车", limit: 10 });
		expect(both.matched).toBe(2);
		const none = searchGuide(chapters, { query: "电动 安全带", limit: 10 });
		expect(none.matched).toBe(0);
	});

	it("grade 过滤与 disputed 过滤", () => {
		const aOnly = searchGuide(chapters, { query: "", grade: "A", limit: 10 });
		expect(aOnly.matched).toBe(3);
		const disputed = searchGuide(chapters, { query: "", grade: "disputed", limit: 10 });
		expect(disputed.matched).toBe(1);
		expect(disputed.hits[0].tip.key).toBe("1.9");
	});

	it("chapter 过滤", () => {
		const only15 = searchGuide(chapters, { query: "", chapter: 15, limit: 10 });
		expect(only15.matched).toBe(2);
		expect(only15.hits.every((h) => h.chapter.no === 15)).toBe(true);
	});

	it("matched 是命中总数，与 limit 无关；hits 全量返回，截断在排版层", () => {
		const { hits, matched } = searchGuide(chapters, { query: "", limit: 2 });
		expect(matched).toBe(6);
		expect(hits).toHaveLength(6);
	});

	it("空查询按 等级→key 顺序返回（A 级在前）", () => {
		const { hits } = searchGuide(chapters, { query: "", limit: 10 });
		expect(hits.map((h) => h.tip.key)).toEqual(["1.1", "1.2", "1.6", "1.9", "15.4", "15.3"]);
	});

	it("flattenChapters 平铺全部条目", () => {
		expect(flattenChapters(chapters)).toHaveLength(6);
	});
});

describe("排版输出", () => {
	it("formatSearchResults 头部带命中数、等级分布与快照日期", () => {
		const { hits, matched } = searchGuide(chapters, { query: "电动", limit: 5 });
		const text = formatSearchResults(chapters, hits, matched, snapshot, 5, false);
		expect(text).toContain("命中 2 条");
		expect(text).toContain("A 3 / B 2 / C 1 / 争议 1");
		expect(text).toContain("本地快照 2026-10-06");
		expect(text).toContain("〔1.2〕");
		expect(text).toContain("CC BY 4.0");
		// full=false 不带来源级字段。
		expect(text).not.toContain("备注：");
	});

	it("full=true 展开备注，争议如实保留", () => {
		const { hits, matched } = searchGuide(chapters, { query: "酒驾", limit: 5 });
		const text = formatSearchResults(chapters, hits, matched, snapshot, 5, true);
		expect(text).toContain("（争议）");
		expect(text).toContain("安全线");
	});

	it("formatOverview 列出章目录与条数", () => {
		const text = formatOverview(chapters, snapshot);
		expect(text).toContain("全书概览");
		expect(text).toContain("01 不要早死（4 条）");
		expect(text).toContain("15 租房与买房（2 条）");
	});

	it("formatSingleTip 返回单条全文", () => {
		const hit = { chapter: chapters[0], tip: chapters[0].tips[3], score: 0 };
		const text = formatSingleTip(hit, snapshot);
		expect(text).toContain("〔1.9〕开车不超速、不酒驾");
		expect(text).toContain("备注：");
		expect(text).toContain("blob/main/book/01-");
	});

	it("formatNoMatches 给出改写建议", () => {
		const text = formatNoMatches({ query: "区块链暴富", chapter: 15, grade: "A", limit: 8 });
		expect(text).toContain("区块链暴富");
		expect(text).toContain("overview");
	});
});

describe("chapterCounts", () => {
	it("统计总数与分级", () => {
		expect(chapterCounts(chapters)).toEqual({ total: 6, a: 3, b: 2, c: 1, disputed: 1 });
	});
});
