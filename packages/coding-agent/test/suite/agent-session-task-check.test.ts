import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTaskCheckExtension } from "../../src/extensions/task-check/index.ts";
import { TaskTurnBudget } from "../../src/extensions/task-check/loop-guard.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(failProbe = false, sessionManager?: SessionManager, withEdit = false): Promise<Harness> {
	const harness = await createHarness({
		sessionManager,
		initialActiveToolNames: ["task_check", "probe", ...(withEdit ? ["edit"] : [])],
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
						structuredContent: { fixture: "offline-probe", successful: !failProbe },
						details: {},
					}),
				});
				if (withEdit)
					pi.registerTool({
						name: "edit",
						label: "Edit fixture",
						description: "Offline successful edit",
						parameters: Type.Object({ path: Type.String() }),
						execute: async () => ({
							content: [{ type: "text", text: "Successfully applied the requested edit." }],
							details: {},
						}),
					});
			},
		],
	});
	harnesses.push(harness);
	return harness;
}

async function setupDiscovery(): Promise<Harness> {
	const harness = await createHarness({
		initialActiveToolNames: ["tool_search"],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			createTaskCheckExtension(),
			(pi) => {
				pi.registerTool({
					name: "tool_search",
					label: "Discovery fixture",
					description: "Offline tool discovery",
					parameters: Type.Object({
						query: Type.String(),
						target: Type.Optional(Type.String()),
						load: Type.Optional(Type.Boolean()),
						omitTarget: Type.Optional(Type.Boolean()),
						status: Type.Optional(Type.Union([Type.Literal("refine"), Type.Literal("no_match")])),
					}),
					execute: async (_id, input) => ({
						content: [
							{
								type: "text",
								text: JSON.stringify({
									loaded: input.load ? ["browser_fill_form"] : [],
									steps: [
										{
											status: input.load ? "metadata_match" : (input.status ?? "refine"),
											intent: {
												capability: "browser",
												action: "fill",
												target: input.omitTarget ? undefined : (input.target ?? "service-request-form"),
												query: input.query,
											},
											tools: [],
											candidates: [{ name: "browser_fill_form" }],
										},
									],
								}),
							},
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
	it.each(["mutation", "generated-without-command", "wrong-path"] as const)(
		"rejects insufficient read evidence for %s",
		async (kind) => {
			const observed = "src/observed.ts";
			const claimed = kind === "wrong-path" ? "src/different.ts" : observed;
			const harness = await createHarness({
				initialActiveToolNames: ["task_check", "read"],
				settings: { retry: { enabled: false } },
				extensionFactories: [
					createTaskCheckExtension(),
					(pi) =>
						pi.registerTool({
							name: "read",
							label: "Artifact read",
							description: "Offline file inspection",
							parameters: Type.Object({ path: Type.String() }),
							execute: async (_id, params, _signal, _update, ctx) => ({
								content: [{ type: "text", text: readFileSync(join(ctx.cwd, params.path), "utf8") }],
								details: {},
							}),
						}),
				],
			});
			harnesses.push(harness);
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			writeFileSync(join(harness.tempDir, observed), "export const count = 2;\n");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: observed }, { id: "read-proof" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("task_check", {
						goal: "Inspect the artifact",
						criteria: [
							{
								criterion:
									kind === "mutation"
										? `Updated ${claimed}`
										: kind === "generated-without-command"
											? `Inspect ${claimed} generated by a command`
											: `Read ${claimed} and preserve it`,
								status: "verified",
								evidence: `Read ${claimed} and observed count = 2 in the source file.`,
								toolCallId: "read-proof",
							},
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The host could not confirm that claim."),
			]);
			await harness.session.prompt("Inspect the source file without changing it.");
			expect(getToolResult(harness, "task_check").isError).toBe(true);
		},
	);
	it.each([false, true])(
		"accepts a successful read proof for a preserved input or command-generated output (generated=%s)",
		async (generated) => {
			const file = generated ? "artifacts/output.json" : "data/input.csv";
			const harness = await createHarness({
				initialActiveToolNames: ["task_check", "bash", "read"],
				settings: { retry: { enabled: false } },
				extensionFactories: [
					createTaskCheckExtension(),
					(pi) => {
						pi.registerTool({
							name: "bash",
							label: "Local exporter",
							description: "Offline local artifact command",
							parameters: Type.Object({ command: Type.String() }),
							execute: async (_id, _params, _signal, _update, ctx) => {
								mkdirSync(dirname(join(ctx.cwd, file)), { recursive: true });
								writeFileSync(join(ctx.cwd, file), '{"count":2}\n');
								return {
									content: [{ type: "text", text: "Local export exited 0." }],
									details: {},
									structuredContent: { exit_code: 0 },
								};
							},
						});
						pi.registerTool({
							name: "read",
							label: "Read fixture file",
							description: "Offline artifact read",
							parameters: Type.Object({ path: Type.String() }),
							execute: async (_id, params, _signal, _update, ctx) => ({
								content: [{ type: "text", text: readFileSync(join(ctx.cwd, params.path), "utf8") }],
								details: {},
							}),
						});
					},
				],
			});
			harnesses.push(harness);
			if (!generated) {
				mkdirSync(dirname(join(harness.tempDir, file)), { recursive: true });
				writeFileSync(join(harness.tempDir, file), "id,quantity\nA,2\n");
			}
			harness.setResponses([
				...(generated
					? [fauxAssistantMessage(fauxToolCall("bash", { command: "node export.mjs" }), { stopReason: "toolUse" })]
					: []),
				fauxAssistantMessage(fauxToolCall("read", { path: file }, { id: "artifact-read" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("task_check", {
						goal: "Verify the artifact contract",
						criteria: [
							{
								criterion: generated
									? `Inspect ${file} generated by the command`
									: `Read ${file} and preserve its original contents`,
								status: "verified",
								evidence: generated
									? `Read ${file} and observed count=2 after the export command exited 0.`
									: `Read ${file} and observed the original A,2 row; this input remains unchanged.`,
								toolCallId: "artifact-read",
							},
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The observed file evidence is recorded."),
			]);
			await harness.session.prompt("Verify the local artifact without rewriting read-only files.");
			expect(getToolResult(harness, "task_check").isError).toBe(false);
			if (!generated) expect(readFileSync(join(harness.tempDir, file), "utf8")).toBe("id,quantity\nA,2\n");
		},
	);
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
	it("completes a natural final answer at the budget without an incomplete-task notice", async () => {
		const harness = await setup();
		harness.settingsManager.applyOverrides({ agentMaxTurns: 1 });
		harness.setResponses([fauxAssistantMessage("The requested explanation is complete.")]);
		await harness.session.prompt("Explain the local result.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "owl-loop-guard-stop"),
		).toBe(false);
	});
	it.each([undefined, null, false, "4", 0, -1, 1.5, 1025, Number.NaN, Infinity])(
		"invalid turn budget %s falls back to a finite 64",
		(value) => {
			const budget = new TaskTurnBudget();
			budget.reset(value);
			for (let turn = 1; turn < 64; turn++) expect(budget.completeTurn()).toBeUndefined();
			expect(budget.completeTurn()).toEqual({ reason: "turn-budget", toolName: "agent", count: 64 });
		},
	);

	it.each([1, 4, 1024])("accepts a positive integer turn budget %s", (value) => {
		const budget = new TaskTurnBudget();
		budget.reset(value);
		for (let turn = 1; turn < value; turn++) expect(budget.completeTurn()).toBeUndefined();
		expect(budget.completeTurn()).toMatchObject({ reason: "turn-budget", count: value });
	});

	it("does not raise an active budget after settings change or drain a queued follow-up", async () => {
		const harness = await setup();
		harness.settingsManager.applyOverrides({ agentMaxTurns: 4 });
		harness.setResponses([
			...Array.from({ length: 2 }, (_, offset) =>
				fauxAssistantMessage(fauxToolCall("probe", { offset }), { stopReason: "toolUse" }),
			),
			async () => {
				harness.settingsManager.applyOverrides({ agentMaxTurns: 100 });
				await harness.session.followUp("Automatically run more work.");
				return fauxAssistantMessage(fauxToolCall("probe", { offset: 2 }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("probe", { offset: 3 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("This must remain unused."),
		]);
		await harness.session.prompt("Perform the known local workflow.");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		expect(harness.session.getFollowUpMessages()).toEqual(["Automatically run more work."]);
	});

	it("captures a new budget only on a fresh user request after budget exhaustion", async () => {
		const harness = await setup();
		harness.settingsManager.applyOverrides({ agentMaxTurns: 4 });
		harness.setResponses(
			Array.from({ length: 4 }, (_, offset) =>
				fauxAssistantMessage(fauxToolCall("probe", { offset }), { stopReason: "toolUse" }),
			),
		);
		await harness.session.prompt("Perform the first local workflow.");
		harness.settingsManager.applyOverrides({ agentMaxTurns: 8 });
		harness.setResponses([
			...Array.from({ length: 5 }, (_, offset) =>
				fauxAssistantMessage(fauxToolCall("probe", { offset }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("The new request completed within its budget."),
		]);
		await harness.session.prompt("Continue with the remaining authorized steps.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", aborted: true },
			{ type: "agent_settled", aborted: false },
		]);
	});

	it("keeps the model budget across an automatic acceptance-check continuation", async () => {
		const harness = await setup();
		harness.settingsManager.applyOverrides({ agentMaxTurns: 3 });
		harness.setResponses([
			checklist("pending"),
			fauxAssistantMessage("Still needs verification."),
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("This completion must remain unused."),
		]);
		await harness.session.prompt("Implement and verify the local change.");
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
	});

	it("allows a legitimate long local workflow below the default 64 rounds", async () => {
		const harness = await setup();
		harness.setResponses([
			...Array.from({ length: 48 }, (_, offset) =>
				fauxAssistantMessage(fauxToolCall("probe", { offset }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("The local workflow completed."),
		]);
		await harness.session.prompt("Perform and verify the long local workflow.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
	});
	it("caps different successful operations at the snapshotted user-turn model budget", async () => {
		const harness = await setup();
		harness.settingsManager.applyOverrides({ agentMaxTurns: 4 });
		harness.setResponses([
			...Array.from({ length: 5 }, (_, offset) =>
				fauxAssistantMessage(fauxToolCall("probe", { offset }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("This completion claim must never be consumed."),
		]);
		await harness.session.prompt("Perform the multi-step local task.");
		expect(
			harness.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "probe"),
		).toHaveLength(4);
		expect(harness.getPendingResponseCount()).toBe(2);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		const stop = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "owl-loop-guard-stop");
		expect(stop).toMatchObject({ display: true, details: { reason: "turn-budget", count: 4 } });
		expect(stop && "content" in stop ? stop.content : "").toContain("尚未完成");
	});
	it("allows legitimate empty process polls without treating them as discovery stagnation", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["process"],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				createTaskCheckExtension(),
				(pi) =>
					pi.registerTool({
						name: "process",
						label: "Process fixture",
						description: "Poll a running background task",
						parameters: Type.Object({ action: Type.Literal("poll"), sessionId: Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "" }], details: { status: "running" } }),
					}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			...Array.from({ length: 4 }, () =>
				fauxAssistantMessage(fauxToolCall("process", { action: "poll", sessionId: "local-job" }), {
					stopReason: "toolUse",
				}),
			),
			fauxAssistantMessage("The local task is still running."),
		]);
		await harness.session.prompt("Wait for the known local background task.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
	});
	it("persists the third identical error and aborts before a fourth model request", async () => {
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
		]);
		expect(harness.eventsOfType("tool_execution_end").at(-1)?.result.structuredContent).toEqual({
			fixture: "offline-probe",
			successful: false,
		});
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		expect(harness.getPendingResponseCount()).toBe(2);
		const entries = harness.sessionManager.getEntries();
		const stopped = entries.findIndex(
			(entry) => entry.type === "custom_message" && entry.customType === "owl-loop-guard-stop",
		);
		expect(stopped).toBeGreaterThan(0);
		expect(entries[stopped]).toMatchObject({ type: "custom_message", display: true });
		expect(
			entries.slice(0, stopped).filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(3);
	});

	it.each(["refine", "no_match"] as const)(
		"aborts repeated successful discovery %s for the same intent without an active checklist",
		async (status) => {
			const harness = await setupDiscovery();
			harness.setResponses([
				...Array.from({ length: 4 }, (_, index) =>
					fauxAssistantMessage(
						fauxToolCall("tool_search", { query: `browser form alternate wording ${index}`, status }),
						{ stopReason: "toolUse" },
					),
				),
				fauxAssistantMessage("No form submitted."),
			]);
			await harness.session.prompt("Fill the local service form.");
			expect(
				harness.session.messages.filter(
					(message) => message.role === "toolResult" && message.toolName === "tool_search",
				),
			).toHaveLength(3);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
			expect(harness.getPendingResponseCount()).toBe(2);
			expect(reminders(harness)).toHaveLength(0);
		},
	);

	it.each([false, true])(
		"preserves independent discovery targets or unspecified-target research queries (omitTarget=%s)",
		async (omitTarget) => {
			const harness = await setupDiscovery();
			harness.setResponses([
				...Array.from({ length: 4 }, (_, index) =>
					fauxAssistantMessage(
						fauxToolCall("tool_search", {
							query: `Research subject ${index}`,
							target: `Subject ${index}`,
							omitTarget,
						}),
						{ stopReason: "toolUse" },
					),
				),
				fauxAssistantMessage("Each independent query was considered."),
			]);
			await harness.session.prompt("Inspect four independent research topics.");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
		},
	);

	it("loading a new tool resets the unsuccessful discovery window", async () => {
		const harness = await setupDiscovery();
		harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "Fill form" }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "Exact registered name", load: true }), {
				stopReason: "toolUse",
			}),
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "Fill form" }), { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("A new capability was loaded during the search."),
		]);
		await harness.session.prompt("Discover available form actions.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
	});

	it("a successful edit resets repeated failing test commands for normal development iterations", async () => {
		const harness = await setup(true, undefined, true);
		harness.setResponses([
			...Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })),
			fauxAssistantMessage(fauxToolCall("edit", { path: "src/invoice.mjs" }), { stopReason: "toolUse" }),
			...Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })),
			fauxAssistantMessage("The first edit did not fix every assertion."),
		]);
		await harness.session.prompt("Repair the invoice calculation and iterate on tests.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
	});

	it("a real new user turn can resume after a guarded abort without inheriting its failure counts", async () => {
		const harness = await setup(true);
		harness.setResponses(
			Array.from({ length: 3 }, () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })),
		);
		await harness.session.prompt("Run the missing dependency probe.");
		harness.setResponses([
			...Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })),
			fauxAssistantMessage("The new user request was checked independently."),
		]);
		await harness.session.prompt("I addressed the dependency; check again.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", aborted: true },
			{ type: "agent_settled", aborted: false },
		]);
	});

	it("does not resume a pending checklist or consume queued follow-up after the guarded abort", async () => {
		const harness = await setup(true);
		harness.setResponses([
			checklist("pending"),
			...Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })),
			async () => {
				await harness.session.followUp("Continue the task after this attempt.");
				return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("This must remain unused."),
		]);
		await harness.session.prompt("Repair the task with a pending acceptance checklist.");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reminders(harness)).toHaveLength(0);
		expect(harness.session.getFollowUpMessages()).toEqual(["Continue the task after this attempt."]);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
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
