/**
 * `process` 工具：与 unified-exec 会话进程交互 —— poll（等待并收取新输出）、write
 * （向 stdin 写入，`\u0003` 即 Ctrl-C）、kill、list。与 bash/powershell 的
 * `yield_time_ms` 语义配套：命令没跑完时返回 session_id，模型用本工具继续跟进。
 * 输出按 token 预算截断（约 4 字符/token，头尾各半保留，中段省略）。
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	getSessionProcess,
	killSessionProcess,
	listSessionProcesses,
	type ProcessEntry,
	takePending,
	waitSessionProcess,
	writeSessionProcess,
} from "./process-store.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { truncateMiddle } from "./truncate.ts";

const DEFAULT_POLL_YIELD_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MIN_YIELD_MS = 1_000;
const MAX_YIELD_MS = 300_000;

const processSchema = Type.Object({
	action: Type.Union([Type.Literal("poll"), Type.Literal("write"), Type.Literal("kill"), Type.Literal("list")], {
		description:
			"poll: wait for a session's output (default). write: send chars to the session's stdin ('\\u0003' = Ctrl-C). kill: terminate the session's process tree. list: show all sessions.",
	}),
	session_id: Type.Optional(
		Type.Number({
			description: "Session id returned by bash/powershell or a previous poll. Required unless action is list.",
		}),
	),
	chars: Type.Optional(Type.String({ description: "Input to write (action=write). Append '\\n' for Enter." })),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: `Max milliseconds to wait for new output before returning (poll/write). Default ${DEFAULT_POLL_YIELD_MS}.`,
		}),
	),
	max_output_tokens: Type.Optional(
		Type.Number({
			description: `Approximate max tokens of output to return. Default ${DEFAULT_MAX_OUTPUT_TOKENS}.`,
		}),
	),
});

export type ProcessToolInput = Static<typeof processSchema>;

const processOutputSchema = Type.Object({
	session_id: Type.Optional(Type.Number()),
	status: Type.Union([Type.Literal("running"), Type.Literal("exited"), Type.Literal("unknown")]),
	exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	output: Type.Optional(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
});

export interface ProcessToolDetails {
	/** 会话简况，供渲染层展示。 */
	session?: {
		id: number;
		command: string;
		cwd: string;
		status: "running" | "exited";
	};
}

type ProcessToolResult = AgentToolResult<ProcessToolDetails | undefined>;

export function createProcessToolDefinition(): ToolDefinition<typeof processSchema, ProcessToolDetails | undefined> {
	return {
		name: "process",
		label: "process",
		description:
			"Interact with background shell sessions started by bash/powershell (when a command is still running after yield_time_ms, those tools return a session_id). " +
			"poll waits up to yield_time_ms and returns new output plus the session status; write sends stdin input ('\\u0003' sends Ctrl-C); kill terminates the process tree; list shows all sessions.",
		promptSnippet: "Interact with background shell sessions (poll output, write stdin, kill)",
		parameters: processSchema,
		outputSchema: processOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params): Promise<ProcessToolResult> {
			const yieldMs = clampNumber(params.yield_time_ms, DEFAULT_POLL_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS);
			const maxOutputTokens = clampNumber(params.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS, 256, 100_000);

			if (params.action === "list") {
				return renderList(listSessionProcesses());
			}

			if (params.session_id === undefined) {
				return errorResult(
					"`session_id` is required for poll/write/kill. Use action=list to see running sessions.",
				);
			}
			const entry = getSessionProcess(params.session_id);
			if (!entry) {
				return errorResult(
					`Unknown session_id ${params.session_id}. It may have exited and been reaped, or belongs to another session. Use action=list to see current sessions.`,
				);
			}

			if (params.action === "kill") {
				killSessionProcess(entry);
				await waitSessionProcess(entry, 3_000);
				const output = takePending(entry);
				return textResult(formatBody(entry, output, maxOutputTokens, "Kill signal sent."), entry);
			}

			if (params.action === "write") {
				const chars = params.chars;
				if (!chars) {
					return errorResult("`chars` is required for action=write. Use action=poll to just wait for output.");
				}
				const accepted = writeSessionProcess(entry, chars);
				if (!accepted) {
					return errorResult(
						`Session ${entry.id} does not accept stdin input (it already exited, or its command was delivered via stdin and cannot read more input). Use action=poll to wait for output or action=kill to terminate it.`,
					);
				}
				await waitSessionProcess(entry, Math.min(yieldMs, 10_000));
				const output = takePending(entry);
				return textResult(formatBody(entry, output, maxOutputTokens), entry);
			}

			// poll
			await waitSessionProcess(entry, yieldMs);
			const output = takePending(entry);
			return textResult(formatBody(entry, output, maxOutputTokens), entry);
		},
	};
}

