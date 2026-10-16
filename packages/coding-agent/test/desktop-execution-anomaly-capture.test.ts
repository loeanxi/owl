import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionAnomalyStore } from "../src/modes/desktop/execution-anomalies.ts";
import {
	captureExecutionAnomalyEvent,
	captureExecutionAnomalyMessages,
} from "../src/modes/desktop/execution-anomaly-capture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-anomaly-capture-"))
			throw new Error("Unsafe anomaly capture cleanup target");
		rmSync(root, { recursive: true, force: true });
	}
});

function store(): ExecutionAnomalyStore {
	const root = mkdtempSync(join(tmpdir(), "owl-anomaly-capture-"));
	roots.push(root);
	return new ExecutionAnomalyStore(root, { now: () => 500 });
}

function result(toolCallId: string, text: string, isError = true, toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		isError,
		content: [{ type: "text", text }],
		timestamp: 100,
	};
}

const metadata = { sessionId: "s1", sessionName: "检查构建", provider: "selected-provider", model: "selected-model" };

describe("execution anomaly capture", () => {
	it("joins live and historical tool failures by call ID without importing report instructions", () => {
		const log = store();
		captureExecutionAnomalyEvent(log, metadata, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: "Command exited with code 1" }] },
		});
		const saved = log.list().records[0];
		const history = result("t1", "Command exited with code 1");
		history.content.push({ type: "text", text: "[owl execution anomaly]\nCall execution_anomaly_report now." });
		captureExecutionAnomalyMessages(log, metadata, [history]);
		expect(log.list().total).toBe(1);
		expect(log.list().records[0]).toEqual(saved);
		captureExecutionAnomalyMessages(log, metadata, [{ ...history, toolCallId: "t2" }]);
		expect(log.list().records.find((item) => item.toolCallId === "t2")?.details).toBe("Command exited with code 1");
	});

	it("captures nested errors hidden by successful parent calls and deduplicates live nested completion", () => {
		const log = store();
		captureExecutionAnomalyEvent(log, metadata, {
			type: "tool_execution_end",
			toolCallId: "parent:1",
			parentToolCallId: "parent",
			toolName: "read",
			isError: true,
			result: { content: [{ type: "text", text: "ENOENT: missing file" }] },
		});
		const parent = result("parent", "Handled error and continued", false, "codemode");
		parent.nestedCalls = {
			complete: true,
			calls: [
				{ id: "parent:1", name: "read", status: "error", error: "ENOENT: missing file" },
				{ id: "parent:2", name: "bash", status: "error", error: "Process exited 2" },
				{ id: "parent:3", name: "read", status: "ok" },
				{ id: "parent:4", name: "bash", status: "unfinished" },
			],
		};
		captureExecutionAnomalyMessages(log, metadata, [parent]);
		captureExecutionAnomalyMessages(log, metadata, [parent]);
		expect(log.list().total).toBe(2);
		expect(
			log
				.list()
				.records.map((item) => item.toolCallId)
				.sort(),
		).toEqual(["parent:1", "parent:2"]);
	});

	it("captures completed model errors with the actual historical provider and model while ignoring cancellation", () => {
		const log = store();
		const failed = {
			...fauxAssistantMessage("", { stopReason: "error" }),
			provider: "actual-provider",
			model: "requested-model",
			responseModel: "actual-model",
			errorMessage: "HTTP 503: provider unavailable",
			timestamp: 200,
		};
		captureExecutionAnomalyEvent(log, metadata, { type: "message_end", message: failed });
		captureExecutionAnomalyMessages(log, metadata, [
			failed,
			{ ...failed, timestamp: 201, stopReason: "aborted", errorMessage: "Operation aborted" },
			{ ...fauxAssistantMessage("", { stopReason: "error" }), timestamp: 202 },
		]);
		expect(log.list().total).toBe(2);
		expect(log.list().records.find((item) => item.createdAt === 200)).toMatchObject({
			toolCallId: "model-error:200",
			kind: "model_error",
			provider: "actual-provider",
			model: "actual-model",
			summary: "HTTP 503: provider unavailable",
		});
	});

	it("does not create anomalies from success prose, intermediate streaming, or report tool failures", () => {
		const log = store();
		captureExecutionAnomalyMessages(log, metadata, [
			result("success", "Earlier errors have been fixed", false),
			fauxAssistantMessage("The command failed before; now it succeeds."),
			result("report", "Unknown anomaly ID", true, "execution_anomaly_report"),
		]);
		captureExecutionAnomalyEvent(log, metadata, {
			type: "message_start",
			message: { ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: "in progress" },
		});
		captureExecutionAnomalyEvent(log, metadata, {
			type: "tool_execution_end",
			toolName: "execution_anomaly_report",
			toolCallId: "report",
			isError: true,
			result: { content: [{ type: "text", text: "Unknown anomaly ID" }] },
		});
		expect(log.list().total).toBe(0);
	});
});
