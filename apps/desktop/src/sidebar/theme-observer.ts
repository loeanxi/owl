export interface WorkbenchPalette {
	theme: "dark" | "light";
	canvas: string;
	panel: string;
	text: string;
	muted: string;
	border: string;
	accent: string;
}

/** Read the scoped desktop palette, including preset and custom overrides. */
export function readWorkbenchPalette(
	style: Pick<CSSStyleDeclaration, "getPropertyValue">,
	theme: "dark" | "light",
): WorkbenchPalette {
	const light = theme === "light";
	const color = (names: readonly string[], fallback: string): string => {
		for (const name of names) {
			const value = style.getPropertyValue(name).trim();
			if (value) return value;
		}
		return fallback;
	};
	return {
		theme,
		canvas: color(["--workbench-canvas", "--owl-ui-canvas", "--color-owl-bg"], light ? "#fafbf9" : "#202321"),
		panel: color(["--workbench-panel", "--owl-ui-panel", "--color-owl-panel"], light ? "#ffffff" : "#282d29"),
		text: color(["--workbench-text", "--owl-ui-text", "--color-owl-text"], light ? "#3d3a32" : "#e9e7e0"),
		muted: color(["--workbench-muted", "--owl-ui-muted", "--color-owl-muted"], light ? "#66726a" : "#969f97"),
		border: color(["--workbench-border", "--owl-ui-border", "--color-owl-border"], light ? "#e0e5df" : "#343c35"),
		accent: color(["--color-owl-accent"], "#2f9e5a"),
	};
}

/** Imperative renderers need notification after the theme's CSS variables settle. */
export function observeWorkbenchTheme(surface: HTMLElement, onChange: () => void): () => void {
	let active = true;
	let scheduled = false;
	const sync = (): void => {
		if (!active || scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (active) onChange();
		});
	};
	const observer = new MutationObserver(sync);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-owl-theme", "data-owl-preset", "data-owl-wallpaper", "data-owl-glass-theme", "style"],
	});
	const shell = surface.closest(".owl-desktop-shell");
	if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
	window.addEventListener("owl-theme-change", sync);
	window.addEventListener("owl-appearance-change", sync);
	return () => {
		active = false;
		observer.disconnect();
		window.removeEventListener("owl-theme-change", sync);
		window.removeEventListener("owl-appearance-change", sync);
	};
}
export { resolveSurfaceTheme } from "../owl-appearance.ts";
