import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskCheckExtension } from "../../src/extensions/task-check/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function thinkingOnlyLength(thinking = "Continue analyzing the source without producing an action.") {
	const message = fauxAssistantMessage(fauxThinking(thinking), {
		stopReason: "length",
	});
	message.usage = { ...message.usage, output: 18432, totalTokens: 18432 };
	return message;
}

async function setup(options: { compactionEnabled?: boolean; agentMaxTurns?: number; guard?: boolean } = {}) {
	let reads = 0;
	let writes = 0;
	const recoveryContexts: string[][] = [];
	const harness = await createHarness({
		models: [{ id: "faux-1", maxTokens: 16384, contextWindow: 196608, reasoning: true }],
		settings: {
			retry: { enabled: false },
			compaction: { enabled: options.compactionEnabled ?? false },
			agentMaxTurns: options.agentMaxTurns,
		},
		initialActiveToolNames: ["read", "write"],
		extensionFactories: [
			...(options.guard ? [createTaskCheckExtension()] : []),
			(pi) => {
				pi.on("context", async (event) => {
					recoveryContexts.push(
						event.messages
							.filter(
								(message) => message.role === "custom" && message.customType === "owl-empty-length-recovery",
							)
							.map(getMessageText),
					);
				});
				pi.registerTool({
					name: "read",
					label: "Read",
					description: "Offline source read",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => {
						reads++;
						return { content: [{ type: "text", text: "Seed fixture implementation" }], details: {} };
					},
				});
				pi.registerTool({
					name: "write",
					label: "Write",
					description: "Offline source write",
					parameters: Type.Object({ path: Type.String(), content: Type.String() }),
					execute: async () => {
						writes++;
						return { content: [{ type: "text", text: "Wrote the local implementation." }], details: {} };
					},
				});
			},
		],
	});
	harnesses.push(harness);
	return { harness, reads: () => reads, writes: () => writes, recoveryContexts };
}

