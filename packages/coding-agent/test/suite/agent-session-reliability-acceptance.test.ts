import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(): Promise<Harness> {
	const harness = await createHarness({
		initialActiveToolNames: ["read", "write", "edit", "bash"],
		toolActivation: "eager",
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

function call(name: string, args: ToolCall["arguments"]) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

// Quote the executable for the real Bash tool, including Windows paths with spaces.
const nodeCommand = `'${process.execPath.replaceAll("\\", "/").replaceAll("'", "'\\''")}' verify.mjs`;

describe("agent reliability through real file and process tools", () => {
	it("completes 48 successful read-and-edit rounds and verifies the final artifact", async () => {
		const harness = await setup();
		const responses: FauxResponseStep[] = [call("write", { path: "state.txt", content: "0\n" })];
		for (let value = 1; value <= 48; value++) {
			responses.push(
				call("read", { path: "state.txt" }),
				call("edit", { path: "state.txt", edits: [{ oldText: `${value - 1}\n`, newText: `${value}\n` }] }),
			);
		}
		responses.push(
			call("write", {
				path: "verify.mjs",
				content:
					'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("state.txt", "utf8"), "48\\n");\nconsole.log("ACCEPTANCE_OK:48");\n',
			}),
			call("bash", { command: nodeCommand, timeout: 10 }),
			call("read", { path: "state.txt" }),
			fauxAssistantMessage("Verified all 48 changes."),
		);
		harness.setResponses(responses);

		await harness.session.prompt("Apply all 48 sequential changes, then run the verifier and report the result.");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.filter((message) => message.isError).map(getMessageText)).toEqual([]);
		expect(results.filter((message) => message.toolName === "edit")).toHaveLength(48);
		expect(getMessageText(results.findLast((message) => message.toolName === "bash"))).toContain("ACCEPTANCE_OK:48");
		expect(getMessageText(results.at(-1))).toBe("48\n");
		expect(readFileSync(join(harness.tempDir, "state.txt"), "utf8")).toBe("48\n");
		expect(getAssistantTexts(harness).at(-1)).toBe("Verified all 48 changes.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
	});

	it("reruns the identical failing verification command after repairing its input", async () => {
		const harness = await setup();
		harness.setResponses([
			call("write", { path: "state.txt", content: "broken\n" }),
			call("write", {
				path: "verify.mjs",
				content:
					'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("state.txt", "utf8"), "fixed\\n");\nconsole.log("ACCEPTANCE_REPAIRED");\n',
			}),
			call("bash", { command: nodeCommand, timeout: 10 }),
			call("read", { path: "state.txt" }),
			call("edit", { path: "state.txt", edits: [{ oldText: "broken\n", newText: "fixed\n" }] }),
			call("bash", { command: nodeCommand, timeout: 10 }),
			fauxAssistantMessage("The repaired file passes the same verifier."),
		]);

		await harness.session.prompt(
			"Run the verifier, repair its failed input, and rerun exactly the same verification.",
		);

		const verifications = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "bash",
		);
		expect(verifications).toHaveLength(2);
		expect(verifications.map((message) => message.isError)).toEqual([true, false]);
		expect(getMessageText(verifications[0])).toContain("AssertionError");
		expect(getMessageText(verifications[1])).toContain("ACCEPTANCE_REPAIRED");
		expect(readFileSync(join(harness.tempDir, "state.txt"), "utf8")).toBe("fixed\n");
		expect(getAssistantTexts(harness).at(-1)).toBe("The repaired file passes the same verifier.");
	});

	it("honors cancellation after 40 successful edits without writing a late provider response", async () => {
		const harness = await setup();
		let entered = () => {};
		const providerEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const blockedProvider = new Promise<void>((resolve) => {
			release = resolve;
		});
		const responses: FauxResponseStep[] = [call("write", { path: "state.txt", content: "0\n" })];
		for (let value = 1; value <= 40; value++) {
			responses.push(
				call("read", { path: "state.txt" }),
				call("edit", { path: "state.txt", edits: [{ oldText: `${value - 1}\n`, newText: `${value}\n` }] }),
			);
		}
		responses.push(async () => {
			entered();
			await blockedProvider;
			return call("write", { path: "after-abort.txt", content: "must never be written" });
		});
		responses.push(fauxAssistantMessage("must not report success after cancellation"));
		harness.setResponses(responses);

		const run = harness.session.prompt("Continue the long edit task until I cancel it.");
		try {
			expect(await Promise.race([providerEntered.then(() => true), run.then(() => false)])).toBe(true);
			const abort = harness.session.abort();
			release();
			await Promise.all([abort, run]);

			expect(readFileSync(join(harness.tempDir, "state.txt"), "utf8")).toBe("40\n");
			expect(existsSync(join(harness.tempDir, "after-abort.txt"))).toBe(false);
			expect(
				harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "write"),
			).toHaveLength(1);
			expect(getAssistantTexts(harness)).not.toContain("must not report success after cancellation");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		} finally {
			release();
			await harness.session.abort();
			await run;
		}
	});
});
