import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTaskCheckExtension } from "../../src/extensions/task-check/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(failProbe = false, sessionManager?: SessionManager): Promise<Harness> {
	const harness = await createHarness({
		sessionManager,
		initialActiveToolNames: ["task_check", "probe"],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			createTaskCheckExtension(),
			(pi) => {
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Offline verification fixture",
					parameters: Type.Object({ offset: Type.Optional(Type.Number()) }),
					execute: async () => ({
						isError: failProbe,
						content: [
							{ type: "text", text: failProbe ? "Missing fixture dependency" : "Boundary checks: 8 passed" },
						],
						details: {},
					}),
				});
			},
		],
	});
	harnesses.push(harness);
	return harness;
}

function checklist(status: "pending" | "verified" | "blocked", evidence?: string, toolCallId?: string) {
	return fauxAssistantMessage(
		fauxToolCall("task_check", {
			goal: "Repair the boundary bug",
			criteria: [
				{
					criterion: "Boundary regression passes",
					status,
					...(evidence === undefined ? {} : { evidence }),
					...(toolCallId === undefined ? {} : { toolCallId }),
				},
			],
		}),
		{ stopReason: "toolUse" },
	);
}

function reminders(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "owl-task-check-reminder");
}

describe("explicit implementation acceptance", () => {
	it("does not add a model request or checklist to a greeting", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("你好，需要帮你处理什么？")]);
		await harness.session.prompt("你好");
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(reminders(harness)).toHaveLength(0);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "owl-task-check"),
		).toBe(false);
	});

	it("reminds once about explicit pending criteria and accepts concrete verification", async () => {
		const harness = await setup();
		harness.setResponses([
			checklist("pending"),
			fauxAssistantMessage("The edit is ready."),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Boundary regression passes");
				return fauxAssistantMessage(fauxToolCall("probe", {}, { id: "verified-probe" }), { stopReason: "toolUse" });
			},
			checklist("verified", "Boundary regression probe returned 8 passed.", "verified-probe"),
			fauxAssistantMessage("The change and verification are complete."),
		]);
		await harness.session.prompt("Fix and verify the boundary bug.");
		expect(reminders(harness)).toHaveLength(1);
		expect(getToolResult(harness, "task_check").isError).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
	});

	it("does not create an infinite self-check loop even if the model registers the pending list again", async () => {
		const harness = await setup();
		harness.setResponses([
			checklist("pending"),
			fauxAssistantMessage("Ready."),
			checklist("pending"),
			fauxAssistantMessage("Still pending."),
		]);
		await harness.session.prompt("Fix the boundary bug.");
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([
		{
			status: "verified" as const,
			evidence: "Inspected the delivered screenshot: all labels match the requested wording.",
		},
		{
			status: "blocked" as const,
			evidence: "The fixture dependency is missing; the test cannot run in this workspace.",
		},
	])("does not continue a $status checklist", async ({ status, evidence }) => {
		const harness = await setup();
		harness.setResponses([checklist(status, evidence), fauxAssistantMessage("Reported the actual outcome.")]);
		await harness.session.prompt("Fix the boundary bug.");
		expect(getToolResult(harness, "task_check").isError).toBe(false);
		expect(reminders(harness)).toHaveLength(0);
	});

	it.each([undefined, "已完成", "verified"])(
		"rejects completion assertions without concrete evidence: %s",
		async (evidence) => {
			const harness = await setup();
			harness.setResponses([checklist("verified", evidence), fauxAssistantMessage("Verification is missing.")]);
			await harness.session.prompt("Fix the boundary bug.");
			expect(getToolResult(harness, "task_check").isError).toBe(true);
			expect(reminders(harness)).toHaveLength(0);
		},
	);

	it("rejects a verified file the host did not write and cites the write it did see", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_check", "edit"],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				createTaskCheckExtension(),
				(pi) => {
					pi.registerTool({
						name: "edit",
						label: "Edit",
						description: "Edit a file",
						parameters: Type.Object({ path: Type.String() }),
						execute: async (_id, params: { path: string }) => ({
							content: [{ type: "text", text: `edited ${params.path}` }],
							details: {},
						}),
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "src/foo.ts" }), { stopReason: "toolUse" }),
			checklist("pending"),
			fauxAssistantMessage("Ready."),
			checklist("verified", "updated src/missing.ts and the boundary checks passed."),
			fauxAssistantMessage("That file was not written."),
		]);
		await harness.session.prompt("Fix the boundary bug in the source file.");
		expect(JSON.stringify(reminders(harness))).toContain("src/foo.ts");
		expect(getToolResult(harness, "task_check").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "task_check"))).toContain("src/missing.ts");
	});

	it("accepts verified evidence for a file this turn actually wrote", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_check", "edit"],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				createTaskCheckExtension(),
				(pi) => {
					pi.registerTool({
						name: "edit",
						label: "Edit",
						description: "Edit a file",
						parameters: Type.Object({ path: Type.String() }),
						execute: async (_id, params: { path: string }) => ({
							content: [{ type: "text", text: `edited ${params.path}` }],
							details: {},
						}),
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "src/foo.ts" }), { stopReason: "toolUse" }),
			checklist("verified", "updated src/foo.ts and the boundary checks passed."),
			fauxAssistantMessage("The write is on disk."),
		]);
		await harness.session.prompt("Fix the boundary bug in the source file.");
		expect(getToolResult(harness, "task_check").isError).toBe(false);
		expect(reminders(harness)).toHaveLength(0);
	});

	it.each([false, true])("rejects a missing or failed proof call (failed=%s)", async (failed) => {
		const harness = await setup(true);
		harness.setResponses([
			...(failed
				? [fauxAssistantMessage(fauxToolCall("probe", {}, { id: "bad-proof" }), { stopReason: "toolUse" })]
				: []),
			checklist("verified", "The regression probe passed all boundary checks.", "bad-proof"),
			fauxAssistantMessage("Cannot verify this result."),
		]);
		await harness.session.prompt("Fix the boundary bug.");
		expect(getToolResult(harness, "task_check").isError).toBe(true);
	});

	it("inspects a previous unresolved checklist without restarting it on a new greeting", async () => {
		const harness = await setup();
		harness.setResponses([
			checklist("pending"),
			fauxAssistantMessage("Ready."),
			fauxAssistantMessage("Blocked for now."),
		]);
		await harness.session.prompt("Fix the boundary bug.");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("task_check", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("你好。"),
		]);
		await harness.session.prompt("你好");
		expect(getToolResult(harness, "task_check").details).toMatchObject({ active: false });
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores a saved pending checklist for inspection without resuming work", async () => {
		const original = await setup();
		original.setResponses([
			checklist("pending"),
			fauxAssistantMessage("Ready."),
			fauxAssistantMessage("Still unverified."),
		]);
		await original.session.prompt("Fix the boundary bug.");
		const manager = SessionManager.inMemory(original.tempDir, undefined, [
			original.sessionManager.getHeader()!,
			...original.sessionManager.getEntries(),
		]);
		const resumed = await setup(false, manager);
		resumed.setResponses([
			fauxAssistantMessage(fauxToolCall("task_check", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("The saved check is pending."),
		]);
		await resumed.session.prompt("Only show the saved status.");
		expect(getToolResult(resumed, "task_check").details).toMatchObject({
			active: false,
			state: { criteria: [{ status: "pending" }] },
		});
		expect(resumed.eventsOfType("agent_start")).toHaveLength(1);
		expect(reminders(resumed)).toHaveLength(1);
	});

	it("uses the selected branch checklist without inheriting the later completion", async () => {
		const harness = await setup();
		harness.setResponses([
			checklist("pending"),
			fauxAssistantMessage("Ready."),
			fauxAssistantMessage("Still unverified."),
		]);
		await harness.session.prompt("Fix the boundary bug.");
		const pendingLeaf = harness.sessionManager.getLeafId()!;
		harness.setResponses([
			checklist("verified", "The screenshot labels were checked against the user's reference."),
			fauxAssistantMessage("Verified."),
		]);
		await harness.session.prompt("Verify the result.");
		await harness.session.navigateTree(pendingLeaf, { summarize: false });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("task_check", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("This branch still has a pending check."),
		]);
		await harness.session.prompt("Only inspect this branch.");
		expect(getToolResult(harness, "task_check").details).toMatchObject({
			active: false,
			state: { criteria: [{ status: "pending" }] },
		});
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["error", "aborted"] as const)("does not continue after %s", async (stopReason) => {
		const harness = await setup();
		harness.setResponses([checklist("pending"), fauxAssistantMessage("Interrupted", { stopReason })]);
		await harness.session.prompt("Fix the boundary bug.");
		expect(reminders(harness)).toHaveLength(0);
	});

	it("delivered steering revokes the old checklist continuation", async () => {
		const harness = await setup();
		harness.setResponses([
			checklist("pending"),
			async () => {
				await harness.session.steer("Stop work; only explain what is missing.");
				return fauxAssistantMessage("Pausing.");
			},
			fauxAssistantMessage("The regression verification is missing."),
		]);
		await harness.session.prompt("Fix the boundary bug.");
		expect(reminders(harness)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});

describe("bounded error recovery feedback", () => {
	it("adds one hint to the third identical error, without adding provider calls", async () => {
		const harness = await setup(true);
		harness.setResponses([
			...Array.from({ length: 4 }, () =>
				fauxAssistantMessage(fauxToolCall("probe", { offset: 0 }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("The dependency is missing."),
		]);
		await harness.session.prompt("Run the fixture check.");
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "probe",
		);
		expect(results.map((message) => getMessageText(message).includes("[task-check recovery]"))).toEqual([
			false,
			false,
			true,
			false,
		]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it.each([true, false])(
		"does not confuse different parameters or successful repeated reads with repeated errors (failed=%s)",
		async (failed) => {
			const harness = await setup(failed);
			harness.setResponses([
				...Array.from({ length: 4 }, (_, index) =>
					fauxAssistantMessage(fauxToolCall("probe", { offset: failed ? index : 0 }), { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("Observed each result."),
			]);
			await harness.session.prompt("Inspect the fixture pages.");
			expect(
				harness.session.messages
					.filter((message) => message.role === "toolResult")
					.some((message) => getMessageText(message).includes("[task-check recovery]")),
			).toBe(false);
		},
	);
});
