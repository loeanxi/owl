/**
 * 外观自定义颜色与主题预设（settings.json 的 owlAppearance 字段）。
 * - preset：整套配色方案。"" = 经典黑（默认，中性黑灰），"owl-green" = 猫头鹰绿
 *   （旧版暖绿灰配色，经 <html data-owl-preset> 切换 index.css / desktop-shell.css 的令牌块）。
 *   monokai / solarized / abyss / tomorrow-night-blue / kimbie-dark / red 取色自 VS Code 内置主题（MIT），
 *   只有 solarized 带浅色档，其余浅色档回落默认浅色。
 * - accent：自定义强调色全局一份，深浅主题通用；空值跟随主题默认松石绿。
 * - background / foreground：按深浅模式各存一份，切档互不影响（空 = 跟随当前预设的默认）。
 * 应用方式：在 <html> 上写内联 CSS 变量覆盖 index.css 的 --color-owl-* 令牌，
 * 组件全部引用变量所以无需改动；清除时移除内联值即回默认。
 * 主题解析档变化（含 system 跟随操作系统）时 theme.ts 会先更新 <html> 的
 * data-owl-theme 再广播 owl-theme-change，本模块监听后按新档重新落变量。
 * 刻意不静态导入 theme.ts：解析档直接读 dataset，让解析器可在 node 测试里单测。
 */

/** 预设允许清单（未知值一律回默认经典黑）；顺序即设置页展示顺序。 */
export const OWL_PRESET_IDS = ["", "owl-green", "codex", "liquid-glass", "frost", "monokai", "solarized", "abyss", "tomorrow-night-blue", "kimbie-dark", "red"] as const;

export type OwlPresetId = (typeof OWL_PRESET_IDS)[number];

/**
 * 玻璃系预设：共用液态玻璃的整套玻璃样式与窗口背板档位。
 * "frost"（毛玻璃2）= 液态玻璃深色档锁死，不跟随深浅色切换；标题栏/图标栏图标改深色墨水，
 * 压在浅色系统背板上也看得清（desktop-shell.css 末尾「毛玻璃2」段）。
 */
export function isGlassPreset(preset: OwlPresetId): boolean {
	return preset === "liquid-glass" || preset === "frost";
}

/** 预设锁定的深浅档；null = 跟随用户主题设置。 */
export function presetThemeLock(preset: OwlPresetId): "dark" | null {
	return preset === "frost" ? "dark" : null;
}

/**
 * 液态玻璃预设在桌面壳里的窗口背板：clear = 不加系统效果，桌面原样透出；
 * blur = 轻模糊、不染色（Win11 上拖动/缩放窗口可能卡顿）；acrylic = 系统亚克力（重模糊 + 系统染色）。
 * 顺序即设置页展示顺序；未知值回 clear。
 */
export const OWL_GLASS_MODES = ["clear", "blur", "acrylic"] as const;

export type OwlGlassMode = (typeof OWL_GLASS_MODES)[number];

export interface OwlAppearanceColors {
	preset: OwlPresetId;
	glass: OwlGlassMode;
	accent: string;
	dark: { background: string; foreground: string };
	light: { background: string; foreground: string };
}

