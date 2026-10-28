/** All sizes are CSS pixels in the pane's actual parent, not the desktop viewport. */
export const CONVERSATION_MIN_WIDTH = 320;
export const WORKBENCH_MIN_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 720;
export const WORKBENCH_MIN_HEIGHT = 140;
export const CONVERSATION_MIN_HEIGHT = 180;

/** Fit a saved preference without replacing it; widening the container restores it. */
export function fitPaneSize(preferred: number, minimum: number, available: number, reserve: number): number {
	const space = Number.isFinite(available) ? Math.max(0, available) : 0;
	const maximum = Math.max(0, space - reserve);
	const value = Number.isFinite(preferred) ? preferred : minimum;
	return Math.min(Math.max(value, Math.min(minimum, maximum)), maximum);
}

/** Leave room for both chat and tools whenever three columns can fit. */
export function sidebarWidthLimit(available: number, toolsVisible = true): number {
	const reserve = toolsVisible
		? Math.min(
				CONVERSATION_MIN_WIDTH + WORKBENCH_MIN_WIDTH,
				Math.max(CONVERSATION_MIN_WIDTH, available - SIDEBAR_MIN_WIDTH),
			)
		: CONVERSATION_MIN_WIDTH;
	return fitPaneSize(SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, available, reserve);
}

/** 工作台停靠判定的工作区宽度下限：侧栏下限 + 对话下限 + 工作台下限。 */
/** 侧栏挤不下时它会塌成抽屉（不占位），工作区宽度因此变大——停靠判定必须用工作区
 *  宽度（不受塌陷影响的那个），否则侧栏一塌，工作台就从右栏跳到底排，拖边框时整窗重排。 */
export const WORKBENCH_DOCK_MIN_WIDTH = SIDEBAR_MIN_WIDTH + CONVERSATION_MIN_WIDTH + WORKBENCH_MIN_WIDTH;

/** 工作台停哪边：requested=right 且工作区放不下三栏时叠到底部。 */
export function workbenchDock(requested: "right" | "bottom", workspaceWidth: number): "right" | "bottom" {
	return requested === "right" && workspaceWidth < WORKBENCH_DOCK_MIN_WIDTH ? "bottom" : requested;
}
