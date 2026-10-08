import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("gateway balance failures", () => {
	it.each([
		"网关内部错误: 余额不足: 预估 10 分，可用 4 分",
		"500 网关内部错误: 余额不足: 预估 10 分，可用 4 分",
		'429 {"error":{"code":"insufficient_balance","message":"insufficient balance"}}',
	])("does not retry an unchanged request: %s", async (errorMessage) => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		try {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("response reserved for the next user attempt"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.session.isStreaming).toBe(false);

			await harness.session.prompt("continue after updating the account or request limit");
			expect(harness.faux.state.callCount).toBe(2);
		} finally {
			harness.cleanup();
		}
	});
});
