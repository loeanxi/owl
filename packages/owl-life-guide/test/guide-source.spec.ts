// guide-source：markdown 解析与磁盘快照合并。固定一份最小上游格式样本，
// 防止解析规则漂移导致检索工具与桌面面板读到不同的结构。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchGuideSnapshot,
	GUIDE_CHAPTERS,
	loadGuideSnapshotFromDisk,
	parseGuideChapter,
} from "../src/guide-source.ts";

const meta = GUIDE_CHAPTERS[0];

const SAMPLE_RAW = [
	"[← 回总目录](../README.md)",
	"",
	"# 1. 不要早死",
	"",
	"这一节讲三件事：车祸、火灾、中毒。",
	"",
	"### 1. 系安全带，前排后排都系",
	"<!-- 成本标签: 钱=0 时间=少 毅力=否 收益=大 口径=死亡率 -->",
	"- 成本：不花钱。每次上车多花 2 秒。",
	"- 说人话：坐前排系上安全带，出车祸时被撞死的概率大约降一半。",
	"- 收益：NHTSA 估计致命伤风险下降 45%。",
	"- 证据等级：A",
	"- 来源：NHTSA (2024). <https://crashstats.nhtsa.dot.gov/813573>",
	"- 备注：后排也要系。第二排被撞死的人有 60% 没系带。",
	"",
	"### 2. 骑摩托车戴头盔并扣好",
	"<!-- 成本标签: 钱=少 时间=少 毅力=否 收益=大 口径=死亡率 -->",
	"- 说人话：戴头盔并且扣好，死亡概率低约四成。",
	"  折行内容要并进当前字段。",
	"- 证据等级：A",
	"- 备注：争议：电动自行车没有直接研究，是照着摩托车推过来的。",
	"",
].join("\n");

describe("parseGuideChapter", () => {
	const chapter = parseGuideChapter(meta, SAMPLE_RAW);

	it("解析章号、标题、导语", () => {
		expect(chapter.no).toBe(1);
		expect(chapter.title).toBe("不要早死");
		expect(chapter.intro).toContain("车祸、火灾、中毒");
		// H1 前的回链不算导语。
		expect(chapter.intro).not.toContain("回总目录");
	});

	it("解析条目字段与成本标签", () => {
		expect(chapter.tips).toHaveLength(2);
		const tip1 = chapter.tips[0];
		expect(tip1.key).toBe("1.1");
		expect(tip1.title).toBe("系安全带，前排后排都系");
		expect(tip1.tags).toContainEqual({ k: "收益", v: "大" });
		expect(tip1.cost).toBe("不花钱。每次上车多花 2 秒。");
		expect(tip1.plain).toContain("降一半");
		expect(tip1.grade).toBe("A");
		expect(tip1.sources).toContain("crashstats");
		expect(tip1.disputed).toBe(false);
	});

	it("字段折行并进当前字段；备注以争议开头时标记 disputed", () => {
		const tip2 = chapter.tips[1];
		expect(tip2.plain).toBe("戴头盔并且扣好，死亡概率低约四成。\n折行内容要并进当前字段。");
		expect(tip2.disputed).toBe(true);
	});

	it("证据等级缺失/不认识时回退 C", () => {
		const loose = parseGuideChapter(meta, SAMPLE_RAW.replace("- 证据等级：A", ""));
		expect(loose.tips[0].grade).toBe("C");
	});
});

const rawFor = (chapterMeta: { file: string }): string =>
	SAMPLE_RAW.replace("# 1. 不要早死", `# 1. ${chapterMeta.file}`);

