import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("manual continuation after a failed desktop turn", () => {
	it.each(["network connection terminated", "insufficient_quota"])(
		"keeps completed tool evidence without replaying it after %s",
		async (errorMessage) => {
			let executions = 0;
			const harness = await createHarness({
				settings: { retry: { enabled: false } },
				initialActiveToolNames: ["fixture_action"],
				tools: [
					{
						name: "fixture_action",
						label: "Fixture action",
						description: "Record one completed action",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "already saved artifact.txt" }], details: {} };
						},
					},
				],
			});
			harnesses.push(harness);
			const sessionId = harness.session.sessionId;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("fixture_action", {}, { id: "completed-action" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage }),
				(context) => {
					expect(context.messages.filter((message) => message.role === "toolResult")).toEqual([
						expect.objectContaining({
							toolCallId: "completed-action",
							isError: false,
							content: [{ type: "text", text: "already saved artifact.txt" }],
						}),
					]);
					expect(context.messages.at(-1)).toMatchObject({
						role: "user",
						content: [{ type: "text", text: "Continue remaining work from the saved result." }],
					});
					return fauxAssistantMessage("remaining work complete");
				},
			]);
			await harness.session.prompt("Save the artifact and summarize it.");
			const originalLeaf = harness.sessionManager.getLeafId();
			expect(harness.faux.state.callCount).toBe(2);
			expect(executions).toBe(1);
			await harness.session.resumeAfterPause("Continue remaining work from the saved result.");
			expect(harness.session.sessionId).toBe(sessionId);
			expect(harness.sessionManager.getBranch().some((entry) => entry.id === originalLeaf)).toBe(true);
			expect(getUserTexts(harness)).toEqual(["Save the artifact and summarize it."]);
			expect(executions).toBe(1);
			expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
			expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([
				expect.objectContaining({ customType: "owl.resume", display: false }),
			]);
		},
	);

	it("never executes a partial tool call from the failed assistant when continuing", async () => {
		let executions = 0;
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			initialActiveToolNames: ["fixture_action"],
			tools: [
				{
					name: "fixture_action",
					label: "Fixture action",
					description: "Must not run incomplete work",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "unexpected execution" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("fixture_action", {}, { id: "incomplete-action" }), {
				stopReason: "error",
				errorMessage: "network connection terminated",
			}),
			fauxAssistantMessage("Check the current artifact before trying a new operation."),
		]);
		await harness.session.prompt("Prepare an artifact.");
		await harness.session.resumeAfterPause("Continue without replaying uncertain operations.");
		expect(executions).toBe(0);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
	});

	it("keeps the same session and original prompt when the user switches models before continuing", async () => {
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "replacement" }],
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		const sessionId = harness.session.sessionId;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			(context, _options, _state, model) => {
				expect(model.id).toBe("replacement");
				expect(JSON.stringify(context.messages)).toContain("Summarize the saved investigation.");
				return fauxAssistantMessage("continued with replacement");
			},
		]);
		await harness.session.prompt("Summarize the saved investigation.");
		await harness.session.setModel(harness.getModel("replacement")!);
		await harness.session.resumeAfterPause("Continue the same task.");
		expect(harness.session.sessionId).toBe(sessionId);
		expect(harness.session.model?.id).toBe("replacement");
		expect(getUserTexts(harness)).toEqual(["Summarize the saved investigation."]);
	});

	it("does not automatically continue a refusal", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I cannot help with that request.", { refusal: { source: "provider" } }),
			fauxAssistantMessage("must not be consumed"),
		]);
		await harness.session.prompt("faux refusal fixture");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("leaves a cancelled run stopped until a new explicit user prompt starts work", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let entered = () => {};
		const providerEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				entered();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("discarded after cancellation");
			},
			fauxAssistantMessage("new explicit task complete"),
		]);
		const pending = harness.session.prompt("Start the first task.");
		await providerEntered;
		await harness.session.abort();
		await pending;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		await harness.session.prompt("Start a different task.");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isIdle).toBe(true);
		expect(getUserTexts(harness)).toEqual(["Start the first task.", "Start a different task."]);
	});
});
