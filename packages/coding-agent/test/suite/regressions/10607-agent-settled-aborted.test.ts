import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Regression #10607: a successful last assistant message does not imply a completed run.
describe("agent_settled reports whether the actual run was aborted", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("reports false to extensions, subscribers and JSON consumers after normal completion", async () => {
		const extensionEvents: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		const settled = harness.eventsOfType("agent_settled");
		expect(settled).toEqual([{ type: "agent_settled", aborted: false }]);
		expect(extensionEvents).toEqual(settled);
		expect(settled.map(toJsonEvent)).toEqual(settled);
	});

	it("reports an abort after a successful assistant reply and clears it for the next run", async () => {
		const entered = deferred();
		const release = deferred();
		const extensionEvents: unknown[] = [];
		let first = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						if (!first) return;
						first = false;
						entered.resolve();
						await release.promise;
					});
					pi.on("agent_settled", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("next reply")]);
		const run = harness.session.prompt("first run");
		await entered.promise;
		expect(harness.session.messages.findLast((message) => message.role === "assistant")?.stopReason).toBe("stop");
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([run, abort]);
		await harness.session.prompt("next run");
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", aborted: true },
			{ type: "agent_settled", aborted: false },
		]);
		expect(extensionEvents).toEqual(harness.eventsOfType("agent_settled"));
	});

	it("reports an abort while a tool is running and does not deliver a successful continuation", async () => {
		const entered = deferred();
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for cancellation",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				entered.resolve();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("Operation aborted");
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const run = harness.session.prompt("start");
		await entered.promise;
		await Promise.all([harness.session.abort(), run]);
		expect(harness.session.messages).not.toContainEqual(
			expect.objectContaining({ content: [{ type: "text", text: "must not run" }] }),
		);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
	});

	it("reports an abort requested while thinking is streaming", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let abort: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta" && !abort) {
				abort = harness.session.abort();
			}
		});
		harness.setResponses([fauxAssistantMessage(fauxThinking("still thinking ".repeat(200)))]);
		await harness.session.prompt("start");
		expect(abort).toBeDefined();
		await abort;
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
	});
});
