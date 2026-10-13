import { resolveSurfaceTheme } from "../../owl-appearance.ts";

type ManagerTheme = "dark" | "light";

interface ThemeMessageEvent {
	origin: string;
	source: unknown;
	data: unknown;
}

interface ThemeHost {
	addEventListener(type: "message", listener: (event: ThemeMessageEvent) => void): void;
	addEventListener(type: "owl-theme-change", listener: () => void): void;
	removeEventListener(type: "message", listener: (event: ThemeMessageEvent) => void): void;
	removeEventListener(type: "owl-theme-change", listener: () => void): void;
	getComputedStyle(surface: Element): Pick<CSSStyleDeclaration, "getPropertyValue">;
}

interface ThemeFrame {
	postMessage(data: unknown, targetOrigin: string): void;
}

/** Bootstrap the embedded manager before its first theme handshake. */
export function managerFrameUrl(managerUrl: string, hostOrigin: string, theme: ManagerTheme): string {
	const url = new URL(managerUrl);
	url.searchParams.set("owlParentOrigin", hostOrigin);
	url.searchParams.set("owlTheme", theme);
	return url.href;
}

/** Share the actual desktop palette without coupling the frame to settings persistence. */
export function attachManagerTheme(options: {
	host: ThemeHost;
	root: HTMLElement;
	surface: HTMLElement;
	managerUrl: string;
	frameWindow: () => ThemeFrame | null;
	onThemeChange: (theme: ManagerTheme) => Promise<void>;
}): { sync: () => void; dispose: () => void } {
	const origin = new URL(options.managerUrl).origin;
	let active = true;
	let scheduled = false;
	const sync = (): void => {
		if (!active) return;
		const frame = options.frameWindow();
		if (!frame) return;
		const style = options.host.getComputedStyle(options.surface);
		const color = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || style.getPropertyValue(fallback).trim();
		frame.postMessage({
			type: "owl:theme",
			theme: resolveSurfaceTheme(options.root.dataset),
			colors: {
				canvas: color("--owl-ui-canvas", "--color-owl-bg"),
				panel: color("--owl-ui-panel", "--color-owl-panel"),
				sidebar: color("--owl-ui-sidebar", "--color-owl-sidebar"),
				hover: color("--owl-ui-hover", "--color-owl-hover"),
				border: color("--owl-ui-border", "--color-owl-border"),
				text: color("--owl-ui-text", "--color-owl-text"),
				muted: color("--owl-ui-muted", "--color-owl-muted"),
				accent: style.getPropertyValue("--color-owl-accent").trim(),
				accentHover: style.getPropertyValue("--color-owl-accent-hover").trim(),
			},
		}, origin);
	};
	const scheduleSync = (): void => {
		if (!active || scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			sync();
		});
	};
	const listener = (event: ThemeMessageEvent): void => {
		const frame = options.frameWindow();
		if (!active || !frame || event.source !== frame || event.origin !== origin) return;
		if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
		const data = event.data as Record<string, unknown>;
		if (data.type === "owl:theme:request") {
			sync();
		} else if (data.type === "owl:theme:set" && (data.theme === "dark" || data.theme === "light")) {
			const theme = data.theme;
			void Promise.resolve().then(() => { if (active) return options.onThemeChange(theme); }).then(sync, sync);
		}
	};
	const observer = new MutationObserver(scheduleSync);
	observer.observe(options.root, { attributes: true, attributeFilter: ["data-owl-theme", "data-owl-preset", "data-owl-wallpaper", "data-owl-glass-theme", "style"] });
	const shell = options.surface.closest(".owl-desktop-shell");
	if (shell && shell !== options.root) observer.observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
	options.host.addEventListener("message", listener);
	options.host.addEventListener("owl-theme-change", scheduleSync);
	sync();
	return {
		sync,
		dispose: () => {
			active = false;
			scheduled = false;
			observer.disconnect();
			options.host.removeEventListener("message", listener);
			options.host.removeEventListener("owl-theme-change", scheduleSync);
		},
	};
}
