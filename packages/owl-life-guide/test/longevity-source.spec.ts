// longevity-source：README 6.x 证据段解析与磁盘快照。固定最小上游格式样本，
// 防止解析规则漂移导致检索结果与上游结构脱节（对应 geekan/HowToLiveLonger 真实排版）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensureLongevitySnapshot,
	fetchLongevitySnapshot,
	loadLongevitySnapshotFromDisk,
	parseLongevityReadme,
} from "../src/longevity-source.ts";

const SAMPLE_README = [
	"# 程序员延寿指南",
	"",
	"### 5. 行动",
	"",
	"* 输入",
	"  * 固体：吃白肉（-11%~-3% ACM）",
	"",
	"### 6. 证据",
	"",
	"#### 6.1. 输入",
	"",
	"##### 6.1.1. 固体",
	"",
	"* 白肉",
	"  * [JAMA子刊：食用红肉和加工肉类会增加心脏病和死亡风险！](https://zhuanlan.zhihu.com/p/268401670)",
	"    * 出处：[Associations of Processed Meat](https://jamanetwork.com/articlepdf/2759737/x.pdf)",
	"    * 八年内平均每天增加至少半份红肉摄入，全因死亡风险增加10％",
	"    * ![红肉](https://user-images.githubusercontent.com/img.png)",
	"* 钠（存有大量争议）",
	"  * [Eur Heart J：钠摄入量与预期寿命](https://example.com/sodium)",
	"  * 该（大范围）研究认为更多的钠摄入与显著更低的全因死亡率有关",
	"",
	"#### 6.2. 输出",
	"",
	"##### 6.2.1. 挥拍运动",
	"",
	"* [哪种运动性价比最高？](https://www.sohu.com/a/535581770)",
	"  * 一周三次，每次45-60分钟，挥拍运动，降低~47%全因死亡率",
	"  * 羽毛球、乒乓球、网球等都算挥拍运动",
	"",
].join("\n");

describe("parseLongevityReadme", () => {
	const entries = parseLongevityReadme(SAMPLE_README);

	it("只收 6.x 章节下的条目，跳过 5. 行动等段落", () => {
		expect(entries.some((entry) => entry.name === "输入")).toBe(false);
		expect(entries.map((entry) => entry.key)).toContain("6.1.1/白肉");
	});

	it("解析小节号、小节名、键与争议标记", () => {
		const sodium = entries.find((entry) => entry.key === "6.1.1/钠");
		expect(sodium?.section).toBe("6.1.1 固体");
		expect(sodium?.disputed).toBe(true);
		const meat = entries.find((entry) => entry.key === "6.1.1/白肉");
		expect(meat?.sectionNo).toBe("6.1.1");
		expect(meat?.disputed).toBe(false);
	});

	it("缩进 bullet 收进 links/details；图片链接与「出处：」前缀被清理", () => {
		const meat = entries.find((entry) => entry.key === "6.1.1/白肉");
		expect(meat?.links.map((link) => link.url)).toContain("https://zhuanlan.zhihu.com/p/268401670");
		expect(meat?.links.map((link) => link.url)).toContain("https://jamanetwork.com/articlepdf/2759737/x.pdf");
		expect(meat?.links.some((link) => link.url.endsWith("img.png"))).toBe(false);
		expect(meat?.details.some((detail) => detail.includes("10％"))).toBe(true);
		expect(meat?.details.some((detail) => detail.startsWith("出处"))).toBe(false);
	});

	it("顶层链接 bullet 直接作为条目名", () => {
		const racket = entries.find((entry) => entry.key === "6.2.1/哪种运动性价比最高？");
		expect(racket?.details).toContain("一周三次，每次45-60分钟，挥拍运动，降低~47%全因死亡率");
	});

	it("重复主题名用 #n 后缀保证 key 唯一", () => {
		const dup = parseLongevityReadme(["#### 6.1. 输入", "* 牛奶", "* 牛奶"].join("\n"));
		expect(dup.map((entry) => entry.key)).toEqual(["6.1/牛奶", "6.1/牛奶#2"]);
	});
});

describe("fetchLongevitySnapshot / loadLongevitySnapshotFromDisk", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("拉取成功落盘；缓存可读回；拉取失败时沿用旧原文", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dir);
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: true, status: 200, text: async () => SAMPLE_README })),
			);
			const first = await fetchLongevitySnapshot();
			expect(first.complete).toBe(true);
			expect(first.savedAt).toBeDefined();

			const fromDisk = loadLongevitySnapshotFromDisk(join(dir, "life-guide"));
			expect(fromDisk.entries.length).toBe(first.entries.length);
			expect(fromDisk.savedAt).toBe(first.savedAt);

			// 之后失败：oldRaw 兜底，不能用空数据覆盖本地。
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("network down");
				}),
			);
			const merged = await fetchLongevitySnapshot({ oldRaw: SAMPLE_README });
			expect(merged.entries.length).toBe(first.entries.length);
			expect(merged.savedAt).toBe(first.savedAt);

			// 无 oldRaw 且失败：返回空，不抛。
			const empty = await fetchLongevitySnapshot();
			expect(empty.entries).toHaveLength(0);
			expect(empty.complete).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ensureLongevitySnapshot：首次抓取，之后走缓存", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dir);
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: true, status: 200, text: async () => SAMPLE_README })),
			);
			const first = await ensureLongevitySnapshot();
			expect(first.entries.length).toBeGreaterThan(0);
			const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
			const second = await ensureLongevitySnapshot();
			expect(second.entries.length).toBe(first.entries.length);
			expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("无缓存且抓取失败：返回空快照，不抛", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dir);
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("network down");
				}),
			);
			const snapshot = await ensureLongevitySnapshot();
			expect(snapshot.entries).toHaveLength(0);
			expect(snapshot.complete).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
