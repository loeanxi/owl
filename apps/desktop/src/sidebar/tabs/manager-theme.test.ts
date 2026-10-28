import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { attachManagerTheme, managerFrameUrl } from "./manager-theme.ts";

type Theme = "dark" | "light";
interface MessageFixture {
	origin: string;
	source: unknown;
	data: unknown;
}
interface ThemeReply {
	type: "owl:theme";
	theme: Theme;
	colors: {
		canvas: string;
		panel: string;
		sidebar: string;
		hover: string;
		border: string;
		text: string;
		muted: string;
		accent: string;
		accentHover: string;
	};
}

function themeFixture(onThemeChange?: (theme: Theme) => Promise<void>, mounted = true) {
	const root = { dataset: { owlTheme: "dark" } } as unknown as HTMLElement;
	const shell = {} as HTMLElement;
	const surface = {
		closest: (selector: string) => {
			assert.equal(selector, ".owl-desktop-shell");
			return shell;
		},
	} as unknown as HTMLElement;
	const colors: Record<string, string> = {
		"--owl-ui-canvas": " #1e1e1e ",
		"--owl-ui-panel": "#262626",
		"--owl-ui-sidebar": "#191919",
		"--owl-ui-hover": "#2e2e2e",
		"--owl-ui-border": "#3d3d3d",
		"--owl-ui-text": "#e8e8e8",
		"--owl-ui-muted": "#a3a3a3",
		"--color-owl-accent": "#50a992",
		"--color-owl-accent-hover": "#428e7a",
		"--color-owl-bg": "#base-canvas",
		"--color-owl-panel": "#base-panel",
		"--color-owl-sidebar": "#base-sidebar",
		"--color-owl-hover": "#base-hover",
		"--color-owl-border": "#base-border",
		"--color-owl-text": "#base-text",
		"--color-owl-muted": "#base-muted",
	};
	const messages = new Set<(event: MessageFixture) => void>();
	const themeEvents = new Set<(event: MessageFixture) => void>();
	let styleReads = 0;
	const host = {
		addEventListener: (type: "message" | "owl-theme-change", listener: (event: MessageFixture) => void) => {
			(type === "message" ? messages : themeEvents).add(listener);
		},
		removeEventListener: (type: "message" | "owl-theme-change", listener: (event: MessageFixture) => void) => {
			(type === "message" ? messages : themeEvents).delete(listener);
		},
		getComputedStyle: (element: Element) => {
			assert.equal(element, surface);
			styleReads++;
			return { getPropertyValue: (name: string) => colors[name] ?? "" };
		},
	};
	const makeFrame = () => {
		const replies: Array<{ data: ThemeReply; origin: string }> = [];
		return {
			replies,
			frame: {
				postMessage: (data: unknown, origin: string) => {
					replies.push({ data: data as ThemeReply, origin });
				},
			},
		};
	};
	const first = makeFrame();
	let currentFrame: typeof first.frame | null = mounted ? first.frame : null;
	let observer: StubObserver | undefined;
	class StubObserver {
		callback: MutationCallback;
		observed: Array<{ target: Node; options?: MutationObserverInit }> = [];
		disconnected = false;
		constructor(callback: MutationCallback) {
			this.callback = callback;
			observer = this;
		}
		observe(target: Node, options?: MutationObserverInit) {
			this.observed.push({ target, options });
		}
		disconnect() {
			this.disconnected = true;
		}
		emit() {
			this.callback([], this as unknown as MutationObserver);
		}
	}
	const originalObserver = globalThis.MutationObserver;
	globalThis.MutationObserver = StubObserver as unknown as typeof MutationObserver;
	const changes: Theme[] = [];
	const bridge = attachManagerTheme({
		host,
		root,
		surface,
		managerUrl: "http://127.0.0.1:8790/accounts?view=active",
		frameWindow: () => currentFrame,
		onThemeChange: async (theme) => {
			changes.push(theme);
			if (onThemeChange) await onThemeChange(theme);
			else root.dataset.owlTheme = theme;
		},
	});
	assert.ok(observer);
	return {
		root,
		shell,
		colors,
		changes,
		observer,
		bridge,
		...first,
		get styleReads() {
			return styleReads;
		},
		get listenerCount() {
			return messages.size + themeEvents.size;
		},
		emit: (data: unknown, source: unknown = currentFrame, origin = "http://127.0.0.1:8790") => {
			for (const listener of messages) listener({ data, source, origin });
		},
		themeEvent: () => {
			for (const listener of themeEvents) listener({ data: null, source: null, origin: "" });
		},
		mount: () => {
			currentFrame = first.frame;
		},
		replaceFrame: () => {
			const next = makeFrame();
			currentFrame = next.frame;
			return next;
		},
		dispose: () => {
			bridge.dispose();
			globalThis.MutationObserver = originalObserver;
		},
	};
}

