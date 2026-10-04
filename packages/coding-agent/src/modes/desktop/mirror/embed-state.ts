/**
 * 窗口嵌入状态机（owl Mirror 短剧卡）：嵌入生命周期与三形态切换的纯 reducer。
 *
 * UI 侧持有状态并派发 action，reducer 返回新状态与要应用到窗口上的效果序列
 * （embed/relayout/hide/show/restore），由调用方翻译成 worker 命令。纯函数、
 * 可整体单测；效果只描述「做什么」，不携带几何信息（几何由调用方按当前舞台
 * 计算，见 embed-layout.ts）。
 *
 * 规则要点：
 * - 隐藏中切模式/拖放悬浮矩形只更新状态，不发效果（show 时一并生效）；
 * - 还原（restore）只对已嵌入状态有意义，其余情况无效果；
 * - 窗口消失（windowGone）直接回 restored 且不发还原效果 —— 窗口已不存在。
 */
import type { Rect } from "./embed-layout.ts";
import type { EmbedMode } from "./embed-layout.ts";

export type EmbedState =
	| { phase: "restored" }
	| {
			phase: "embedded";
			mode: EmbedMode;
			visible: boolean;
			/** float 模式的用户矩形（父客户区物理像素）；其他模式为空。 */
			floatRect?: Rect;
	  };

export type EmbedEffect =
	| { kind: "embed"; mode: EmbedMode }
	| { kind: "relayout"; mode: EmbedMode }
	| { kind: "hide" }
	| { kind: "show" }
	| { kind: "restore" };

export type EmbedAction =
	| { type: "embed"; mode: EmbedMode }
	| { type: "setMode"; mode: EmbedMode }
	| { type: "setVisible"; visible: boolean }
	| { type: "setFloatRect"; rect: Rect }
	| { type: "restore" }
	| { type: "windowGone" };

export interface EmbedReduction {
	state: EmbedState;
	effects: EmbedEffect[];
}

export function createEmbedReducer(): {
	(state: EmbedState, action: EmbedAction): EmbedReduction;
	effectsOf: () => EmbedEffect[];
} {
	let lastEffects: EmbedEffect[] = [];
	const reducer = (state: EmbedState, action: EmbedAction): EmbedReduction => {
		const effects: EmbedEffect[] = [];
		let next = state;

		if (action.type === "embed") {
			if (state.phase === "embedded" && state.mode === action.mode) {
				next = state;
			} else if (state.phase === "embedded") {
				next = { ...state, mode: action.mode };
				effects.push({ kind: "relayout", mode: action.mode });
			} else {
				next = { phase: "embedded", mode: action.mode, visible: true };
				effects.push({ kind: "embed", mode: action.mode });
			}
		} else if (action.type === "setMode") {
			if (state.phase === "embedded" && state.mode !== action.mode) {
				next = { ...state, mode: action.mode };
				if (state.visible) effects.push({ kind: "relayout", mode: action.mode });
			} else {
				next = state;
			}
		} else if (action.type === "setVisible") {
			if (state.phase === "embedded" && state.visible !== action.visible) {
				next = { ...state, visible: action.visible };
				effects.push({ kind: action.visible ? "show" : "hide" });
			} else {
				next = state;
			}
		} else if (action.type === "setFloatRect") {
			if (state.phase === "embedded" && state.mode === "float") {
				next = { ...state, floatRect: action.rect };
				if (state.visible) effects.push({ kind: "relayout", mode: "float" });
			} else {
				next = state;
			}
		} else if (action.type === "restore") {
			if (state.phase === "embedded") {
				next = { phase: "restored" };
				effects.push({ kind: "restore" });
			} else {
				next = state;
			}
		} else {
			// windowGone：窗口已不存在，无需还原效果
			next = { phase: "restored" };
		}

		lastEffects = effects;
		return { state: next, effects };
	};
	return Object.assign(reducer, {
		effectsOf: (): EmbedEffect[] => lastEffects,
	});
}
