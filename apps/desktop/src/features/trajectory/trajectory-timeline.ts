/**
 * 轨迹时间轴投影 —— 把折叠出的单元格投影成稳定的三车道时间轴。
 *
 * 对应 DSH ui-trajectory 的 timeline.ts：`sequence` 模式按事件序数等宽排布
 * （节奏图），`actual` 模式按真实墙钟投影（时序图）。车道固定：
 * 输入=用户输入，模型=助手回复，工具=工具调用（含子调用）。
 */
import type { TrajectoryCell, TrajectoryCellKind, TrajectoryTurnModel } from "./trajectory-contract.ts";

/** 时间轴使用的横向投影模式。 */
export type TrajectoryTimelineMode = "sequence" | "actual";

/** 时间轴域内的一段 span（台账单元格的投影，反向携带源单元格供搜索/提示用）。 */
export interface TrajectoryTimelineSpan {
	/** 对应台账单元格的 index。 */
	index: number;
	/** 对应台账行的锚点 id。 */
	recordId: string;
	/** 投影源单元格（搜索匹配、hover 提示直接取数）。 */
	cell: TrajectoryCell;
	kind: TrajectoryCellKind;
	label: string;
	/** 车道：0=输入 1=模型 2=工具。 */
	lane: number;
	start: number;
	end: number;
	isError: boolean;
	isActive: boolean;
}

/** 轮次分界（第 N 轮起点在当前投影域的位置）。 */
export interface TrajectoryTimelineTurnBoundary {
	turn: number;
	position: number;
}

/** 时间轴完整模型：投影域 + 全部 span + 轮次分界。 */
export interface TrajectoryTimelineModel {
	start: number;
	end: number;
	spans: readonly TrajectoryTimelineSpan[];
	turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}

function laneFor(kind: TrajectoryCellKind): number {
	if (kind === "tool" || kind === "subtool") return 2;
	if (kind === "message") return 1;
	return 0;
}

function finite(value: number | null): value is number {
	return value !== null && Number.isFinite(value);
}

function cellRange(cell: TrajectoryCell): { start: number; end: number } | null {
	if (!finite(cell.startedAt)) return null;
	const durationMs = finite(cell.timeSeconds) ? Math.max(0, cell.timeSeconds * 1000) : 0;
	return { start: cell.startedAt, end: cell.startedAt + durationMs };
}

function spanOf(cell: TrajectoryCell, start: number, end: number): TrajectoryTimelineSpan {
	return {
		index: cell.index,
		recordId: cell.recordId,
		cell,
		kind: cell.kind,
		label: cell.kind === "user" || cell.kind === "message" ? cell.title : cell.summary ?? cell.title,
		lane: laneFor(cell.kind),
		start,
		end,
		isError: cell.isError === true,
		isActive: cell.streaming === true,
	};
}

/**
 * 把全部轮次的可见单元格投影成三车道时间轴。
 * @param turns 轨迹折叠（未过滤）。
 * @param mode sequence=等宽节奏图；actual=真实墙钟。
 * @returns 时间轴模型；没有任何可投影的记录时为 null。
 */
export function deriveTrajectoryTimeline(
	turns: readonly TrajectoryTurnModel[],
	mode: TrajectoryTimelineMode = "sequence",
): TrajectoryTimelineModel | null {
	if (mode === "sequence") {
		const spans: TrajectoryTimelineSpan[] = [];
		const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
		let position = 0;
		for (const turn of turns) {
			const turnCells = turn.groups.flatMap((group) => group.cells);
			if (turnCells.length === 0) continue;
			turnBoundaries.push({ turn: turn.turn, position });
			for (const cell of turnCells) {
				spans.push(spanOf(cell, position, position + 1));
				position += 1;
			}
		}
		if (spans.length === 0) return null;
		return { start: 0, end: position, spans, turnBoundaries };
	}

	const spans = turns
		.flatMap((turn) => turn.groups.flatMap((group) => group.cells))
		.flatMap((cell): TrajectoryTimelineSpan[] => {
			const range = cellRange(cell);
			return range === null ? [] : [spanOf(cell, range.start, range.end)];
		});
	if (spans.length === 0) return null;
	// 流式中只有开始时刻的 span 至少给 1ms 宽度，保证可点可看。
	for (const span of spans) span.end = Math.max(span.end, span.start + 1);
	return {
		start: Math.min(...spans.map((span) => span.start)),
		end: Math.max(...spans.map((span) => span.end)),
		spans,
		turnBoundaries: turns.flatMap((turn) => {
			const positions = turn.groups.flatMap((group) =>
				group.cells.flatMap((cell) => (finite(cell.startedAt) ? [cell.startedAt] : [])),
			);
			return positions.length === 0 ? [] : [{ turn: turn.turn, position: Math.min(...positions) }];
		}),
	};
}
