import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ExecutionAnomalyStore } from "../../src/modes/desktop/execution-anomalies.ts";
import {
	captureExecutionAnomalyEvent,
	captureExecutionAnomalyMessages,
} from "../../src/modes/desktop/execution-anomaly-capture.ts";
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
	for (const directory of directories.splice(0)) {
		if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-blocked-anomaly-"))
			throw new Error("Unexpected fixture cleanup directory");
		rmSync(directory, { recursive: true, force: true });
	}
});

const failureText = "The requested target is outside this task's directory.";
type Mode = "scope-block" | "adapter-block" | "runtime-error" | "parent-error";

async function setup(mode: Mode) {
	const directory = mkdtempSync(join(tmpdir(), "owl-blocked-anomaly-"));
	directories.push(directory);
	const store = new ExecutionAnomalyStore(join(directory, "live"));
	const sessionManager = SessionManager.inMemory();
	const metadata = { sessionId: sessionManager.getSessionId() };
	let executions = 0;
	const harness = await createHarness({
		sessionManager,
		initialActiveToolNames: ["probe", "nested_probe", "write", "read", EXECUTION_ANOMALY_REPORT_TOOL],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			createExecutionAnomalyExtension({ store, getSessionId: () => metadata.sessionId }),
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "probe" && (mode === "scope-block" || mode === "parent-error"))
						return { block: true, reason: failureText };
				});
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Offline target operation",
					parameters: Type.Object({}),
					async execute() {
						executions++;
						return {
							isError: true,
							content: [{ type: "text", text: failureText }],
							// An adapter can also report that its downstream target was never invoked.
							details: mode === "adapter-block" ? { toolExecutionBlocked: true } : undefined,
						};
					},
				});
				pi.registerTool({
					name: "nested_probe",
					label: "Nested probe",
					description: "Catches a rejected child and continues the authorized task",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						await ctx.executeTool("probe", {});
						if (mode === "parent-error")
							throw new Error("Parent transformation failed after the rejected child.");
						return { content: [{ type: "text", text: "Child outcome inspected." }], details: undefined };
					},
				});
			},
		],
	});
	harnesses.push(harness);
	// Use the production desktop subscriber as well as the extension, so live capture
	// cannot reinsert a block that the tool_result handler deliberately excluded.
	harness.session.subscribe((event) => captureExecutionAnomalyEvent(store, metadata, event));
	return { harness, store, metadata, directory, executions: () => executions };
}

const cases: { route: "direct" | "nested"; mode: Mode }[] = [
	{ route: "direct", mode: "scope-block" },
	{ route: "nested", mode: "scope-block" },
	{ route: "direct", mode: "adapter-block" },
	{ route: "nested", mode: "adapter-block" },
	{ route: "direct", mode: "runtime-error" },
	{ route: "nested", mode: "runtime-error" },
	{ route: "nested", mode: "parent-error" },
];

describe("blocked calls are distinct from executed runtime anomalies", () => {
	it.each(cases)(
		"preserves the $route $mode outcome without unnecessary completion rounds",
		async ({ route, mode }) => {
			const { harness, store, metadata, directory, executions } = await setup(mode);
			const toolName = route === "nested" ? "nested_probe" : "probe";
			const runtimeFailure = mode === "runtime-error" || mode === "parent-error";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(toolName, {}, { id: "attempt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("write", { path: "report.txt", content: "Verified local result.\n" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("read", { path: "report.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("The authorized report was created and read back."),
				fauxAssistantMessage("The runtime anomaly remains unresolved."),
			]);
			await harness.session.prompt("Create and verify report.txt; respect the enforced target scope.");

			expect(readFileSync(join(harness.tempDir, "report.txt"), "utf8")).toBe("Verified local result.\n");
			expect(getToolResult(harness, "write").isError).toBe(false);
			expect(getMessageText(getToolResult(harness, "read"))).toBe("Verified local result.\n");
			expect(executions()).toBe(mode === "scope-block" || mode === "parent-error" ? 0 : 1);
			const expectedAnomalies = runtimeFailure ? 1 : 0;
			expect(store.list().total).toBe(expectedAnomalies);
			const reminders = harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "owl-execution-anomaly-reminder",
				);
			expect(reminders).toHaveLength(expectedAnomalies);
			expect(harness.eventsOfType("turn_start")).toHaveLength(runtimeFailure ? 5 : 4);
			expect(harness.getPendingResponseCount()).toBe(runtimeFailure ? 0 : 1);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);

			const result = getToolResult(harness, toolName);
			if (route === "direct") {
				// Classification must not turn a refused call into a successful UI/history result.
				expect(result.isError).toBe(true);
				expect(getMessageText(result)).toContain(failureText);
				if (!runtimeFailure) {
					expect(result.details).toMatchObject({ toolExecutionBlocked: true });
					expect(getMessageText(result)).not.toContain(EXECUTION_ANOMALY_ALERT);
				}
			} else {
				expect(result.isError).toBe(mode === "parent-error");
				expect(result.nestedCalls?.calls).toHaveLength(1);
				expect(result.nestedCalls?.calls[0]).toMatchObject({
					id: "attempt/1",
					name: "probe",
					status: "error",
					...(mode === "runtime-error" ? {} : { blocked: true }),
				});
			}
			if (runtimeFailure) {
				expect(store.list().records[0]?.toolCallId).toBe(
					mode === "parent-error" || route === "direct" ? "attempt" : "attempt/1",
				);
				expect(store.list().records[0]?.status).toBe("pending");
			}
			const replayStore = new ExecutionAnomalyStore(join(directory, "replay"));
			captureExecutionAnomalyMessages(replayStore, metadata, harness.session.messages);
			captureExecutionAnomalyMessages(replayStore, metadata, harness.session.messages);
			expect(replayStore.list().total).toBe(expectedAnomalies);
			expect(replayStore.list().records.map((entry) => entry.toolCallId)).toEqual(
				store.list().records.map((entry) => entry.toolCallId),
			);
		},
	);
});