/** 各预设深浅档的默认底色/文字色（与 index.css 令牌保持同步，仅供 UI 展示与拾色器兜底）。 */
export const PRESET_DEFAULT_COLORS: Record<OwlPresetId, { dark: { background: string; foreground: string }; light: { background: string; foreground: string } }> = {
	"": {
		dark: { background: "#1e1e1e", foreground: "#e8e8e8" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
	"owl-green": {
		dark: { background: "#262624", foreground: "#e9e7e0" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
	codex: {
		dark: { background: "#1f1f1f", foreground: "#ededed" },
		light: { background: "#f7f6f3", foreground: "#1a1a1a" },
	},
	"liquid-glass": {
		dark: { background: "#0b0d1a", foreground: "#f5f5f7" },
		light: { background: "#eef1fa", foreground: "#1d1d1f" },
	},
	frost: {
		dark: { background: "#0b0d1a", foreground: "#f5f5f7" },
		light: { background: "#0b0d1a", foreground: "#f5f5f7" },
	},
	monokai: {
		dark: { background: "#272822", foreground: "#f8f8f2" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
	solarized: {
		dark: { background: "#002b36", foreground: "#ced6d6" },
		light: { background: "#fdf6e3", foreground: "#44575e" },
	},
	abyss: {
		dark: { background: "#000c18", foreground: "#c6d0e8" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
	"tomorrow-night-blue": {
		dark: { background: "#002451", foreground: "#eef3ff" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
	"kimbie-dark": {
		dark: { background: "#221a0f", foreground: "#e8d5bb" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
	red: {
		dark: { background: "#390000", foreground: "#f8f8f8" },
		light: { background: "#faf9f5", foreground: "#3d3a32" },
	},
};

export const DEFAULT_ACCENTS = { dark: "#50a992", light: "#268574" } as const;

export const DEFAULT_OWL_APPEARANCE: Readonly<OwlAppearanceColors> = Object.freeze({
	preset: "",
	glass: "clear",
	accent: "",
	dark: Object.freeze({ background: "", foreground: "" }),
	light: Object.freeze({ background: "", foreground: "" }),
});

/** 接受 #rgb / #rrggbb，统一成小写 #rrggbb；其余输入（含空串）一律视为「用默认」。 */
export function normalizeHexColor(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.trim().toLowerCase();
	if (/^#[0-9a-f]{3}$/.test(text)) {
		return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
	}
	return /^#[0-9a-f]{6}$/.test(text) ? text : "";
}

/** Keep text readable on both preset and custom accent backgrounds. */
export function accentTextColor(value: string, shade = 1): "#111111" | "#ffffff" | "#000000" {
	const hex = normalizeHexColor(value);
	if (!hex) return "#ffffff";
	const channels = [1, 3, 5].map((offset) => {
		const channel = (Number.parseInt(hex.slice(offset, offset + 2), 16) * shade) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
	const darkContrast = (luminance + 0.05) / 0.055605;
	const lightContrast = 1.05 / (luminance + 0.05);
	if (Math.max(darkContrast, lightContrast) < 4.5) return "#000000";
	return darkContrast >= lightContrast ? "#111111" : "#ffffff";
}

/** Wallpaper palettes can be lighter or darker than the saved theme preference. */
export function resolveSurfaceTheme(dataset: Record<string, string | undefined>): "dark" | "light" {
	if (dataset.owlWallpaper === "on" && (dataset.owlGlassTheme === "dark" || dataset.owlGlassTheme === "light")) return dataset.owlGlassTheme;
	return dataset.owlTheme === "light" ? "light" : "dark";
}

function syncAccentText(): void {
	if (typeof document === "undefined" || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return;
	const root = document.documentElement;
	const style = window.getComputedStyle(root);
	const foreground = (color: string): string => {
		const hex = normalizeHexColor(color);
		if (hex) return accentTextColor(hex);
		if (typeof document.createElement === "function") {
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 1;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context) {
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				const rgb = context.getImageData(0, 0, 1, 1).data;
				return accentTextColor(`#${Array.from(rgb).slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`);
			}
		}
		return current.accent ? accentTextColor(current.accent, 0.84) : "#ffffff";
	};
	for (const [token, source] of [
		["--color-owl-on-accent", "--color-owl-accent"],
		["--color-owl-on-accent-hover", "--color-owl-accent-hover"],
	]) {
		const next = foreground(style.getPropertyValue(source).trim());
		if (root.style.getPropertyValue(token) !== next) root.style.setProperty(token, next);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function parsePreset(value: unknown): OwlPresetId {
	return (OWL_PRESET_IDS as readonly string[]).includes(value as string) ? value as OwlPresetId : "";
}

function parseGlassMode(value: unknown): OwlGlassMode {
	return (OWL_GLASS_MODES as readonly string[]).includes(value as string) ? value as OwlGlassMode : "clear";
}

/** 逐字段回退：坏值只影响自己那一项，不拖垮其它已保存的颜色。 */
export function parseOwlAppearance(raw: unknown): OwlAppearanceColors {
	const value = asRecord(raw);
	const dark = asRecord(value.dark);
	const light = asRecord(value.light);
	return {
		preset: parsePreset(value.preset),
		glass: parseGlassMode(value.glass),
		accent: normalizeHexColor(value.accent),
		dark: { background: normalizeHexColor(dark.background), foreground: normalizeHexColor(dark.foreground) },
		light: { background: normalizeHexColor(light.background), foreground: normalizeHexColor(light.foreground) },
	};
}

let current: OwlAppearanceColors = parseOwlAppearance(DEFAULT_OWL_APPEARANCE);

/** 当前解析档：theme.ts 把它写在 <html data-owl-theme> 上，缺失（未初始化）时按深色处理。 */
function resolvedTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	return document.documentElement.dataset.owlTheme === "light" ? "light" : "dark";
}

/** 清掉本模块管理的全部内联变量，再按当前解析档落需要的值；幂等，可反复调用。 */
function applyToDocument(colors: OwlAppearanceColors): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	for (const name of [
		"--color-owl-accent",
		"--color-owl-accent-hover",
		"--color-owl-bg",
		"--owl-conversation-bg",
		"--color-owl-text",
		"--owl-ui-canvas-override",
		"--owl-ui-text-override",
		"--color-owl-on-accent",
		"--color-owl-on-accent-hover",
	]) {
		root.style.removeProperty(name);
	}
	// 主题预设走 <html> 属性：index.css / desktop-shell.css 据此整块切换配色令牌。
	if (colors.preset) root.dataset.owlPreset = colors.preset;
	else delete root.dataset.owlPreset;
	if (colors.accent) {
		root.style.setProperty("--color-owl-accent", colors.accent);
		root.style.setProperty("--color-owl-accent-hover", `color-mix(in srgb, ${colors.accent} 84%, #000)`);
	}
	for (const mode of ["dark", "light"] as const) {
		const defaults = PRESET_DEFAULT_COLORS[colors.preset][mode];
		root.style.setProperty(`--owl-preview-${mode}-bg`, colors[mode].background || defaults.background);
		root.style.setProperty(`--owl-preview-${mode}-fg`, colors[mode].foreground || defaults.foreground);
	}
	const mode = resolvedTheme();
	const perMode = colors[mode];
	if (perMode.background) {
		root.style.setProperty("--color-owl-bg", perMode.background);
		root.style.setProperty("--owl-ui-canvas-override", perMode.background);
		// 深色档的对话区底色是独立常量，跟随自定义背景保持整屏一致；浅色档它本就指向 --color-owl-bg。
		if (mode === "dark") root.style.setProperty("--owl-conversation-bg", perMode.background);
	}
	if (perMode.foreground) {
		root.style.setProperty("--color-owl-text", perMode.foreground);
		root.style.setProperty("--owl-ui-text-override", perMode.foreground);
	}
	if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
		syncAccentText();
		window.dispatchEvent(new Event("owl-appearance-change"));
	}
}

/** 应用一整套外观设置：先存模块级副本（供主题切档时重放），再立即落变量与预设属性。 */
export function applyOwlAppearance(colors: OwlAppearanceColors): void {
	current = parseOwlAppearance(colors);
	applyToDocument(current);
}

if (typeof window !== "undefined") {
	window.addEventListener("owl-theme-change", () => applyToDocument(current));
	window.addEventListener("owl-appearance-change", syncAccentText);
	if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
		const observer = new MutationObserver(syncAccentText);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-owl-theme", "data-owl-preset", "data-owl-wallpaper", "data-owl-glass-theme"] });
	}
}