describe("loadGuideSnapshotFromDisk", () => {
	it("读磁盘缓存；缺章时 complete=false 且无 savedAt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		try {
			await writeFile(join(dir, `${GUIDE_CHAPTERS[0].file}.md`), rawFor(GUIDE_CHAPTERS[0]), "utf-8");
			await writeFile(join(dir, `${GUIDE_CHAPTERS[1].file}.md`), rawFor(GUIDE_CHAPTERS[1]), "utf-8");
			const snapshot = loadGuideSnapshotFromDisk(dir);
			expect(snapshot.chapters).toHaveLength(2);
			expect(snapshot.complete).toBe(false);
			expect(snapshot.savedAt).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("meta.json 带 savedAt 且章节齐全时才回传 savedAt；坏 meta 不影响章节", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		try {
			for (const chapterMeta of GUIDE_CHAPTERS) {
				await writeFile(join(dir, `${chapterMeta.file}.md`), rawFor(chapterMeta), "utf-8");
			}
			await writeFile(join(dir, "meta.json"), "{not json", "utf-8");
			const broken = loadGuideSnapshotFromDisk(dir);
			expect(broken.chapters).toHaveLength(GUIDE_CHAPTERS.length);
			expect(broken.savedAt).toBeUndefined();

			await writeFile(join(dir, "meta.json"), JSON.stringify({ savedAt: "2026-10-06" }), "utf-8");
			const good = loadGuideSnapshotFromDisk(dir);
			expect(good.savedAt).toBe("2026-10-06");
			expect(good.complete).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("fetchGuideSnapshot", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	const stubFetchOk = (): void => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const file = decodeURIComponent(String(url).split("/").pop() ?? "").replace(/\.md$/, "");
				const chapterMeta = GUIDE_CHAPTERS.find((c) => c.file === file);
				if (!chapterMeta) throw new Error(`unexpected url ${url}`);
				return { ok: true, status: 200, text: async () => rawFor(chapterMeta) };
			}),
		);
	};

	it("全量抓取落盘；单章失败时沿用旧原文，不让本地内容变少", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dir);
		try {
			stubFetchOk();
			const first = await fetchGuideSnapshot();
			expect(first.chapters).toHaveLength(GUIDE_CHAPTERS.length);
			expect(first.complete).toBe(true);
			expect(first.savedAt).toBeDefined();

			// 之后全部失败：oldRaw 兜底。
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("network down");
				}),
			);
			const oldRaw = new Map(first.chapters.map((c) => [c.file, c.raw]));
			const merged = await fetchGuideSnapshot({ oldRaw });
			expect(merged.chapters).toHaveLength(GUIDE_CHAPTERS.length);
			expect(merged.chapters[0].raw).toBe(first.chapters[0].raw);

			// 无 oldRaw 且失败：返回空，不抛。
			const empty = await fetchGuideSnapshot();
			expect(empty.chapters).toHaveLength(0);
			expect(empty.complete).toBe(false);

			// 抓取结果落了盘：直读磁盘能拿回同一份。
			const fromDisk = loadGuideSnapshotFromDisk(join(dir, "life-guide"));
			expect(fromDisk.chapters).toHaveLength(GUIDE_CHAPTERS.length);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("磁盘缓存目录不存在时也能创建", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "owl-life-guide-test-")), "nested", "life-guide");
		vi.stubEnv("OWL_CODING_AGENT_DIR", dir);
		try {
			stubFetchOk();
			await fetchGuideSnapshot();
			expect(loadGuideSnapshotFromDisk(join(dir, "life-guide")).chapters.length).toBeGreaterThan(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("外部 abort 透传到 fetch", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-life-guide-test-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dir);
		try {
			const seen: AbortSignal[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string | URL, init?: { signal?: AbortSignal }) => {
					if (init?.signal) seen.push(init.signal);
					return { ok: true, status: 200, text: async () => rawFor(GUIDE_CHAPTERS[0]) };
				}),
			);
			const controller = new AbortController();
			controller.abort();
			await fetchGuideSnapshot({ signal: controller.signal });
			expect(seen.length).toBe(GUIDE_CHAPTERS.length);
			expect(seen.every((s) => s.aborted)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
