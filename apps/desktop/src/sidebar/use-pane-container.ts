import { useLayoutEffect, useState, type RefObject } from "react";

interface PaneContainerSize {
	width: number;
	height: number;
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
		const tools = sidebar ? parent.querySelector<HTMLElement>('.owl-shell-content > .owl-workbench-shell') : null;
		const terminal = sidebar ? null : parent.querySelector<HTMLElement>('.owl-shell-content-main > .owl-workbench-shell[data-layout="terminal"]');
		const measure = (): void => {
			const next = {
				width: parent.clientWidth, height: parent.clientHeight,
				toolsVisible: Boolean(tools?.getClientRects().length), terminalVisible: Boolean(terminal?.getClientRects().length),
			};
			setSize((current) => current?.width === next.width && current.height === next.height && current.toolsVisible === next.toolsVisible && current.terminalVisible === next.terminalVisible ? current : next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		observer.observe(element);
		if (tools) observer.observe(tools);
		if (terminal) observer.observe(terminal);
		return () => observer.disconnect();
	}, [ref, sidebar]);
	return size;
}
