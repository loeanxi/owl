import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession explicit provider refusals", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const markers: Partial<AssistantMessage>[] = [
		{ refusal: { source: "provider", text: "Original refusal" }, rawStopReason: "completed" },
		{ rawStopReason: "refusal" },
		{ rawStopReason: "content_filter" },
		{ rawStopReason: "incomplete.content_filter" },
	];

	it.each(markers)("ends the turn without retrying explicit provider marker %j", async (marker) => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, retryableErrorPatterns: ["fixture"] },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			{
				...fauxAssistantMessage("Original refusal", {
					stopReason: "error",
					errorMessage: "fixture server error",
				}),
				...marker,
			},
			fauxAssistantMessage("This response must remain unused"),
		]);

		await harness.session.prompt("Inspect a self-authored fixture.");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			content: [{ type: "text", text: "Original refusal" }],
			...marker,
		});
	});

	it("finishes an existing transient retry cycle when the next response is a provider refusal", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, retryableErrorPatterns: ["fixture"] } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			{
				...fauxAssistantMessage("Original refusal", {
					stopReason: "error",
					errorMessage: "fixture server error",
				}),
				refusal: { source: "provider", text: "Original refusal" },
			},
			fauxAssistantMessage("This response must remain unused"),
		]);

		await harness.session.prompt("Inspect a self-authored fixture.");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			attempt: 1,
			finalError: "fixture server error",
		});
		expect(harness.session.retryAttempt).toBe(0);
	});

	it("keeps technical provider errors retryable even if ordinary text mentions refusal", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			{
				...fauxAssistantMessage("The word refusal is test data", {
					stopReason: "error",
					errorMessage: "Provider finish_reason: network_error",
				}),
				rawStopReason: "network_error",
			},
			fauxAssistantMessage("Recovered"),
		]);

		await harness.session.prompt("Inspect a self-authored fixture.");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: true });
	});

	it.each([...markers, undefined])(
		"only uses overflow recovery when no explicit refusal marker exists: %j",
		async (marker) => {
			const harness = await createHarness({
				settings: {
					retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
					compaction: { enabled: true, keepRecentTokens: 1 },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction: {
								summary: "Fixture summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("Baseline observation"),
				{
					...fauxAssistantMessage("Original provider response", {
						stopReason: "error",
						errorMessage: "maximum context length exceeded",
					}),
					...marker,
				},
				fauxAssistantMessage("Recovered from ordinary overflow"),
			]);

			await harness.session.prompt("First fixture turn.");
			await harness.session.prompt("Second fixture turn.");

			expect(harness.faux.state.callCount).toBe(marker ? 2 : 3);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(marker ? 0 : 1);
			if (marker) {
				expect(harness.session.messages.at(-1)).toMatchObject({
					content: [{ type: "text", text: "Original provider response" }],
					...marker,
				});
			} else {
				expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
					reason: "overflow",
					willRetry: true,
				});
			}
		},
	);
});
