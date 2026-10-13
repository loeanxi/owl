import type { WorkbenchPalette } from "../theme-observer.ts";

export const HTML_PREVIEW_THEME_MESSAGE = "owl:document-theme";

/** Sandboxed srcDoc frames have an opaque origin, so only the parent may update defaults. */
export function htmlPreviewThemeScript(palette: WorkbenchPalette): string {
	const initial = JSON.stringify(palette).replaceAll("<", "\\u003c");
	return `(() => {
		const apply = (palette) => {
			if (!palette || (palette.theme !== "dark" && palette.theme !== "light")) return;
			const style = document.documentElement.style;
			style.setProperty("--owl-preview-scheme", palette.theme);
			for (const key of ["canvas", "panel", "text", "muted", "border", "accent"]) {
				if (typeof palette[key] === "string" && CSS.supports("color", palette[key])) style.setProperty("--owl-preview-" + key, palette[key]);
			}
		};
		apply(${initial});
		window.addEventListener("message", (event) => {
			if (event.source === parent && event.data?.type === "${HTML_PREVIEW_THEME_MESSAGE}") apply(event.data.palette);
		});
	})();`;
}

/** Defaults have zero specificity: an artifact's authored colors keep their precedence. */
export function themedHtmlPreview(content: string, palette: WorkbenchPalette): string {
	const parsed = new DOMParser().parseFromString(content, "text/html");
	const style = parsed.createElement("style");
	style.textContent = `
		:where(html) { color-scheme: var(--owl-preview-scheme); background: var(--owl-preview-canvas); color: var(--owl-preview-text); }
		:where(body) { background: transparent; color: inherit; }
		:where(a) { color: var(--owl-preview-accent); }
		:where(input, select, textarea, button) { color: inherit; background-color: inherit; border-color: var(--owl-preview-border); }
		:where(pre) { background: var(--owl-preview-panel); }
	`;
	const script = parsed.createElement("script");
	script.textContent = htmlPreviewThemeScript(palette);
	parsed.head.prepend(style, script);
	const doctype = parsed.doctype ? new XMLSerializer().serializeToString(parsed.doctype) : "";
	return `${doctype}\n${parsed.documentElement.outerHTML}`;
}
