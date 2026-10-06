import { describe, expect, it } from "vitest";
import { capThinkingLevelForOutput } from "../src/api/simple-options.ts";

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
});