test("manager URL preserves its route, parameters and hash while bootstrapping the actual Owl theme", () => {
	const url = new URL(
		managerFrameUrl("http://127.0.0.1:8790/accounts?view=active&owlTheme=light#usage", "tauri://localhost", "dark"),
	);
	assert.equal(url.origin, "http://127.0.0.1:8790");
	assert.equal(url.pathname, "/accounts");
	assert.equal(url.searchParams.get("view"), "active");
	assert.equal(url.searchParams.get("owlParentOrigin"), "tauri://localhost");
	assert.deepEqual(url.searchParams.getAll("owlTheme"), ["dark"]);
	assert.equal(url.hash, "#usage");
});

test("attach and a trusted manager handshake send the surface palette to the exact manager origin", (t) => {
	const f = themeFixture();
	t.after(f.dispose);
	assert.deepEqual(f.replies, [
		{
			origin: "http://127.0.0.1:8790",
			data: {
				type: "owl:theme",
				theme: "dark",
				colors: {
					canvas: "#1e1e1e",
					panel: "#262626",
					sidebar: "#191919",
					hover: "#2e2e2e",
					border: "#3d3d3d",
					text: "#e8e8e8",
					muted: "#a3a3a3",
					accent: "#50a992",
					accentHover: "#428e7a",
				},
			},
		},
	]);
	f.emit({ type: "owl:theme:request" });
	assert.equal(f.replies.length, 2);
	assert.deepEqual(f.replies[1], f.replies[0]);
});

test("foreign frames, origins and malformed messages cannot change or read the desktop theme", async (t) => {
	const f = themeFixture();
	t.after(f.dispose);
	f.replies.length = 0;
	for (const data of [{ type: "owl:theme:request" }, { type: "owl:theme:set", theme: "light" }]) {
		f.emit(data, {});
		for (const origin of ["http://localhost:8790", "http://127.0.0.1:9999", "https://127.0.0.1:8790", "null"])
			f.emit(data, f.frame, origin);
	}
	for (const data of [
		null,
		[],
		"owl:theme:request",
		{},
		{ type: "owl:theme" },
		{ type: "owl:theme:set" },
		{ type: "owl:theme:set", theme: "system" },
		{ type: "owl:theme:set", theme: 1 },
	])
		f.emit(data);
	await setImmediate();
	assert.deepEqual(f.changes, []);
	assert.deepEqual(f.replies, []);
});

test("root and shell changes are batched and refresh custom accent and the actual resolved theme", async (t) => {
	const f = themeFixture();
	t.after(f.dispose);
	assert.deepEqual(f.observer.observed, [
		{
			target: f.root,
			options: {
				attributes: true,
				attributeFilter: [
					"data-owl-theme",
					"data-owl-preset",
					"data-owl-wallpaper",
					"data-owl-glass-theme",
					"style",
				],
			},
		},
		{ target: f.shell, options: { attributes: true, attributeFilter: ["class", "style"] } },
	]);
	f.root.dataset.owlTheme = "light";
	f.colors["--owl-ui-canvas"] = "#fafbf9";
	f.colors["--color-owl-accent"] = " #ff3399 ";
	f.colors["--color-owl-accent-hover"] = "color-mix(in srgb, #ff3399 84%, #000)";
	f.observer.emit();
	f.themeEvent();
	f.observer.emit();
	assert.equal(f.replies.length, 1);
	await setImmediate();
	assert.equal(f.replies.length, 2);
	assert.equal(f.styleReads, 2);
	assert.equal(f.replies[1].data.theme, "light");
	assert.equal(f.replies[1].data.colors.canvas, "#fafbf9");
	assert.equal(f.replies[1].data.colors.accent, "#ff3399");
	assert.equal(f.replies[1].data.colors.accentHover, "color-mix(in srgb, #ff3399 84%, #000)");
	assert.deepEqual(f.changes, []);
});

