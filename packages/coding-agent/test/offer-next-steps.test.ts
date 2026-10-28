import { describe, expect, it } from "vitest";
import { createOfferNextStepsToolDefinition, MAX_NEXT_STEPS } from "../src/extensions/offer-next-steps/tool.ts";

const tool = createOfferNextStepsToolDefinition();

async function run(
	steps: Array<{ label: string; prompt?: string }>,
): Promise<{ steps: Array<{ label: string; prompt: string }>; text: string }> {
	const result = await tool.execute("call-1", { steps } as never, undefined, undefined, undefined as never);
	const details = result.details as { steps: Array<{ label: string; prompt: string }> };
	const text = result.content.map((part) => (part as { text: string }).text).join("\n");
	return { steps: details.steps, text };
}

describe("the offer_next_steps tool", () => {
	it("normalizes the steps into label + prompt", async () => {
		const { steps, text } = await run([{ label: " 补测试 ", prompt: " 给 parser 补测试 " }, { label: "改文档" }]);
		expect(steps).toEqual([
			{ label: "补测试", prompt: "给 parser 补测试" },
			// 没给 prompt 时用 label 当兜底 —— 点芯片至少有个能发的东西。
			{ label: "改文档", prompt: "改文档" },
		]);
		expect(text).toBe("补测试 / 改文档");
	});

	it("rejects an empty list and too many steps", async () => {
		await expect(run([])).rejects.toThrow(/at least one step/);
		await expect(
			run(Array.from({ length: MAX_NEXT_STEPS + 1 }, (_, index) => ({ label: `s${index}` }))),
		).rejects.toThrow(/at most/);
	});

	it("drops steps without a label", async () => {
		await expect(run([{ label: "   " }])).rejects.toThrow(/at least one step/);
	});
});
