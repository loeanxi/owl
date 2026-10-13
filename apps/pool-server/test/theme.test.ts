import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const origin = "http://127.0.0.1:18901";
const colors = {
	canvas: "#1e1e1e",
	panel: "#252525",
	sidebar: "#191919",
	hover: "#343434",
	border: "#3d3d3d",
	text: "#e8e8e8",
	muted: "#909090",
	accent: "#4d9aff",
	accentHover: "#6babff",
};

function page(
	options: {
		embedded?: boolean;
		search?: string;
		stored?: string;
		storageDisabled?: boolean;
		session?: Map<string, string>;
	} = {},
) {
	const dataset: Record<string, string> = { theme: "dark" };
	const variables = new Map<string, string>();
	const attributes = new Map<string, string>();
	const listeners = new Map<string, (event: unknown) => void>();
	const documentListeners = new Map<string, () => void>();
	const buttonListeners = new Map<string, () => void>();
	const stored = new Map<string, string>([["loean-ui-theme", options.stored ?? "light"]]);
	const session = options.session ?? new Map<string, string>();
	const posted: Array<{ data: unknown; origin: string }> = [];
	const dispatched: Array<{ type: string; detail: unknown }> = [];
	const icon = { textContent: "" };
	const label = { textContent: "" };
	const parent = {
		postMessage(data: unknown, targetOrigin: string) {
			posted.push({ data, origin: targetOrigin });
		},
	};
	const browser: Record<string, unknown> = {
		parent,
		location: { search: options.search ?? `?owlParentOrigin=${encodeURIComponent(origin)}&owlTheme=dark` },
		localStorage: {
			getItem(key: string) {
				if (options.storageDisabled) throw new Error("storage unavailable");
				return stored.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				if (options.storageDisabled) throw new Error("storage unavailable");
				stored.set(key, value);
			},
		},
		sessionStorage: {
			getItem: (key: string) => session.get(key) ?? null,
			setItem: (key: string, value: string) => session.set(key, value),
		},
		addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
		dispatchEvent: (event: { type: string; detail: unknown }) => dispatched.push(event),
	};
	if (options.embedded === false) browser.parent = browser;
	const context = createContext({
		window: browser,
		localStorage: browser.localStorage,
		URL,
		URLSearchParams,
		CSS: { supports: (_property: string, value: string) => /^#[0-9a-f]{6}$/i.test(value) },
		CustomEvent: class {
			type: string;
			detail: unknown;
			constructor(type: string, options: { detail: unknown }) {
				this.type = type;
				this.detail = options.detail;
			}
		},
		document: {
			readyState: "loading",
			documentElement: {
				dataset,
				style: { setProperty: (name: string, value: string) => variables.set(name, value) },
			},
			addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
			createElement: () => {
				const context = {
					fillStyle: "#000000",
					fillRect: () => {},
					getImageData: () => ({
						data: [
							...[1, 3, 5].map((offset) => Number.parseInt(context.fillStyle.slice(offset, offset + 2), 16)),
							255,
						],
					}),
				};
				return { getContext: () => context };
			},
			querySelectorAll: () => [
				{
					setAttribute: (name: string, value: string) => attributes.set(name, value),
					querySelector: (selector: string) => (selector === "[data-theme-icon]" ? icon : label),
					addEventListener: (type: string, listener: () => void) => buttonListeners.set(type, listener),
				},
			],
		},
	});
	runInContext(readFileSync(new URL("../public/theme.js", import.meta.url), "utf8"), context);
	documentListeners.get("DOMContentLoaded")?.();
	return {
		dataset,
		variables,
		attributes,
		stored,
		session,
		posted,
		dispatched,
		icon,
		label,
		click: () => buttonListeners.get("click")?.(),
		receive: (data: unknown, overrides: { origin?: string; source?: unknown } = {}) =>
			listeners.get("message")?.({ origin, source: parent, data, ...overrides }),
	};
}

describe("embedded Owl manager appearance", () => {
	it("starts in the host mode before applying CSS and requests the host palette", () => {
		const current = page();
		expect(current.dataset.theme).toBe("dark");
		expect(current.posted).toEqual([{ data: { type: "owl:theme:request" }, origin }]);
		expect(current.attributes.get("aria-pressed")).toBe("false");
	});
	it("applies every host color and refreshes theme-dependent effects without writing standalone preferences", () => {
		const current = page({ stored: "dark" });
		current.receive({ type: "owl:theme", theme: "light", colors });
		expect(current.dataset).toEqual({ theme: "light", owlEmbedded: "true" });
		expect(Object.fromEntries(current.variables)).toEqual({
			"--owl-canvas": colors.canvas,
			"--owl-panel": colors.panel,
			"--owl-sidebar": colors.sidebar,
			"--owl-hover": colors.hover,
			"--owl-border": colors.border,
			"--owl-text": colors.text,
			"--owl-muted": colors.muted,
			"--owl-accent": colors.accent,
			"--owl-accent-hover": colors.accentHover,
			"--on-accent": "#111111",
		});
		expect(current.stored.get("loean-ui-theme")).toBe("dark");
		expect(current.dispatched).toEqual([{ type: "loean:themechange", detail: { theme: "light" } }]);
		expect(current.attributes.get("aria-pressed")).toBe("true");
		expect(current.label.textContent).toBe("深色");
	});
	it("requests a host theme change and waits for the persisted host response", () => {
		const current = page({ stored: "dark" });
		current.receive({ type: "owl:theme", theme: "dark", colors });
		current.click();
		expect(current.posted.at(-1)).toEqual({ data: { type: "owl:theme:set", theme: "light" }, origin });
		expect(current.dataset.theme).toBe("dark");
		current.receive({ type: "owl:theme", theme: "light", colors });
		expect(current.dataset.theme).toBe("light");
		expect(current.stored.get("loean-ui-theme")).toBe("dark");
	});
	it("replaces the palette when Owl changes presets or its custom accent", () => {
		const current = page();
		current.receive({ type: "owl:theme", theme: "dark", colors });
		current.receive({ type: "owl:theme", theme: "dark", colors: { ...colors, accent: "#ee4488", panel: "#302020" } });
		expect(current.variables.get("--owl-accent")).toBe("#ee4488");
		expect(current.variables.get("--owl-panel")).toBe("#302020");
	});
	it.each([
		{ accent: "#50a992", foreground: "#111111" },
		{ accent: "#4d9aff", foreground: "#111111" },
		{ accent: "#eeee55", foreground: "#111111" },
		{ accent: "#124f2d", foreground: "#ffffff" },
		{ accent: "#787878", foreground: "#000000" },
	])("keeps action labels readable on custom accent $accent", ({ accent, foreground }) => {
		const current = page();
		current.receive({ type: "owl:theme", theme: "dark", colors: { ...colors, accent } });
		expect(current.variables.get("--on-accent")).toBe(foreground);
	});
	it("continues host synchronization after a same-frame navigation that drops the query", () => {
		const initial = page();
		initial.receive({ type: "owl:theme", theme: "light", colors });
		const navigated = page({ search: "", session: initial.session, stored: "dark" });
		expect(navigated.dataset.theme).toBe("light");
		expect(navigated.posted).toEqual([{ data: { type: "owl:theme:request" }, origin }]);
		navigated.receive({ type: "owl:theme", theme: "light", colors });
		expect(navigated.variables.get("--owl-accent")).toBe(colors.accent);
	});
	it.each([{ origin: "https://other.example" }, { source: {} }])(
		"ignores messages from another source or origin: %j",
		(overrides) => {
			const current = page();
			current.receive({ type: "owl:theme", theme: "light", colors }, overrides);
			expect(current.variables.size).toBe(0);
			expect(current.dataset).toEqual({ theme: "dark" });
		},
	);
	it.each([
		{ type: "owl:theme", theme: "system", colors },
		{ type: "owl:theme", theme: "light", colors: { canvas: "#ffffff" } },
		{ type: "owl:theme", theme: "light", colors: { ...colors, accent: "url(https://other.example/)" } },
		{ type: "other:theme", theme: "light", colors },
	])("rejects invalid messages before changing any state: %j", (data) => {
		const current = page();
		current.receive(data);
		expect(current.variables.size).toBe(0);
		expect(current.dataset).toEqual({ theme: "dark" });
		expect(current.dispatched).toHaveLength(0);
	});
});

describe("standalone loean appearance", () => {
	it.each([{ embedded: false }, { search: "" }])(
		"keeps local theme switching without an Owl connection: %j",
		(options) => {
			const current = page(options);
			expect(current.dataset.theme).toBe("light");
			current.click();
			expect(current.dataset.theme).toBe("dark");
			expect(current.stored.get("loean-ui-theme")).toBe("dark");
			expect(current.posted).toHaveLength(0);
		},
	);
	it("can toggle even when local storage is unavailable", () => {
		const current = page({ embedded: false, storageDisabled: true });
		current.click();
		expect(current.dataset.theme).toBe("light");
		expect(current.attributes.get("aria-pressed")).toBe("true");
	});
	it("ignores the inherited embed session when opened as a standalone page", () => {
		const initial = page();
		const standalone = page({ embedded: false, search: "", session: initial.session, stored: "light" });
		expect(standalone.dataset.theme).toBe("light");
		expect(standalone.posted).toHaveLength(0);
	});
});
