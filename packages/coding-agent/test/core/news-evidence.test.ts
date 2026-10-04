import { describe, expect, it } from "vitest";
import { analyzeMaterial } from "../../src/core/news/editorial.ts";
import { DEFAULT_NEWS_CONFIGURATION } from "../../src/core/news/industry.ts";
import type { NewsModelCall, NewsModelResponse, NewsSource } from "../../src/core/news/types.ts";

const source: NewsSource = {
	id: "evidence-fixture",
	name: "示例官方",
	kind: "rss",
	config: {},
	tier: "T1",
	participation: "editorial",
	enabled: false,
	intervalMinutes: 30,
	siteFulltext: false,
	syndicateFulltext: false,
	lastCollectedAt: null,
	nextCollectedAt: null,
	lastError: null,
	createdAt: "2026-10-04T00:00:00.000Z",
	updatedAt: "2026-10-04T00:00:00.000Z",
};
const first = "示例公司发布模型指南。";
const second = "本指南介绍模型选型和部署。";

async function analyze(body: string, evidence: string, conditions: string[] = []) {
	const call = async (request: NewsModelCall): Promise<NewsModelResponse> => {
		let output: unknown;
		switch (request.capability) {
			case "prefilter":
				output = { label: "PASS", reason: "模型使用指南" };
				break;
			case "score":
				output = { attentionScore: request.purpose === "score-2" ? 72 : 71 };
				break;
			case "structure":
				output = {
					scope: "single",
					category: "tip",
					tags: ["教程/实践"],
					subjects: [],
					fact: {
						title: "示例公司发布模型指南",
						subject: "示例公司",
						action: "发布",
						object: "模型指南",
						occurredAt: null,
						evidence,
						conditions: conditions.map((quote) => ({ quote })),
					},
				};
				break;
			case "understand":
			case "summarize":
				output = { titleZh: "示例公司发布模型指南", summaryZh: first };
				break;
			default:
				throw new Error(`Unexpected fixture capability: ${request.capability}`);
		}
		return {
			text: JSON.stringify(output),
			provider: "fixture",
			model: "fixture",
			usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: null },
		};
	};
	return analyzeMaterial(
		{ title: "示例公司发布模型指南", url: "https://example.com/guide", body },
		source,
		{ ...structuredClone(DEFAULT_NEWS_CONFIGURATION), modelCallsEnabled: true },
		call,
	);
}

describe("news Chinese evidence layout equivalence", () => {
	it.each(["\n\n", "\r\n", "\t", " ", "\u3000"])(
		"retains consecutive Chinese paragraphs when the model omits layout whitespace: %j",
		async (separator) => {
			const result = await analyze(`${first}${separator}${second}`, `${first}${second}`);
			expect(result.fact?.evidence).toEqual([`${first}${second}`]);
			expect(result.scores).toEqual([71, 72]);
			expect(result.score).toBe(71);
			expect(result.selectionCandidate).toBe(true);
		},
	);

	it("allows whitespace introduced by quote formatting at a Chinese boundary", async () => {
		const result = await analyze(`${first}${second}`, `${first}\n\n${second}`);
		expect(result.fact?.evidence).toEqual([`${first} ${second}`]);
	});

	it("keeps only correctly grounded conditions while rejecting a model typo and a dropped UI label", async () => {
		const correct = "多智能体功能目前处于测试阶段。";
		const typo = "在 API 中，你可以对语话中途调整推理强度，而不会使缓存失效。";
		const removedUi = "缓存输入 Token 的费用最多降低 95%，具体取决于模型。";
		const body =
			first +
			"\n\n" +
			second +
			"\n" +
			correct +
			"\n在 API 中，你可以在对话中途调整推理强度，而不会使缓存失效。" +
			"\n缓存输入 Token 的费用最多降低 95%\u2060\n（在新窗口中打开）\n，具体取决于模型。";
		const result = await analyze(body, `${first}${second}`, [correct, typo, removedUi]);
		expect(result.fact?.evidence).toEqual([`${first}${second}`, correct]);
	});

	it.each([
		{
			label: "English word separator",
			body: "Models can not run unattended.",
			evidence: "Models cannot run unattended.",
		},
		{
			label: "English product name separator",
			body: "The Alpha Beta model is available.",
			evidence: "The AlphaBeta model is available.",
		},
		{ label: "digit separator", body: "模型包含 1 0 项能力。", evidence: "模型包含 10 项能力。" },
		{ label: "decimal separator", body: "输入费用为 0 . 10 美元。", evidence: "输入费用为 0.10 美元。" },
		{ label: "changed Chinese character", body: `${first}${second}`, evidence: `示例公司发布模型指难。${second}` },
		{ label: "omitted source words", body: `${first}限制仍然有效。${second}`, evidence: `${first}${second}` },
	])("does not normalize $label into an invented continuous quotation", async ({ body, evidence }) => {
		const result = await analyze(body, evidence);
		expect(result.fact).toBeNull();
		expect(result.selectionCandidate).toBe(false);
	});
});
