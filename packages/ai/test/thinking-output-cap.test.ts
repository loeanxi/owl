import { describe, expect, it } from "vitest";
import {
	capSharedCeilingThinkingLevel,
	capThinkingLevelForOutput,
	reasoningSharesOutputCeiling,
} from "../src/api/simple-options.ts";

describe("thinking level output budget", () => {
	it("lowers high effort until the answer still has room", () => {
		expect(capThinkingLevelForOutput("high", 8_000)).toBe("low");
		expect(capThinkingLevelForOutput("high", 16_000)).toBe("medium");
		expect(capThinkingLevelForOutput("max", 32_000)).toBe("max");
	});

	it("never raises a level and turns thinking off when even minimal reasoning does not fit", () => {
		expect(capThinkingLevelForOutput("off", 8_000)).toBe("off");
		expect(capThinkingLevelForOutput("low", 32_000)).toBe("low");
		expect(capThinkingLevelForOutput("high", 512)).toBe("off");
		expect(capThinkingLevelForOutput("medium", 0)).toBe("medium");
	});

	it("keeps max when the shared ceiling can hold it and skips rejected efforts", () => {
		expect(capSharedCeilingThinkingLevel("max", 32_768)).toBe("max");
		expect(capSharedCeilingThinkingLevel("max", 16_384)).toBe("medium");
		expect(
			capSharedCeilingThinkingLevel("max", 16_384, {
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				max: "max",
			}),
		).toBe("low");
	});

	it("treats a separate thinking budget as its own ceiling", () => {
		expect(
			reasoningSharesOutputCeiling({
				api: "openai-completions",
				reasoning: true,
				compat: { thinkingFormat: "deepseek" },
			}),
		).toBe(true);
		expect(
			reasoningSharesOutputCeiling({
				api: "openai-completions",
				reasoning: true,
				compat: { supportsThinkingTokenBudget: true },
			}),
		).toBe(false);
		expect(reasoningSharesOutputCeiling({ api: "anthropic-messages", reasoning: true })).toBe(false);
	});
});
