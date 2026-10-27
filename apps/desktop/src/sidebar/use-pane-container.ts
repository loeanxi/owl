import { useLayoutEffect, useState, type RefObject } from "react";

interface PaneContainerSize {
	width: number;
	height: number;
	/**
	 * 工作区宽度（含侧栏那一层）。
	 *
	 * 侧栏挤不下时塌成抽屉、不再占位，内容区宽度会因此涨一截——只有工作区宽度
	 * 不变。布局的稳定判定（工作台停哪边）必须用它，否则侧栏一塌、工作台就从
	 * 右栏跳到底排，拖窗口边框时整窗重排。
	 */
	workspaceWidth: number;
	toolsVisible: boolean;
	terminalVisible: boolean;
}

/** Measure the actual parent content box; the workspace frame excludes the rail and outer border. */
export function usePaneContainer(ref: RefObject<HTMLElement | null>, sidebar = false): PaneContainerSize | null {
	const [size, setSize] = useState<PaneContainerSize | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		const parent = element?.parentElement;
		if (!element || !parent) return;
		// 工作区框：侧栏与内容区的共同父级。侧栏塌陷时它不动。
		const workspace = element.closest(".owl-workspace-frame") ?? parent;
		const tools = sidebar ? parent.querySelector<HTMLElement>('.owl-shell-content > .owl-workbench-shell') : null;
		const terminal = sidebar ? null : parent.querySelector<HTMLElement>('.owl-shell-content-main > .owl-workbench-shell[data-layout="terminal"]');
		const measure = (): void => {
			const next = {
				width: parent.clientWidth, height: parent.clientHeight,
				workspaceWidth: workspace.clientWidth,
				toolsVisible: Boolean(tools?.getClientRects().length), terminalVisible: Boolean(terminal?.getClientRects().length),
			};
			setSize((current) => current?.width === next.width && current.height === next.height && current.workspaceWidth === next.workspaceWidth && current.toolsVisible === next.toolsVisible && current.terminalVisible === next.terminalVisible ? current : next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		observer.observe(element);
		observer.observe(workspace);
		if (tools) observer.observe(tools);
		if (terminal) observer.observe(terminal);
		return () => observer.disconnect();
	}, [ref, sidebar]);
	return size;
}
