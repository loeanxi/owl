import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ExtensionFactory, InlineExtension } from "../../core/extensions/types.ts";

const STATE_TYPE = "owl-task-check";
const criterionSchema = Type.Object({
	criterion: Type.String({ minLength: 1, maxLength: 300 }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("verified"), Type.Literal("blocked")]),
	evidence: Type.Optional(
		Type.String({ maxLength: 1500, description: "Observed result or concrete blocking reason; not merely 'done'." }),
	),
	toolCallId: Type.Optional(
		Type.String({ description: "Optional successful tool call from this user turn supporting the evidence." }),
	),
});
const parameters = Type.Object({
	goal: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
	criteria: Type.Optional(
		Type.Array(criterionSchema, {
			minItems: 1,
			maxItems: 20,
			description: "Full acceptance checklist for authorized implementation work; replaces the previous checklist.",
		}),
	),
	clear: Type.Optional(
		Type.Boolean({
			description:
				"Stop tracking this task. Omit all fields to inspect the latest saved checklist without activating it.",
		}),
	),
});
type Criterion = Static<typeof criterionSchema>;
interface TaskState {
	version: 1;
	goal: string;
	criteria: Criterion[];
}

function restoreState(ctx: ExtensionContext): TaskState | null {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data: unknown = entry.data;
		if (data === null) return null;
		if (
			typeof data !== "object" ||
			data === null ||
			!("version" in data) ||
			data.version !== 1 ||
			!("goal" in data) ||
			typeof data.goal !== "string" ||
			!("criteria" in data) ||
			!Array.isArray(data.criteria)
		)
			return null;
		const criteria: Criterion[] = [];
		for (const item of data.criteria) {
			if (
				typeof item !== "object" ||
				item === null ||
				typeof item.criterion !== "string" ||
				!["pending", "verified", "blocked"].includes(item.status) ||
				(item.evidence !== undefined && typeof item.evidence !== "string") ||
				(item.toolCallId !== undefined && typeof item.toolCallId !== "string")
			)
				return null;
			criteria.push({
				criterion: item.criterion,
				status: item.status,
				evidence: item.evidence,
				toolCallId: item.toolCallId,
			});
		}
		return { version: 1, goal: data.goal, criteria };
	}
	return null;
}

interface HostCommand {
	command: string;
	exitCode: number;
}