describe("thinking-only output truncation", () => {
	it.each([false, true])(
		"recovers once without replaying completed tools (compactionEnabled=%s)",
		async (compactionEnabled) => {
			const fixture = await setup({ compactionEnabled });
			fixture.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: "src/process.py" }), { stopReason: "toolUse" }),
				thinkingOnlyLength(),
				fauxAssistantMessage(fauxToolCall("write", { path: "src/process.py", content: "Fixed implementation" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The implementation and checks are complete."),
			]);
			await fixture.harness.session.prompt("Repair the local data processor.");
			expect(fixture.reads()).toBe(1);
			expect(fixture.writes()).toBe(1);
			expect(fixture.harness.getPendingResponseCount()).toBe(0);
			expect(fixture.harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(fixture.harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
			expect(fixture.harness.eventsOfType("compaction_start")).toHaveLength(0);
			expect(
				fixture.harness.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.stopReason === "length",
					),
			).toHaveLength(1);
		},
	);

	it("keeps recovering across consecutive thinking-only truncations and later tool progress", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "src/process.py" }), { stopReason: "toolUse" }),
			thinkingOnlyLength(),
			thinkingOnlyLength(),
			fauxAssistantMessage(fauxToolCall("write", { path: "src/process.py", content: "Fixed implementation" }), {
				stopReason: "toolUse",
			}),
			thinkingOnlyLength(),
			fauxAssistantMessage("The implementation is complete."),
		]);
		await fixture.harness.session.prompt("Repair the local data processor.");
		expect(fixture.harness.faux.state.callCount).toBe(6);
		expect(fixture.harness.getPendingResponseCount()).toBe(0);
		expect(fixture.reads()).toBe(1);
		expect(fixture.writes()).toBe(1);
		expect(fixture.harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
		expect(
			fixture.harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom_message" && entry.display && entry.customType === "owl-empty-length-stop",
				),
		).toBe(false);
		expect(fixture.recoveryContexts.every((messages) => messages.length <= 1)).toBe(true);
	});

	it("carries only the bounded latest thinking checkpoint while preserving raw history", async () => {
		const fixture = await setup();
		const latestThinking = `DISCARDED_CHECKPOINT_HEAD${"x".repeat(15000)}LATEST_CHECKPOINT_TAIL`;
		fixture.harness.setResponses([
			thinkingOnlyLength("OLDER_CHECKPOINT_TAIL"),
			thinkingOnlyLength(latestThinking),
			fauxAssistantMessage(fauxToolCall("write", { path: "source", content: "Finished once" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Completed."),
		]);
		await fixture.harness.session.prompt("Complete the local source change.");
		expect(fixture.writes()).toBe(1);
		expect(fixture.harness.getPendingResponseCount()).toBe(0);
		expect(fixture.recoveryContexts).toHaveLength(4);
		expect(fixture.recoveryContexts.every((messages) => messages.length <= 1)).toBe(true);
		const checkpoint = fixture.recoveryContexts[2][0];
		expect(checkpoint).toContain(latestThinking.slice(-12000));
		expect(checkpoint).toContain("LATEST_CHECKPOINT_TAIL");
		expect(checkpoint).not.toContain("DISCARDED_CHECKPOINT_HEAD");
		expect(checkpoint).not.toContain("OLDER_CHECKPOINT_TAIL");
		expect(checkpoint.length).toBeLessThan(14000);
		expect(
			fixture.harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "owl-empty-length-recovery",
			),
		).toHaveLength(1);
		const rawLengthEntries = fixture.harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length",
			);
		expect(rawLengthEntries).toHaveLength(2);
		expect(JSON.stringify(rawLengthEntries)).toContain("DISCARDED_CHECKPOINT_HEAD");
	});

	it("bounds the encoded checkpoint even when its draft needs extensive JSON escaping", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			thinkingOnlyLength(`${'"\n'.repeat(10000)}LATEST_ESCAPED_TAIL`),
			fauxAssistantMessage("Completed."),
		]);
		await fixture.harness.session.prompt("Complete the local source change.");
		const checkpoint = fixture.recoveryContexts[1][0];
		expect(checkpoint.length).toBeLessThan(14000);
		const encodedDraft = checkpoint.split("\n").at(-1)!;
		expect(JSON.parse(encodedDraft)).toMatch(/LATEST_ESCAPED_TAIL$/);
	});

	it("never recovers past a user abort", async () => {
		const fixture = await setup();
		fixture.harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "length"
			)
				void fixture.harness.session.abort();
		});
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "source" }), { stopReason: "toolUse" }),
			thinkingOnlyLength(),
			fauxAssistantMessage("Unused"),
		]);
		await fixture.harness.session.prompt("Inspect the source.");
		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
		expect(fixture.harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		expect(
			fixture.harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "owl-empty-length-recovery"),
		).toBe(false);
	});

	it("does not bypass an exhausted model-turn budget", async () => {
		const fixture = await setup({ guard: true, agentMaxTurns: 2 });
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "source" }), { stopReason: "toolUse" }),
			thinkingOnlyLength(),
			fauxAssistantMessage("Unused"),
		]);
		await fixture.harness.session.prompt("Inspect the source.");
		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
		expect(fixture.harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		expect(
			fixture.harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "owl-empty-length-recovery"),
		).toBe(false);
	});

	it("recovers independent real user requests without imposing a one-recovery allowance", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			thinkingOnlyLength(),
			thinkingOnlyLength(),
			fauxAssistantMessage("First task done."),
		]);
		await fixture.harness.session.prompt("Inspect the first task.");
		fixture.harness.setResponses([
			thinkingOnlyLength(),
			fauxAssistantMessage("The new request has an actionable answer."),
		]);
		await fixture.harness.session.prompt("Now inspect the second task.");
		expect(fixture.harness.faux.state.callCount).toBe(5);
		expect(fixture.harness.getPendingResponseCount()).toBe(0);
		expect(fixture.harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", aborted: false },
			{ type: "agent_settled", aborted: false },
		]);
	});

	it("prioritizes a real user input queued at agent_end instead of retrying the superseded task", async () => {
		const fixture = await setup();
		let queued = false;
		fixture.harness.session.subscribe((event) => {
			if (event.type === "agent_end" && !queued) {
				queued = true;
				fixture.harness.session.agent.followUp({
					role: "user",
					content: "Stop that task; answer this new question.",
					timestamp: Date.now(),
				});
			}
		});
		fixture.harness.setResponses([thinkingOnlyLength(), fauxAssistantMessage("Answer to the new question.")]);
		await fixture.harness.session.prompt("Analyze the original task.");
		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(fixture.harness.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(
			fixture.harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "owl-empty-length-recovery"),
		).toBe(false);
	});

	it("keeps tool-call truncation on the existing fail-before-execute path", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "source", content: "Incomplete parsed arguments" }), {
				stopReason: "length",
			}),
			fauxAssistantMessage(fauxToolCall("write", { path: "source", content: "Complete arguments" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The local change completed."),
		]);
		await fixture.harness.session.prompt("Write the source file.");
		expect(fixture.writes()).toBe(1);
		expect(fixture.harness.faux.state.callCount).toBe(3);
		expect(
			fixture.harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "owl-empty-length-recovery"),
		).toBe(false);
	});
});
