import assert from "node:assert/strict";
import { test } from "node:test";
import { observeWorkbenchTheme, readWorkbenchPalette } from "./theme-observer.ts";

test("the scoped workbench palette wins over base desktop tokens and trims custom values", () => {
	const values: Record<string, string> = {
		"--workbench-canvas": " #123456 ",
		"--owl-ui-canvas": "#222222",
		"--color-owl-bg": "#333333",
		"--owl-ui-panel": "#abcdef",
		"--owl-ui-text": "#102030",
		"--color-owl-muted": "#405060",
		"--workbench-border": "rgb(255 255 255 / 12%)",
		"--color-owl-accent": "color-mix(in srgb, #00ff00 50%, #000000)",
	};
	assert.deepEqual(readWorkbenchPalette({ getPropertyValue: (name) => values[name] ?? "" }, "light"), {
		theme: "light",
		canvas: "#123456",
		panel: "#abcdef",
		text: "#102030",
		muted: "#405060",
		border: "rgb(255 255 255 / 12%)",
		accent: "color-mix(in srgb, #00ff00 50%, #000000)",
	});
});

test("unmounted surfaces still have readable defaults for both resolved theme modes", () => {
	const empty = { getPropertyValue: () => "" };
	const light = readWorkbenchPalette(empty, "light");
	const dark = readWorkbenchPalette(empty, "dark");
	assert.equal(light.canvas, "#fafbf9");
	assert.equal(light.text, "#3d3a32");
	assert.equal(dark.canvas, "#202321");
	assert.equal(dark.text, "#e9e7e0");
});

test("theme, preset and custom shell changes are batched; disposal suppresses pending updates", async (t) => {
	const listeners = new Map<string, () => void>();
	const root = {};
	const shell = {};
	const observed: Array<{ target: unknown; options: MutationObserverInit }> = [];
	let notify: (() => void) | undefined;
	let disconnected = false;
	const globals = ["document", "window", "MutationObserver"] as const;
	const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
	t.after(() => {
		for (const [index, key] of globals.entries()) {
			const descriptor = descriptors[index];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	Object.defineProperties(globalThis, {
		document: { configurable: true, value: { documentElement: root } },
		window: {
			configurable: true,
			value: {
				addEventListener: (name: string, callback: () => void) => {
					assert.ok(["owl-theme-change", "owl-appearance-change"].includes(name));
					listeners.set(name, callback);
				},
				removeEventListener: (name: string, callback: () => void) => {
					assert.equal(listeners.get(name), callback);
					listeners.delete(name);
				},
			},
		},
		MutationObserver: {
			configurable: true,
			value: class {
				constructor(callback: () => void) {
					notify = callback;
				}
				observe(target: unknown, options: MutationObserverInit): void {
					observed.push({ target, options });
				}
				disconnect(): void {
					disconnected = true;
				}
			},
		},
	});
	let updates = 0;
	const surface = {
		closest: (selector: string) => {
			assert.equal(selector, ".owl-desktop-shell");
			return shell;
		},
	} as unknown as HTMLElement;
	const dispose = observeWorkbenchTheme(surface, () => {
		updates += 1;
	});
	assert.deepEqual(observed, [
		{
			target: root,
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
		{ target: shell, options: { attributes: true, attributeFilter: ["class", "style"] } },
	]);
	notify?.();
	notify?.();
	for (const listener of listeners.values()) listener();
	assert.equal(updates, 0);
	await Promise.resolve();
	assert.equal(updates, 1);
	notify?.();
	dispose();
	await Promise.resolve();
	assert.equal(updates, 1);
	assert.equal(listeners.size, 0);
	assert.equal(disconnected, true);
});