const FILE_PATH = /(?:^|[\s`'"])((?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,8})/g;

function mentionedPaths(text: string): string[] {
	return [...text.matchAll(FILE_PATH)].map((match) => match[1]!.replaceAll("\\", "/"));
}

function samePath(written: string, mentioned: string): boolean {
	const have = written.replaceAll("\\", "/").toLowerCase();
	const wanted = mentioned.replaceAll("\\", "/").toLowerCase();
	return have === wanted || have.endsWith(`/${wanted}`) || wanted.endsWith(`/${have}`);
}

function exitCodeOf(structured: unknown, isError: boolean): number {
	if (typeof structured === "object" && structured !== null && "exit_code" in structured) {
		const code = (structured as { exit_code?: unknown }).exit_code;
		if (typeof code === "number" && Number.isFinite(code)) return code;
	}
	return isError ? 1 : 0;
}

/** What the host can prove from this turn's tool results, for the acceptance reminder. */
export function formatHostObservations(writes: readonly string[], commands: readonly HostCommand[]): string {
	const uniqueWrites = [...new Set(writes)];
	const wrote = uniqueWrites.length > 0 ? `Wrote ${uniqueWrites.join(", ")}.` : "No successful edit or write.";
	if (commands.length === 0) return `Host observations from this turn: ${wrote} No command exited 0.`;
	const succeeded = commands.filter((command) => command.exitCode === 0);
	const failed = commands.filter((command) => command.exitCode !== 0);
	const parts = [
		wrote,
		succeeded.length > 0
			? `Commands that exited 0: ${succeeded.map((command) => command.command).join("; ")}.`
			: "No command exited 0.",
		failed.length > 0
			? `Commands that failed: ${failed.map((command) => `${command.command} (${command.exitCode})`).join("; ")}.`
			: "",
	].filter(Boolean);
	return `Host observations from this turn: ${parts.join(" ")}`;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

/** An explicit checklist and a bounded reminder, not an independent proof of task completion. */
export function createTaskCheckExtension(): ExtensionFactory {
	return (pi) => {
		let state: TaskState | null = null;
		let active = false;
		let reminded = false;
		const successfulCalls = new Set<string>();
		const failures = new Map<string, { result: string; count: number }>();
		const writes: string[] = [];
		const commands: HostCommand[] = [];
		const reset = () => {
			active = false;
			reminded = false;
			successfulCalls.clear();
			failures.clear();
			writes.length = 0;
			commands.length = 0;
		};
		pi.on("before_agent_start", (_event, ctx) => {
			reset();
			state = restoreState(ctx);
		});
		pi.on("message_start", (event) => {
			// Delivered steering/follow-ups revoke the old automatic reminder too.
			if (event.message.role === "user") reset();
		});
		pi.on("session_start", (_event, ctx) => {
			reset();
			state = restoreState(ctx);
		});
		pi.on("session_tree", (_event, ctx) => {
			reset();
			state = restoreState(ctx);
		});
		pi.registerTool({
			name: "task_check",
			label: "任务验收",
			defaultActive: false,
			executionMode: "sequential",
			description:
				"Track acceptance criteria for authorized multi-step implementation work. Use todo for the plan. Register a goal and full criteria list only while doing that work, not for chat, explanations, or read-only discussion. Mark verified only with concrete observed evidence; blocked requires a reason. An optional toolCallId must refer to a successful call in this user turn. Omit fields to inspect without resuming. A pending checklist can prompt one extra work turn; it does not prove completion or authorize actions.",
			promptSnippet: "记录多步实作的验收项、验证证据与阻塞原因；闲聊和只读讨论无需使用",
			parameters,
			async execute(_id, input, _signal, _onUpdate, ctx) {
				const fail = (text: string) => ({
					isError: true,
					content: [{ type: "text" as const, text }],
					details: { state, active },
				});
				if (input.clear) {
					if (input.goal !== undefined || input.criteria !== undefined)
						return fail("clear cannot be combined with a new checklist.");
					state = null;
					active = false;
					pi.appendEntry(STATE_TYPE, null);
				} else if (input.criteria !== undefined) {
					if (!input.goal?.trim())
						return fail("A concrete goal is required when registering acceptance criteria.");
					for (const item of input.criteria) {
						if (!item.criterion.trim()) return fail("Acceptance criteria cannot be blank.");
						if (item.status !== "pending") {
							const evidence = item.evidence?.trim() ?? "";
							if (
								evidence.length < 6 ||
								/^(?:已(?:经)?(?:完成|验证|通过)|全部完成|done|passed|verified|success(?:ful)?|ok)[。.!！\s]*$/iu.test(
									evidence,
								)
							) {
								return fail(
									`${item.status} requires concrete observed evidence or a specific blocking reason, not a completion assertion.`,
								);
							}
						}
						if (item.toolCallId && (item.status !== "verified" || !successfulCalls.has(item.toolCallId))) {
							return fail(
								"toolCallId must reference an existing successful tool result from this user turn and a verified criterion.",
							);
						}
						if (item.status === "verified") {
							const missing = mentionedPaths(`${item.criterion}\n${item.evidence ?? ""}`).filter(
								(path) => !writes.some((written) => samePath(written, path)),
							);
							if (missing.length > 0) {
								return fail(
									`Host did not observe a successful edit or write for ${missing.join(", ")}. ${formatHostObservations(writes, commands)}`,
								);
							}
						}
					}
					state = {
						version: 1,
						goal: input.goal.trim(),
						criteria: input.criteria.map((item) => ({
							...item,
							criterion: item.criterion.trim(),
							...(item.evidence ? { evidence: item.evidence.trim() } : {}),
						})),
					};
					active = true;
					pi.appendEntry(STATE_TYPE, state);
				} else if (input.goal !== undefined) {
					return fail("Provide criteria with the goal, or omit all fields to inspect the checklist.");
				} else {
					state = restoreState(ctx);
				}
				return {
					content: [
						{
							type: "text",
							text: state
								? JSON.stringify({ goal: state.goal, criteria: state.criteria, active })
								: "No acceptance checklist is registered.",
						},
					],
					details: { state, active, reminded },
				};
			},
		});
		pi.on("tool_result", (event) => {
			if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
				const path = event.input.path;
				if (typeof path === "string" && path.trim()) writes.push(path.trim());
			}
			if (event.toolName === "bash" || event.toolName === "powershell") {
				const command = event.input.command;
				if (typeof command === "string" && command.trim()) {
					commands.push({
						command: command.trim().slice(0, 160),
						exitCode: exitCodeOf(event.structuredContent, event.isError),
					});
				}
			}
			const call = createHash("sha256")
				.update(JSON.stringify([event.toolName, stableValue(event.input)]))
				.digest("hex");
			if (!event.isError) {
				if (event.toolName !== "task_check") successfulCalls.add(event.toolCallId);
				failures.delete(call);
				return;
			}
			const result = createHash("sha256")
				.update(JSON.stringify(stableValue(event.content)))
				.digest("hex");
			const previous = failures.get(call);
			const count = previous?.result === result ? previous.count + 1 : 1;
			failures.set(call, { result, count });
			if (failures.size > 100) failures.delete(failures.keys().next().value!);
			if (count !== 3) return;
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: "[task-check recovery] This exact tool request returned the same error three times. Inspect the cause and change the inputs or approach before retrying. If a required dependency or permission is unavailable, report the blocker; do not claim success.",
					},
				],
				...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
			};
		});
		pi.on("agent_before_settle", (event, ctx) => {
			if (
				!active ||
				reminded ||
				!state ||
				event.outcome !== "completed" ||
				ctx.signal?.aborted ||
				event.context.pendingMessages.length > 0 ||
				ctx.hasPendingMessages()
			)
				return;
			const pending = state.criteria.filter((item) => item.status === "pending");
			if (pending.length === 0) return;
			reminded = true;
			return {
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: "owl-task-check-reminder",
						display: false,
						content: `The implementation checklist you explicitly registered still has pending acceptance criteria for ${state.goal}:\n${pending.map((item) => `- ${item.criterion}`).join("\n")}\n${formatHostObservations(writes, commands)}\nContinue only the authorized work needed to check them. Record actual evidence with task_check; a file named in verified evidence must have a successful edit or write this turn. If blocked, record the reason and report the limitation. This is the only automatic reminder for this user request. Do not repeat checks that already have evidence, invent success, or expand permissions.`,
					},
				],
			};
		});
	};
}

export const taskCheckExtension: InlineExtension = {
	name: "task-check",
	factory: createTaskCheckExtension(),
	replaceable: true,
	builtin: true,
};
