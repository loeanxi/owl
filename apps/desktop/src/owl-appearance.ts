/**
 * 外观自定义颜色（settings.json 的 owlAppearance 字段）。
 * - accent：强调色，全局一份，深浅主题通用（默认空 = 猫头鹰绿）。
 * - background / foreground：按深浅模式各存一份，切档互不影响（空 = 跟随主题默认）。
 * 应用方式：在 <html> 上写内联 CSS 变量覆盖 index.css 的 --color-owl-* 令牌，
 * 组件全部引用变量所以无需改动；清除时移除内联值即回默认。
 * 主题解析档变化（含 system 跟随操作系统）时 theme.ts 会先更新 <html> 的
 * data-owl-theme 再广播 owl-theme-change，本模块监听后按新档重新落变量。
 * 刻意不静态导入 theme.ts：解析档直接读 dataset，让解析器可在 node 测试里单测。
 */

export interface OwlAppearanceColors {
	accent: string;
	dark: { background: string; foreground: string };
	light: { background: string; foreground: string };
}

/** index.css 的默认令牌值（仅用于 UI 展示与 <input type="color"> 的兜底值，改 CSS 时同步）。 */
export const THEME_DEFAULT_COLORS = {
	dark: { background: "#262624", foreground: "#e9e7e0" },
	light: { background: "#faf9f5", foreground: "#3d3a32" },
} as const;

export const DEFAULT_ACCENT = "#2f9e5a";

export const DEFAULT_OWL_APPEARANCE: Readonly<OwlAppearanceColors> = Object.freeze({
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

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/** 逐字段回退：坏值只影响自己那一项，不拖垮其它已保存的颜色。 */
export function parseOwlAppearance(raw: unknown): OwlAppearanceColors {
	const value = asRecord(raw);
	const dark = asRecord(value.dark);
	const light = asRecord(value.light);
	return {
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
	]) {
		root.style.removeProperty(name);
	}
	if (colors.accent) {
		root.style.setProperty("--color-owl-accent", colors.accent);
		root.style.setProperty("--color-owl-accent-hover", `color-mix(in srgb, ${colors.accent} 84%, #000)`);
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
}

/** 应用一整套自定义颜色：先存模块级副本（供主题切档时重放），再立即落变量。 */
export function applyOwlAppearance(colors: OwlAppearanceColors): void {
	current = parseOwlAppearance(colors);
	applyToDocument(current);
}

if (typeof window !== "undefined") {
	window.addEventListener("owl-theme-change", () => applyToDocument(current));
}