export function createProcessTool(): AgentTool<typeof processSchema, ProcessToolDetails | undefined> {
	return wrapToolDefinition(createProcessToolDefinition());
}

function sessionDetails(entry: ProcessEntry): ProcessToolDetails["session"] {
	return {
		id: entry.id,
		command: entry.command.length > 120 ? `${entry.command.slice(0, 117)}...` : entry.command,
		cwd: entry.cwd,
		status: entry.exitCode !== undefined ? "exited" : "running",
	};
}

function formatBody(entry: ProcessEntry, output: string, maxOutputTokens: number, prefix?: string): string {
	const status =
		entry.exitCode === undefined
			? "still running"
			: `exited (code ${entry.exitCode}${entry.exitSignal ? `, signal ${entry.exitSignal}` : ""}${entry.killed ? ", killed" : ""})`;
	const { content, truncated } = capOutput(output, maxOutputTokens);
	const parts: string[] = [];
	if (prefix) parts.push(prefix);
	parts.push(content ? content : "(no new output)");
	const hint =
		entry.exitCode === undefined
			? "poll again for more output; write to send stdin ('\\u0003' = Ctrl-C); kill to terminate."
			: "";
	parts.push(`[session_id: ${entry.id} — ${status}${hint ? `. ${hint}` : ""}]`);
	let text = parts.join("\n\n");
	if (truncated) {
		text += "\n(output truncated to fit the token budget; more output remains buffered)";
	}
	return text;
}

function textResult(text: string, entry: ProcessEntry): ProcessToolResult {
	const structured = {
		session_id: entry.id,
		status: (entry.exitCode === undefined ? "running" : "exited") as "running" | "exited",
		...(entry.exitCode !== undefined ? { exit_code: entry.exitCode } : {}),
		truncated: false,
	};
	return {
		content: [{ type: "text", text }],
		details: { session: sessionDetails(entry) },
		structuredContent: structured,
	};
}

function renderList(entries: ProcessEntry[]): ProcessToolResult {
	if (entries.length === 0) {
		return {
			content: [{ type: "text", text: "No background shell sessions." }],
			details: undefined,
			structuredContent: { status: "unknown" as const },
		};
	}
	const lines = entries.map((entry) => {
		const command = entry.command.length > 100 ? `${entry.command.slice(0, 97)}...` : entry.command;
		const status = entry.exitCode === undefined ? "running" : `exited (code ${entry.exitCode})`;
		return `- session_id ${entry.id} — ${status} — cwd ${entry.cwd} — ${command}`;
	});
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: undefined,
		structuredContent: {
			status: "unknown" as const,
			sessions: entries.map((entry) => ({
				id: entry.id,
				command: entry.command.length > 120 ? `${entry.command.slice(0, 117)}...` : entry.command,
				cwd: entry.cwd,
				status: (entry.exitCode !== undefined ? "exited" : "running") as "running" | "exited",
			})),
		},
	};
}

function errorResult(message: string): ProcessToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
		structuredContent: { status: "unknown" as const },
		isError: true,
	};
}

/** 按 token 预算（约 4 字符/token）截断，头尾各半保留、中段省略。 */
function capOutput(output: string, maxOutputTokens: number): { content: string; truncated: boolean } {
	const maxBytes = Math.max(256, maxOutputTokens * 4);
	if (Buffer.byteLength(output, "utf-8") <= maxBytes) {
		return { content: output, truncated: false };
	}
	const middle = truncateMiddle(output, maxBytes);
	return { content: middle.content, truncated: true };
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
