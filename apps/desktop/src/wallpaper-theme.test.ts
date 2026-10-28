import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { applyOwlGlassTheme, applyOwlWallpaper, DEFAULT_OWL_WALLPAPER } from "./wallpaper.ts";

function glassDocument(t: TestContext) {
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const values = new Map<string, string>();
	const events: { type: string; theme: string | undefined; accent: string | undefined; text: string | undefined }[] =
		[];
	const root = {
		dataset: { owlTheme: "dark" } as Record<string, string>,
		style: {
			setProperty: (name: string, value: string) => values.set(name, value),
			removeProperty: (name: string) => values.delete(name),
		},
	};
	Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			dispatchEvent: (event: Event) => {
				events.push({
					type: event.type,
					theme: root.dataset.owlGlassTheme,
					accent: values.get("--owl-glass-accent"),
					text: values.get("--owl-glass-text"),
				});
			},
		},
	});
	t.after(() => {
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	});
	return { root, values, events };
}

test("wallpaper palette publishes its actual mode before notifying and restores the base theme on disable", (t) => {
	const { root, values, events } = glassDocument(t);
	applyOwlWallpaper({ ...DEFAULT_OWL_WALLPAPER, enabled: true });
	applyOwlGlassTheme("1 1 1");
	assert.equal(root.dataset.owlTheme, "dark");
	assert.equal(root.dataset.owlGlassTheme, "light");
	assert.equal(values.get("--owl-glass-dark"), "0");
	assert.deepEqual(events[0], {
		type: "owl-appearance-change",
		theme: "light",
		accent: values.get("--owl-glass-accent"),
		text: values.get("--owl-glass-text"),
	});
	assert.ok(events[0].accent);
	assert.ok(events[0].text);

	root.dataset.owlTheme = "light";
	applyOwlGlassTheme("0 0 0");
	assert.equal(root.dataset.owlGlassTheme, "dark");
	assert.equal(values.get("--owl-glass-dark"), "1");
	assert.equal(events[1].theme, "dark");

	applyOwlWallpaper({ ...DEFAULT_OWL_WALLPAPER, enabled: false });
	assert.equal(root.dataset.owlTheme, "light");
	assert.equal(root.dataset.owlGlassTheme, undefined);
	assert.equal(root.dataset.owlWallpaper, undefined);
	assert.ok([...values.keys()].every((name) => !name.startsWith("--owl-glass-")));
	assert.deepEqual(events[2], { type: "owl-appearance-change", theme: undefined, accent: undefined, text: undefined });
});

test("inactive wallpaper ignores a late palette result", (t) => {
	const { root, values, events } = glassDocument(t);
	applyOwlWallpaper({ ...DEFAULT_OWL_WALLPAPER, enabled: false });
	events.length = 0;
	applyOwlGlassTheme("1 1 1");
	assert.equal(root.dataset.owlGlassTheme, undefined);
	assert.equal(values.has("--owl-glass-accent"), false);
	assert.deepEqual(events, []);
});

test("wallpaper metadata stays readable across hue, saturation and lightness on its three panel surfaces", (t) => {
	const { values } = glassDocument(t);
	applyOwlWallpaper({ ...DEFAULT_OWL_WALLPAPER, enabled: true });
	const hslRgb = (h: number, s: number, l: number): number[] => {
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const hp = h / 60;
		const x = c * (1 - Math.abs((hp % 2) - 1));
		const m = l - c / 2;
		const channels =
			hp < 1
				? [c, x, 0]
				: hp < 2
					? [x, c, 0]
					: hp < 3
						? [0, c, x]
						: hp < 4
							? [0, x, c]
							: hp < 5
								? [x, 0, c]
								: [c, 0, x];
		return channels.map((value) => value + m);
	};
	const luminance = (name: string): number => {
		const value = values.get(name) ?? "";
		const match = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(value);
		assert.ok(match, value);
		const channels = hslRgb(Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100).map((channel) =>
			channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
		);
		return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
	};
	for (let hue = 0; hue < 360; hue += 1) {
		for (const saturation of [0, 0.14, 0.55, 1]) {
			for (const lightness of [0.05, 0.25, 0.5, 0.75, 0.95]) {
				const scheme = hslRgb(hue, saturation, lightness).join(" ");
				applyOwlGlassTheme(scheme);
				const faint = luminance("--owl-glass-faint");
				for (const name of ["--owl-glass-panel", "--owl-glass-panel-2", "--owl-glass-panel-3"]) {
					const panel = luminance(name);
					const contrast = (Math.max(faint, panel) + 0.05) / (Math.min(faint, panel) + 0.05);
					assert.ok(contrast >= 4.5, `${scheme} on ${name}: ${contrast}`);
				}
			}
		}
	}
});
