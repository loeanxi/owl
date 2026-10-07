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
		? Math.min(CONVERSATION_MIN_WIDTH + WORKBENCH_MIN_WIDTH, Math.max(CONVERSATION_MIN_WIDTH, available - SIDEBAR_MIN_WIDTH))
		: CONVERSATION_MIN_WIDTH;
	return fitPaneSize(SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, available, reserve);
}

export function workbenchDock(requested: "right" | "bottom", availableWidth: number): "right" | "bottom" {
	return requested === "right" && availableWidth < CONVERSATION_MIN_WIDTH + WORKBENCH_MIN_WIDTH ? "bottom" : requested;
}
