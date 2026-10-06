import { describe, expect, it } from "vitest";
import { streamingBehaviorForPrompt } from "../src/modes/desktop/prompt-delivery.ts";

describe("streamingBehaviorForPrompt", () => {
	it("starts a normal turn while the session is idle", () => {
		expect(streamingBehaviorForPrompt(false)).toBeUndefined();
		expect(streamingBehaviorForPrompt(false, "followUp")).toBeUndefined();
	});

	it("queues a follow-up when the user appends during a running turn", () => {
		expect(streamingBehaviorForPrompt(true)).toBe("followUp");
		expect(streamingBehaviorForPrompt(true, "steer")).toBe("steer");
	});
});
