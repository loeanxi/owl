import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

function unknownUsage() {
	const message = fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "WorkBuddy 流中断，费用待核对: terminated",
	});
	message.diagnostics = [
		{
			type: "gateway_usage_unknown",
			timestamp: 0,
			details: { code: "upstream_stream_interrupted", billing_state: "unknown" },
		},
	];
	return message;
}

describe("controlled gateway unknown usage", () => {
	it("does not start another provider request after an unknown-billing interruption", async () => {
		const h = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		try {
			h.setResponses([unknownUsage(), fauxAssistantMessage("reserved for a new user attempt")]);
			await h.session.prompt("faux task");
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
			expect(
				h.session.messages.some(
					(message) =>
						message.role === "assistant" && message.errorMessage === "WorkBuddy 流中断，费用待核对: terminated",
				),
			).toBe(true);
		} finally {
			h.cleanup();
		}
	});
	it("does not replay an already completed action after the later unknown-usage error", async () => {
		let actions = 0;
		const h = await createHarness({
			initialActiveToolNames: ["fixture_action"],
			toolActivation: "eager",
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			tools: [
				{
					name: "fixture_action",
					label: "Fixture",
					description: "Faux action",
					parameters: Type.Object({}),
					execute: async () => {
						actions++;
						return { content: [{ type: "text", text: "faux action completed" }], details: {} };
					},
				},
			],
		});
		const action = (id: string) =>
			fauxAssistantMessage([fauxToolCall("fixture_action", {}, { id })], { stopReason: "toolUse" });
		try {
			h.setResponses([
				action("first"),
				unknownUsage(),
				action("must-not-replay"),
				fauxAssistantMessage("unexpected retry finished"),
			]);
			await h.session.prompt("perform the faux action once");
			expect(h.faux.state.callCount).toBe(2);
			expect(actions).toBe(1);
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		} finally {
			h.cleanup();
		}
	});
	it("retains ordinary transient retries", async () => {
		const h = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		try {
			h.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
				fauxAssistantMessage("recovered"),
			]);
			await h.session.prompt("faux task");
			expect(h.faux.state.callCount).toBe(2);
			expect(h.eventsOfType("auto_retry_start")).toHaveLength(1);
		} finally {
			h.cleanup();
		}
	});
});
