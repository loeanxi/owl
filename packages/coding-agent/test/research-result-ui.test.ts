import { describe, expect, it } from "vitest";
import {
	publishedResults,
	researchResultsFromEvent,
} from "../../../apps/desktop/src/features/research/research-results.ts";
import type { ResearchResult } from "../src/core/research/types.ts";

const result: ResearchResult = {
	id: "public-synthetic-binary-result",
	createdAt: "2026-10-04T00:00:00.000Z",
	mode: "binary",
	status: "partial",
	title: "合成静态样本",
	summary: "本地静态记录，未执行目标。",
	columns: [{ key: "name", label: "名称" }],
	rows: [{ name: "public-toy.exe" }],
	sources: [{ id: "local", title: "合成输入", note: "本地文件哈希示例" }],
	findings: [{ kind: "fact", text: "观测到一条合成静态记录。", sourceIds: ["local"] }],
};

describe("research capability cards in the desktop", () => {
	it("restores dedicated executable and model cards from persisted tool results without inferring prose", () => {
		for (const toolName of ["research_publish", "research_executable", "research_model_lab"]) {
			const card = toolName === "research_model_lab" ? { ...result, mode: "model" as const } : result;
			const message = { role: "toolResult", toolName, details: { researchResult: card }, isError: false };
			expect(publishedResults([message, message])).toEqual([card]);
			expect(researchResultsFromEvent({ type: "message_end", message })).toEqual([card]);
			expect(
				researchResultsFromEvent({ type: "tool_execution_end", toolName, result: message, isError: false }),
			).toEqual([card]);
		}
		expect(publishedResults([{ role: "assistant", content: JSON.stringify(result) }])).toEqual([]);
		expect(publishedResults([{ role: "toolResult", toolName: "read", details: { researchResult: result } }])).toEqual(
			[],
		);
	});

	it("ignores failed tools and rejects invalid source references or unsafe links", () => {
		const event = {
			type: "tool_execution_end",
			toolName: "research_executable",
			result: { details: { researchResult: result } },
		};
		expect(researchResultsFromEvent({ ...event, isError: true })).toEqual([]);
		for (const card of [
			{ ...result, findings: [{ kind: "fact", text: "bad reference", sourceIds: ["missing"] }] },
			{ ...result, sources: [{ id: "local", title: "bad link", url: "file:///private.exe" }] },
			{ ...result, sources: [{ id: "local", title: "bad credentials", url: "https://key:secret@example.invalid" }] },
		])
			expect(researchResultsFromEvent({ ...event, result: { details: { researchResult: card } } })).toEqual([]);
	});
});
