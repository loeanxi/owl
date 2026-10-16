import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ExecutionAnomalyStore } from "../../src/modes/desktop/execution-anomalies.ts";
import {
	createExecutionAnomalyExtension,
	EXECUTION_ANOMALY_ALERT,
	EXECUTION_ANOMALY_REPORT_TOOL,
} from "../../src/modes/desktop/execution-anomaly-extension.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function setup(onDiagnostic?: (message: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "owl-anomaly-extension-"));
	directories.push(directory);
	const store = new ExecutionAnomalyStore(directory);
	const sessionManager = SessionManager.inMemory();
	const sessionId = sessionManager.getSessionId();
	const harness = await createHarness({
		sessionManager,
		initialActiveToolNames: [EXECUTION_ANOMALY_REPORT_TOOL, "probe", "nested_probe"],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			createExecutionAnomalyExtension({ store, getSessionId: () => sessionId, onDiagnostic }),
			(pi) => {
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Offline failing tool",
					parameters: Type.Object({}),
					execute: async () => ({
						isError: true,
						content: [{ type: "text", text: "Fixture dependency is unavailable" }],
						structuredContent: { fixture: "offline", error: "missing dependency" },
						details: undefined,
					}),
				});
				pi.registerTool({
					name: "nested_probe",
					label: "Nested probe",
					description: "Successful outer tool with a failing nested tool",
					parameters: Type.Object({}),
					async execute(_id, _input, _signal, _update, ctx) {
						await ctx.executeTool("probe", {});
						return { content: [{ type: "text", text: "Outer call completed" }], details: undefined };
					},
				});
			},
		],
	});
	harnesses.push(harness);
	return { harness, store, sessionId };
}

function reminders(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "owl-execution-anomaly-reminder");
}

describe("executing model anomaly reports", () => {
	it("shows the real error ID to the model and stores its report separately", async () => {
		const { harness, store } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}, { id: "failed-probe" }), { stopReason: "toolUse" }),
			(context) => {
				const record = store.list().records[0]!;
				expect(JSON.stringify(context.messages)).toContain(EXECUTION_ANOMALY_ALERT);
				expect(JSON.stringify(context.messages)).toContain(record.id);
				expect(record.summary).toBe("Fixture dependency is unavailable");
				return fauxAssistantMessage(
					fauxToolCall(EXECUTION_ANOMALY_REPORT_TOOL, {
						id: record.id,
						cause: "The fixture tool reported an unavailable dependency.",
						action: "Did not retry the same failing request.",
						outcome: "unresolved",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("The dependency is unavailable; the error analysis was saved."),
		]);
		await harness.session.prompt("Run the offline probe.");
		expect(getToolResult(harness, "probe").isError).toBe(true);
		expect(
			harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "probe")?.result
				.structuredContent,
		).toEqual({
			fixture: "offline",
			error: "missing dependency",
		});
		expect(store.list().records).toMatchObject([
			{
				toolCallId: "failed-probe",
				status: "reported",
				summary: "Fixture dependency is unavailable",
				report: { outcome: "unresolved" },
			},
		]);
		expect(reminders(harness)).toHaveLength(0);
	});

	it("reminds once when a nested failure is hidden by a successful outer tool", async () => {
		const { harness, store } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("nested_probe", {}, { id: "outer" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The outer call finished."),
			(context) => {
				const record = store.list().records[0]!;
				expect(record.toolCallId).toBe("outer/1");
				expect(JSON.stringify(context.messages)).toContain(record.id);
				return fauxAssistantMessage(
					fauxToolCall(EXECUTION_ANOMALY_REPORT_TOOL, {
						id: record.id,
						cause: "The nested fixture dependency is unavailable.",
						action: "Preserved the failure evidence without retrying.",
						outcome: "unresolved",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("The nested error report was saved."),
		]);
		await harness.session.prompt("Run the outer fixture.");
		expect(store.list().total).toBe(1);
		expect(store.list().records[0]?.status).toBe("reported");
		expect(reminders(harness)).toHaveLength(1);
	});

	it("bounds automatic continuation even when the model ignores pending records", async () => {
		const { harness, store } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished."),
			fauxAssistantMessage("Still not reporting."),
		]);
		await harness.session.prompt("Run the offline probe.");
		expect(reminders(harness)).toHaveLength(1);
		expect(store.list().records[0]?.status).toBe("pending");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("provides pending model errors on resume and supports empty parameter inspection", async () => {
		const { harness, store, sessionId } = await setup();
		const record = store.record({ sessionId, kind: "model_error", summary: "Provider quota exhausted" });
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Provider quota exhausted");
				return fauxAssistantMessage(fauxToolCall(EXECUTION_ANOMALY_REPORT_TOOL, {}), { stopReason: "toolUse" });
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(record.id);
				return fauxAssistantMessage("Unknown cause beyond the provider error.");
			},
			fauxAssistantMessage("The record remains pending."),
		]);
		await harness.session.prompt("Inspect pending errors.");
		expect(getMessageText(getToolResult(harness, EXECUTION_ANOMALY_REPORT_TOOL))).toContain(record.id);
		expect(store.get(record.id)?.status).toBe("pending");
		expect(reminders(harness)).toHaveLength(1);
	});

	it("preserves the original failure when log persistence and diagnostics are unavailable", async () => {
		const diagnostics: string[] = [];
		const { harness, store } = await setup((message) => {
			diagnostics.push(message);
			throw new Error("Diagnostic subscriber closed");
		});
		vi.spyOn(store, "list").mockImplementation(() => {
			throw new Error("Storage offline");
		});
		vi.spyOn(store, "record").mockImplementation(() => {
			throw new Error("Storage offline");
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("The probe failed and its anomaly log could not be saved."),
		]);
		await harness.session.prompt("Run the offline probe.");
		const result = getToolResult(harness, "probe");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Fixture dependency is unavailable");
		expect(getMessageText(result)).toContain("执行异常日志保存失败");
		expect(getMessageText(result)).not.toContain("已保存真实异常");
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(reminders(harness)).toHaveLength(0);
	});

	it.each(["partial", "foreign-session"] as const)(
		"rejects %s reports without recursively creating errors",
		async (kind) => {
			const { harness, store } = await setup();
			const foreign = store.record({
				sessionId: "other-session",
				kind: "model_error",
				summary: "Other session error",
			});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						EXECUTION_ANOMALY_REPORT_TOOL,
						kind === "partial"
							? { id: foreign.id }
							: {
									id: foreign.id,
									cause: "Not the current session.",
									action: "Attempted cross-session update.",
									outcome: "ignored",
								},
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The invalid report was rejected."),
			]);
			await harness.session.prompt("Exercise invalid report validation.");
			const result = getToolResult(harness, EXECUTION_ANOMALY_REPORT_TOOL);
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain("标准格式：");
			expect(store.list().total).toBe(1);
			expect(store.get(foreign.id)?.status).toBe("pending");
			expect(reminders(harness)).toHaveLength(0);
		},
	);
});
