import { isInvalidToolCall, summarizeToolCall } from "../hooks/summarize.ts";
import type { ToolCard } from "../hooks/transcript.ts";
import { workProcessText } from "./work-process-copy.ts";

export interface WorkAction {
	key: string;
	card: ToolCard;
	ownerIndex?: number;
	entryId?: string;
	/** Presentation may merge a turn, while recovery evidence stays within its original work segment. */
	scope?: string;
}

function argumentsOf(args: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(args);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Sort object keys only. Paths, command strings, write contents and array order remain exact. */
function canonicalJson(value: unknown): string | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
	if (Array.isArray(value)) {
		const items = value.map(canonicalJson);
		return items.every((item) => item !== undefined) ? `[${items.join(",")}]` : undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const object = value as Record<string, unknown>;
	const items: string[] = [];
	for (const key of Object.keys(object).sort()) {
		const encoded = canonicalJson(object[key]);
		if (encoded === undefined) return undefined;
		items.push(`${JSON.stringify(key)}:${encoded}`);
	}
	return `{${items.join(",")}}`;
}

/** Only file tools expose their original path; a shortened title must never become a path target. */
export function workActionPath(card: ToolCard): string | undefined {
	if (card.name !== "read" && card.name !== "write" && card.name !== "edit") return undefined;
	const path = argumentsOf(card.args)?.path;
	return typeof path === "string" && path.trim() ? path : undefined;
}

export function workActionTitle(card: ToolCard): string {
	const args = argumentsOf(card.args);
	const path = workActionPath(card);
	if (path) {
		const name =
			path
				.replace(/[\\/]+$/, "")
				.split(/[\\/]/)
				.at(-1) || path;
		const key = card.name === "read" ? "readFile" : card.name === "write" ? "writeFile" : "editFile";
		return workProcessText(key, { name });
	}
	if (card.name === "bash" || card.name === "powershell") {
		const command = typeof args?.command === "string" ? args.command.trim() : "";
		if (/^npm[ \t]+run[ \t]+check$/.test(command)) return workProcessText("runCheck");
		const summary = card.summary.trim();
		if (summary && summary !== card.name && summary !== "运行命令" && summary !== "Run command") return summary;
		return command ? summarizeToolCall(card.name, args).summary : card.summary || workProcessText("runCommand");
	}
	if (["read", "write", "edit", "find", "grep", "ls"].includes(card.name) && args)
		return summarizeToolCall(card.name, args).summary;
	return card.summary || card.name;
}

/** These are execution outcomes, never an inferred verdict on the user's task. */
export function workActionStatus(card: ToolCard): string {
	return workProcessText(
		card.status === "ok"
			? "succeeded"
			: card.status === "error"
				? "failed"
				: card.status === "cancelled"
					? "cancelled"
					: card.status === "pending"
						? "pending"
						: "working",
	);
}

/** Facts are scoped to the supplied work segment; prose and unrelated successes never resolve failures. */
export function workActionFacts(actions: readonly WorkAction[]): {
	current?: WorkAction;
	recent: WorkAction[];
	issues: WorkAction[];
	recovered: WorkAction[];
} {
	const current =
		actions.findLast(({ card }) => card.status === "running" && card.finishedAt === undefined) ??
		actions.findLast(({ card }) => card.status === "pending" && card.finishedAt === undefined);
	const recent = actions.filter(({ card }) => ["ok", "error", "cancelled"].includes(card.status)).slice(-3);
	const issues: WorkAction[] = [];
	const recovered: WorkAction[] = [];
	const laterSuccesses = new Set<string>();
	for (let index = actions.length - 1; index >= 0; index--) {
		const action = actions[index]!;
		const card = action.card;
		if (card.status !== "error" && card.status !== "ok") continue;
		const args = argumentsOf(card.args);
		const encoded = args === undefined ? undefined : canonicalJson(args);
		const operation = encoded === undefined ? undefined : JSON.stringify([action.scope, card.name, encoded]);
		if (card.status === "ok") {
			if (operation !== undefined) laterSuccesses.add(operation);
		} else if (operation !== undefined && laterSuccesses.has(operation)) {
			recovered.push(action);
		} else if (!isInvalidToolCall(card.output?.text)) {
			// 调用本身无效（工具不存在、参数没通过校验）是模型的探索与自我修正，不是任务失败：
			// 下一次调用就会用对的工具或对的参数，不该在界面上留下「失败记录」。
			issues.push(action);
		}
	}
	return { current, recent, issues: issues.reverse(), recovered: recovered.reverse() };
}
