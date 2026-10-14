// 扩展契约：入口工厂在 mock ExtensionAPI 上注册出合法的 life_guide_search，
// 且 execute 能对（stub 的）抓取与缓存跑通四种形态：概览 / 检索 / key 全文 / 抓取失败。
// @owl/owl-coding-agent 在入口里是 type-only import，运行时无需 stub。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE_CHAPTERS } from "../src/guide-source.ts";
import registerExtension from "../src/index.ts";

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		id: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: (partial: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>;
}

function register(): CapturedTool {
	let captured: CapturedTool | undefined;
	registerExtension({
		registerTool: (def: CapturedTool) => {
			captured = def;
		},
	} as never);
	if (!captured) throw new Error("extension did not register a tool");
	return captured;
}

const SAMPLE = (chapterMeta: { no: number; file: string; title: string }): string =>
	[
		`[← 回总目录](../README.md)`,
		``,
		`# ${chapterMeta.no}. ${chapterMeta.title}`,
		``,
		`### 1. 系安全带，前排后排都系`,
		`<!-- 成本标签: 钱=0 时间=少 毅力=否 收益=大 口径=死亡率 -->`,
		`- 说人话：坐前排系上安全带，出车祸时被撞死的概率大约降一半。`,
		`- 证据等级：A`,
		`- 备注：后排也要系。`,
		``,
		`### 2. 骑摩托车、电动自行车戴头盔并扣好`,
		`<!-- 成本标签: 钱=少 收益=大 -->`,
		`- 说人话：戴头盔死亡概率低约四成。`,
		`- 证据等级：B`,
		``,
	].join("\n");

let dataDir: string;

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const LONGEVITY_SAMPLE = [
	"# 程序员延寿指南",
	"",
	"### 6. 证据",
	"",
	"#### 6.1. 输入",
	"",
	"##### 6.1.2. 液体",
	"",
	"* 牛奶",
	"  * [《柳叶刀》调研21个国家13万人](https://example.com/milk)",
	"  * 全因死亡风险下降了17%",
	"",
	"#### 6.2. 输出",
	"",
	"##### 6.2.1. 挥拍运动",
	"",
	"* [哪种运动性价比最高？](https://example.com/racket)",
	"  * 一周三次，每次45-60分钟，降低~47%全因死亡率",
	"",
].join("\n");

async function stubUpstream(): Promise<void> {
	dataDir = await mkdtemp(join(tmpdir(), "owl-life-guide-ext-"));
	vi.stubEnv("OWL_CODING_AGENT_DIR", dataDir);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL) => {
			if (String(url).includes("HowToLiveLonger")) {
				return { ok: true, status: 200, text: async () => LONGEVITY_SAMPLE };
			}
			const file = decodeURIComponent(String(url).split("/").pop() ?? "").replace(/\.md$/, "");
			const meta = GUIDE_CHAPTERS.find((c) => c.file === file);
			if (!meta) throw new Error(`unexpected url ${url}`);
			return { ok: true, status: 200, text: async () => SAMPLE(meta) };
		}),
	);
}

describe("life_guide_search 扩展", () => {
	it("注册工具并声明书内检索契约", () => {
		const tool = register();
		expect(tool.name).toBe("life_guide_search");
		expect(tool.label).toBe("人生指南检索");
		expect(tool.description).toContain("高性价比人生指南");
		expect(tool.parameters).toBeTruthy();
	});

	it("execute：首次调用走抓取，之后走缓存；概览/检索/key 三种形态", async () => {
		await stubUpstream();
		const tool = register();

		// 概览（无参数）：带进度回调和快照日期。
		const updates: string[] = [];
		const overview = await tool.execute("t1", {}, undefined, (partial) => {
			updates.push(partial.content[0]?.text ?? "");
		});
		expect(updates.some((u) => u.includes("34/34"))).toBe(true);
		expect(overview.content[0].text).toContain("全书概览");
		expect(overview.content[0].text).toContain("01 不要早死（2 条）");

		// 检索：命中且格式化。
		const search = await tool.execute("t2", { query: "安全带", limit: 3 });
		expect(search.content[0].text).toContain("〔1.1〕");
		expect(search.content[0].text).toContain("证据等级 A");

		// key 取全文。
		const single = await tool.execute("t3", { key: "1.2" });
		expect(single.content[0].text).toContain("〔1.2〕骑摩托车、电动自行车戴头盔并扣好");
		expect(single.content[0].text).toContain("blob/main/book/");

		// 抓取已发生一次；再次调用不再触发 fetch（走磁盘缓存）。
		const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
		await tool.execute("t4", { query: "头盔" });
		expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
	});

	it("execute：无缓存且抓取失败 → isError，提示网络问题", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "owl-life-guide-ext-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dataDir);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const tool = register();
		const result = await tool.execute("t1", { query: "安全带" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("拉取失败");
	});

	it("execute：key 不存在 → isError 并提示 key 格式", async () => {
		await stubUpstream();
		const tool = register();
		const result = await tool.execute("t1", { key: "99.9" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("99.9");
	});
});

describe("life_guide_search 扩展 — longevity 源", () => {
	it("source=longevity：概览/检索/key 三种形态，与 guide 各自缓存", async () => {
		await stubUpstream();
		const tool = register();

		const updates: string[] = [];
		const overview = await tool.execute("t1", { source: "longevity" }, undefined, (partial) => {
			updates.push(partial.content[0]?.text ?? "");
		});
		expect(updates.some((u) => u.includes("程序员延寿指南"))).toBe(true);
		expect(overview.content[0].text).toContain("全书概览");
		expect(overview.content[0].text).toContain("6.1.2 液体（1 条）");

		const search = await tool.execute("t2", { source: "longevity", query: "牛奶" });
		expect(search.content[0].text).toContain("〔6.1.2/牛奶〕");
		expect(search.content[0].text).toContain("全因死亡风险下降了17%");

		const single = await tool.execute("t3", { source: "longevity", key: "6.1.2/牛奶" });
		expect(single.content[0].text).toContain("〔6.1.2/牛奶〕");
		expect(single.content[0].text).toContain("github.com/geekan/HowToLiveLonger");

		// 缓存已落盘：再次调用不再触发 fetch。
		const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
		await tool.execute("t4", { source: "longevity", query: "牛奶" });
		expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
	});

	it("source=longevity：key 不存在 → isError 并给示例格式", async () => {
		await stubUpstream();
		const tool = register();
		const result = await tool.execute("t1", { source: "longevity", key: "9.9/不存在" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("9.9/不存在");
		expect(result.content[0].text).toContain("6.1.2/牛奶");
	});

	it("source=longevity：无缓存且抓取失败 → isError，提示网络问题", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "owl-life-guide-ext-"));
		vi.stubEnv("OWL_CODING_AGENT_DIR", dataDir);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const tool = register();
		const result = await tool.execute("t1", { source: "longevity", query: "牛奶" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("拉取失败");
	});
});
