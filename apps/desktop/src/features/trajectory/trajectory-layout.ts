/**
 * 轨迹折叠层 —— 把会话转录（ChatEntry[]）折叠成 轮次 → 分组 → 单元格。
 *
 * 对应 DSH ui-trajectory 的 layout.ts（deriveTrajectoryLayout）：ToolCard
 * 挂在 assistant 行上，展开成 message cell + tool cell；工具自持耗时来自
 * startedAt/finishedAt，回复耗时来自 endedAt - timestamp；分组描述输出
 * 墙钟跨度 + 工具直方图（`2.3s bash×6`）。进行中的调用不虚构耗时。
 */
import type { ChatEntry, ToolCard } from "../../hooks/transcript.ts";
import { t } from "../../i18n/index.ts";
import type {
	TrajectoryCell,
	TrajectoryCellKind,
	TrajectoryGroupModel,
	TrajectorySnapshot,
	TrajectoryStats,
	TrajectoryTurnModel,
	TrajectoryUsage,
} from "./trajectory-contract.ts";

interface LaidCell {
	cell: TrajectoryCell;
}

interface LaidGroup {
	title: string;
	laid: LaidCell[];
}

interface TurnBucket {
	groups: LaidGroup[];
	laid: LaidCell[];
}

const EMPTY_USAGE: TrajectoryUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function finiteTime(time: number | null | undefined): number | null {
	return typeof time === "number" && Number.isFinite(time) && time > 0 ? time : null;
}

/** 两个 epoch ms 之间的自身耗时（秒）；任一不可用即 null。 */
function durationSeconds(later: number | null, earlier: number | null): number | null {
	if (earlier === null || later === null) return null;
	return Math.max(0, (later - earlier) / 1000);
}

/**
 * 分组描述：墙钟跨度 + 工具直方图，如 `2.3s bash×6 read×2`。
 * 工具行贡献 start（startedAt）与 end（start + 自身耗时），
 * 所以单个工具行也能撑起组的墙钟。
 */
function groupDescription(cells: readonly TrajectoryCell[]): string | undefined {
	const parts: string[] = [];
	const times: number[] = [];
	for (const cell of cells) {
		const start = finiteTime(cell.startedAt);
		if (start === null) continue;
		times.push(start);
		if (cell.kind !== "user" && cell.timeSeconds !== null) times.push(start + cell.timeSeconds * 1000);
	}
	if (times.length >= 2) {
		parts.push(formatSpanSeconds((Math.max(...times) - Math.min(...times)) / 1000));
	} else if (times.length === 1) {
		const own = cells.find((cell) => cell.startedAt === times[0])?.timeSeconds;
		if (own !== null && own !== undefined) parts.push(formatSpanSeconds(own));
	}
	const tools = new Map<string, number>();
	for (const cell of cells) {
		if (cell.kind !== "tool" && cell.kind !== "subtool") continue;
		tools.set(cell.title, (tools.get(cell.title) ?? 0) + 1);
	}
	for (const [name, count] of tools) parts.push(count > 1 ? `${name}×${count}` : name);
	return parts.length === 0 ? undefined : parts.join(" ");
}