test("missing or empty surface tokens fall back to the current base Owl palette", (t) => {
	const f = themeFixture();
	t.after(f.dispose);
	for (const name of ["canvas", "panel", "sidebar", "hover", "border", "text", "muted"])
		f.colors[`--owl-ui-${name}`] = " ";
	f.bridge.sync();
	assert.deepEqual(f.replies[1].data.colors, {
		canvas: "#base-canvas",
		panel: "#base-panel",
		sidebar: "#base-sidebar",
		hover: "#base-hover",
		border: "#base-border",
		text: "#base-text",
		muted: "#base-muted",
		accent: "#50a992",
		accentHover: "#428e7a",
	});
});

test("valid theme selection uses the host callback and replies with the actual host result", async (t) => {
	const f = themeFixture();
	t.after(f.dispose);
	f.emit({ type: "owl:theme:set", theme: "light" });
	await setImmediate();
	assert.deepEqual(f.changes, ["light"]);
	assert.equal(f.root.dataset.owlTheme, "light");
	assert.equal(f.replies.at(-1)?.data.theme, "light");
	const replies = f.replies.length;
	f.emit({ type: "owl:theme", theme: "dark" });
	await setImmediate();
	assert.equal(f.replies.length, replies);
	assert.deepEqual(f.changes, ["light"]);
});

test("a rejected theme preference restores the frame to the actual host theme", async (t) => {
	const f = themeFixture(async () => {
		throw new Error("settings write failed");
	});
	t.after(f.dispose);
	f.emit({ type: "owl:theme:set", theme: "light" });
	await setImmediate();
	assert.deepEqual(f.changes, ["light"]);
	assert.equal(f.root.dataset.owlTheme, "dark");
	assert.equal(f.replies.length, 2);
	assert.equal(f.replies.at(-1)?.data.theme, "dark");
});

test("a preset lock remains authoritative even after the preference callback succeeds", async (t) => {
	const f = themeFixture(async () => {});
	t.after(f.dispose);
	f.emit({ type: "owl:theme:set", theme: "light" });
	await setImmediate();
	assert.deepEqual(f.changes, ["light"]);
	assert.equal(f.replies.at(-1)?.data.theme, "dark");
});

test("unmounted and refreshed frames receive the latest palette without trusting the previous frame", async (t) => {
	const f = themeFixture(undefined, false);
	t.after(f.dispose);
	assert.equal(f.replies.length, 0);
	assert.equal(f.styleReads, 0);
	f.bridge.sync();
	f.emit({ type: "owl:theme:set", theme: "light" }, f.frame);
	await setImmediate();
	assert.deepEqual(f.changes, []);
	f.mount();
	f.bridge.sync();
	assert.equal(f.replies.length, 1);
	const next = f.replaceFrame();
	f.root.dataset.owlTheme = "light";
	f.colors["--color-owl-accent"] = "#b04fff";
	f.emit({ type: "owl:theme:request" }, f.frame);
	f.emit({ type: "owl:theme:set", theme: "dark" }, f.frame);
	f.emit({ type: "owl:theme:request" }, next.frame);
	await setImmediate();
	assert.deepEqual(f.changes, []);
	assert.equal(f.replies.length, 1);
	assert.equal(next.replies.length, 1);
	assert.equal(next.replies[0].data.theme, "light");
	assert.equal(next.replies[0].data.colors.accent, "#b04fff");
});

test("dispose removes listeners and suppresses queued changes and late theme completions", async (t) => {
	let finish: (() => void) | undefined;
	const f = themeFixture(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	t.after(f.dispose);
	f.emit({ type: "owl:theme:set", theme: "light" });
	await Promise.resolve();
	assert.deepEqual(f.changes, ["light"]);
	assert.ok(finish);
	f.observer.emit();
	f.dispose();
	assert.equal(f.listenerCount, 0);
	assert.equal(f.observer.disconnected, true);
	finish();
	f.themeEvent();
	f.observer.emit();
	f.emit({ type: "owl:theme:request" });
	f.bridge.sync();
	await setImmediate();
	assert.equal(f.replies.length, 1);
	assert.equal(f.styleReads, 1);
	assert.deepEqual(f.changes, ["light"]);
});
