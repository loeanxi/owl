import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { ExecutionAnomalyInput, ExecutionAnomalyStore } from "./execution-anomalies.ts";

export type ExecutionAnomalyMetadata = Pick<
	ExecutionAnomalyInput,
	"sessionId" | "sessionName" | "sessionFile" | "cwd" | "provider" | "model"
>;

const REPORT_TOOL = "execution_anomaly_report";
const REPORT_ALERT = "[owl execution anomaly]";
const ABORT_TEXT = /^(?:Operation aborted|The operation was aborted(?:\.)?|AbortError:)/;
/** Designed desktop waits. They already tell the model how to continue, so they are not defects. */
const RECOVERABLE_COMPUTER_CODES = new Set([
	"user_busy",
	"input_conflict",
	"background_backend_unavailable",
	"exclusive_required",
	"foreground_required",
	"read_conflict",
	"desktop_busy",
	"target_busy",
]);

/** Cancellation, safety-net policy blocks, and retryable edit misses are not product defects. */
const POLICY_BLOCK = /^BLOCKED by \S+ Safety Net\b/;
const RETRYABLE_EDIT = /^🔄 RETRYABLE —/;
/**
 * The model guessed a tool, a path, or a schema, or the loop already stopped it.
 * Those are corrected in the same turn. They are not execution anomalies, and they
 * must not trigger an execution_anomaly_report reminder.
 */
const MODEL_MISS =
	/^Tool \S+ not found\b|^ENOENT:|Error code: ENOENT\b|No such file or directory|Path not found|can't read |^Validation failed for tool |^Refusing to overwrite |^Structured single-child execution cannot be combined with workflow\b|^Failed to read workflow script\b|was not executed: the response hit the output token limit|本轮工具调用已达上限|已经确认不存在|没有再次执行|已经要求停止调用工具/;
/** grep / git queries often exit 1 or 2 after printing a result. That is not a defect. */
const QUERY_EXIT = /Command exited with code [12]\b/;

/** Cancellation and recoverable computer-control waits must not become execution anomalies. */
export function isRecordedExecutionAnomaly(toolName: string, text: string): boolean {
	const trimmed = text.trim();
	if (
		ABORT_TEXT.test(trimmed) ||
		POLICY_BLOCK.test(trimmed) ||
		RETRYABLE_EDIT.test(trimmed) ||
		MODEL_MISS.test(trimmed) ||
		(QUERY_EXIT.test(trimmed) && trimmed.replace(/Command exited with code [12]\b/g, "").trim().length > 0)
	)
		return false;
	if (toolName !== "computer_act" && toolName !== "computer_observe") return true;
	const code = trimmed.match(/"code":"([^"]+)"/)?.[1];
	return !(
		/"status":"blocked"/.test(trimmed) &&
		/"retryable":true/.test(trimmed) &&
		code !== undefined &&
		RECOVERABLE_COMPUTER_CODES.has(code)
	);
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Extension reminders are model instructions, not part of the tool's observed failure evidence. */
function toolText(value: unknown): string {
	if (typeof value === "string") return value;
	const content = object(value)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			const block = object(part);
			return block?.type === "text" &&
				typeof block.text === "string" &&
				!block.text.trimStart().startsWith(REPORT_ALERT)
				? [block.text]
				: [];
		})
		.join("\n")
		.trim();
}

function captureTool(
	store: ExecutionAnomalyStore,
	metadata: ExecutionAnomalyMetadata,
	toolCallId: string,
	toolName: string,
	text: string,
	timestamp?: number,
): void {
	if (toolName === REPORT_TOOL || !isRecordedExecutionAnomaly(toolName, text)) return;
	store.record({
		...metadata,
		toolCallId,
		toolName,
		kind: "tool_error",
		summary: text || `${toolName} 执行失败，未提供错误文本。`,
		details: text || undefined,
		timestamp,
	});
}

/** Nested call ledgers survive history reloads even when a parent script caught the failure. */
function captureNested(
	store: ExecutionAnomalyStore,
	metadata: ExecutionAnomalyMetadata,
	nestedCalls: unknown,
	timestamp?: number,
): void {
	const calls = object(nestedCalls)?.calls;
	if (!Array.isArray(calls)) return;
	for (const value of calls) {
		const call = object(value);
		if (call?.status !== "error" || typeof call.id !== "string" || typeof call.name !== "string") continue;
		captureTool(store, metadata, call.id, call.name, typeof call.error === "string" ? call.error : "", timestamp);
	}
}

/** Capture only recorded failure signals; ordinary assistant prose and successful results do not count. */
export function captureExecutionAnomalyMessages(
	store: ExecutionAnomalyStore,
	metadata: ExecutionAnomalyMetadata,
	messages: readonly AgentMessage[],
): void {
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (message.isError)
				captureTool(store, metadata, message.toolCallId, message.toolName, toolText(message), message.timestamp);
			captureNested(store, metadata, message.nestedCalls, message.timestamp);
		} else if (
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			(message.stopReason === "error" || !!message.errorMessage?.trim())
		) {
			store.record({
				...metadata,
				provider: message.provider || metadata.provider,
				model: message.responseModel || message.model || metadata.model,
				toolCallId: `model-error:${message.timestamp}`,
				kind: "model_error",
				summary: message.errorMessage?.trim() || "模型响应失败，未提供错误文本。",
				details: message.errorMessage?.trim() || undefined,
				timestamp: message.timestamp,
			});
		}
	}
}

/** Shared by the live bridge and resume-history import; store-level deduplication joins both paths. */
export function captureExecutionAnomalyEvent(
	store: ExecutionAnomalyStore,
	metadata: ExecutionAnomalyMetadata,
	event: AgentSessionEvent,
): void {
	if (event.type === "message_end") {
		captureExecutionAnomalyMessages(store, metadata, [event.message]);
	} else if (event.type === "tool_execution_end") {
		const result: unknown = event.result;
		if (event.isError) captureTool(store, metadata, event.toolCallId, event.toolName, toolText(result));
		captureNested(store, metadata, object(result)?.nestedCalls);
	}
}