/** 时长 humanize：ms → `870ms` / `1.5s` / `2m 9s` / `2h 51m`。 */
export function formatSpanSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0s";
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return `${minutes}m ${rest}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function prettyArgs(args: string): string | undefined {
	if (args === "") return undefined;
	try {
		return JSON.stringify(JSON.parse(args), null, 2);
	} catch {
		return args;
	}
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function usageTotal(usage: TrajectoryUsage | undefined): number {
	if (usage === undefined) return 0;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function addUsage(into: TrajectoryUsage, usage: TrajectoryUsage | undefined): void {
	if (usage === undefined) return;
	into.input += usage.input;
	into.output += usage.output;
	into.cacheRead += usage.cacheRead;
	into.cacheWrite += usage.cacheWrite;
}

function cellFromToolCard(card: ToolCard, index: number): TrajectoryCell {
	const startedAt = finiteTime(card.startedAt);
	const endedAt = finiteTime(card.finishedAt);
	const kind: TrajectoryCellKind = card.parentToolCallId !== undefined ? "subtool" : "tool";
	const argsDetail = prettyArgs(card.args);
	const output = card.output?.text ?? "";
	return {
		index,
		kind,
		recordId: `tool\u0000${card.id}`,
		title: card.name,
		...(card.summary !== "" ? { summary: card.summary } : {}),
		...(card.args !== "" ? { preview: card.args } : {}),
		...(argsDetail !== undefined ? { inputDetail: argsDetail } : {}),
		...(output !== "" ? { outputDetail: output, resultPreview: firstLine(output) } : {}),
		isError: card.status === "error" || undefined,
		cancelled: card.status === "cancelled" || undefined,
		streaming: (card.status === "pending" || card.status === "running") || undefined,
		timeSeconds: durationSeconds(endedAt, startedAt),
		startedAt,
		endedAt,
	};
}

/**
 * 折叠转录成轨迹快照。
 * 轮次切分：第一条用户消息开启第 1 轮，其后每条「已落盘」的用户消息
 * （queued !== true）切开新轮；排队中的跟进留在当前轮。
 */
export function deriveTrajectoryLayout(entries: readonly ChatEntry[]): TrajectorySnapshot {
	const buckets: TurnBucket[] = [];
	let current: TurnBucket | undefined;
	let stepInTurn = 0;
	let index = 0;
	const tokens: TrajectoryUsage = { ...EMPTY_USAGE };
	let startedAll: number | null = null;
	let endedAll: number | null = null;

	const bucket = (): TurnBucket => {
		if (current === undefined) {
			current = { groups: [], laid: [] };
			buckets.push(current);
		}
		return current;
	};

	const pushMessage = (laid: LaidCell): void => {
		const entry = bucket();
		const last = entry.groups.at(-1);
		if (last?.title === t("trajectory.groupMessage")) {
			last.laid.push(laid);
			return;
		}
		entry.groups.push({ title: t("trajectory.groupMessage"), laid: [laid] });
	};

	const track = (cell: TrajectoryCell): void => {
		const start = finiteTime(cell.startedAt);
		if (start !== null) {
			startedAll = startedAll === null ? start : Math.min(startedAll, start);
			endedAll = endedAll === null ? start : Math.max(endedAll, start);
		}
		if (cell.endedAt !== null) endedAll = endedAll === null ? cell.endedAt : Math.max(endedAll, cell.endedAt);
	};

	for (const entry of entries) {
		if (entry.kind === "user") {
			if (entry.queued !== true || buckets.length === 0) {
				// 已落盘用户消息切开新轮；开场白（首轮之前没有轮）同样开轮。
				current = undefined;
				stepInTurn = 0;
			}
			const cell: TrajectoryCell = {
				index: ++index,
				kind: "user",
				recordId: `user\u0000${index}`,
				title: t("trajectory.cellUser"),
				...(entry.text !== "" ? { preview: entry.text, inputDetail: entry.text } : {}),
				timeSeconds: null,
				startedAt: finiteTime(entry.timestamp),
				endedAt: null,
			};
			track(cell);
			pushMessage({ cell });
			continue;
		}
		if (entry.kind === "toolResult") {
			// 防御兜底行：结果找不到所属工具卡时 transcript 才会产出。
			const cell: TrajectoryCell = {
				index: ++index,
				kind: "tool",
				recordId: `fallback\u0000${index}`,
				title: entry.toolName,
				...(entry.brief !== "" ? { resultPreview: entry.brief } : {}),
				isError: !entry.ok || undefined,
				timeSeconds: null,
				startedAt: null,
				endedAt: null,
			};
			track(cell);
			bucket().laid.push({ cell });
			continue;
		}

		// assistant：一条回复 = 一次 LLM 请求 = 一个步骤组（消息 cell + 工具 cells）。
		stepInTurn += 1;
		const start = finiteTime(entry.timestamp);
		const end = finiteTime(entry.endedAt);
		// 纯工具调用、没有文本/思考的回复：预览给一个占位说明，不渲染空行。
		const toolCallOnly = entry.text === "" && entry.thinking === "" && entry.tools.length > 0;
		const message: TrajectoryCell = {
			index: ++index,
			kind: "message",
			recordId: `assistant\u0000${entry.entryId ?? index}`,
			title: t("trajectory.cellAssistant"),
			...(toolCallOnly
				? { preview: t("trajectory.toolCallOnly"), summary: t("trajectory.toolCallOnly") }
				: {}),
			...(!toolCallOnly && entry.text !== "" ? { preview: entry.text, outputDetail: entry.text } : {}),
			...(entry.thinking !== "" ? { thinkingDetail: entry.thinking } : {}),
			...(entry.error !== undefined ? { isError: true, resultPreview: entry.error } : {}),
			...(entry.aborted === true ? { cancelled: true } : {}),
			timeSeconds: durationSeconds(end, start),
			startedAt: start,
			endedAt: end,
			...(usageTotal(entry.usage) > 0 ? { usage: entry.usage } : {}),
			...(entry.model !== undefined ? { model: entry.model } : {}),
		};
		addUsage(tokens, entry.usage);
		track(message);
		const stepLaid: LaidCell[] = [{ cell: message }];
		const stepBucket = bucket();
		stepBucket.laid.push(stepLaid[0]!);
		// 工具卡按 transcript 的顺序展开；codemode 子调用（parentToolCallId）跟在父调用后面。
		for (const card of orderedTools(entry.tools)) {
			const cell = cellFromToolCard(card, ++index);
			track(cell);
			const laid: LaidCell = { cell };
			stepLaid.push(laid);
			stepBucket.laid.push(laid);
		}
		stepBucket.groups.push({
			title: t("trajectory.groupStep", { step: stepInTurn }),
			laid: stepLaid,
		});
	}

	const turnModels: TrajectoryTurnModel[] = buckets.map((entry, turnIndex) => {
		const groups: TrajectoryGroupModel[] = entry.groups.map((group) => ({
			title: group.title,
			cells: group.laid.map((l) => l.cell),
			...(group.title !== t("trajectory.groupMessage") ? { description: groupDescription(group.laid.map((l) => l.cell)) } : {}),
		}));
		const times = entry.laid.flatMap((l) => {
			const start = finiteTime(l.cell.startedAt);
			return start === null ? [] : [start, l.cell.endedAt ?? start];
		});
		return {
			turn: turnIndex + 1,
			groups,
			startedAt: times.length > 0 ? Math.min(...times) : null,
			endedAt: times.length > 0 ? Math.max(...times) : null,
		};
	});

	let calls = 0;
	let steps = 0;
	for (const turn of turnModels) {
		for (const group of turn.groups) {
			for (const cell of group.cells) {
				if (cell.kind === "tool" || cell.kind === "subtool") calls += 1;
				if (cell.kind === "message") steps += 1;
			}
		}
	}

	return {
		turns: turnModels,
		stats: {
			durationMs: startedAll !== null && endedAll !== null ? Math.max(0, endedAll - startedAll) : null,
			turns: turnModels.length,
			calls,
			steps,
			tokens,
		},
	};
}

/** codemode 子调用紧跟父调用，其余保持 transcript 给定的顺序。 */
function orderedTools(tools: readonly ToolCard[]): ToolCard[] {
	const byParent = new Map<string, ToolCard[]>();
	const roots: ToolCard[] = [];
	for (const card of tools) {
		if (card.parentToolCallId !== undefined) {
			const siblings = byParent.get(card.parentToolCallId) ?? [];
			siblings.push(card);
			byParent.set(card.parentToolCallId, siblings);
		} else {
			roots.push(card);
		}
	}
	const out: ToolCard[] = [];
	for (const card of roots) {
		out.push(card);
		out.push(...(byParent.get(card.id) ?? []));
	}
	return out;
}
