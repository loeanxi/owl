/**
 * 动态壁纸设置（settings.json 的 owlWallpaper 字段）。
 *
 * 能力移植自 dsh-wallpaper-engine（MIT）：Video/Web 两类壁纸渲染、遮挡暂停、
 * 观感调节。设置只存「意图」，渲染细节由 WallpaperLayer 组件解释：
 * - enabled + selectionId/customPath：选哪张（selectionId 对应桥端 inventory 的 id）。
 * - volume/playbackRate：视频音量与倍速（音量 0 = 静音）。
 * - dim/blur：壁纸暗化与模糊（观感调节，保证前景文字可读）。
 * - panelOpacity：UI 面板不透明度百分比 —— 开壁纸时面板改用 color-mix 半透明，
 *   壁纸从侧栏/对话区底下透出来；0% = 完全透明，100% = 不透明（等同关壁纸的观感）。
 * - fit：cover 裁剪填满 / contain 完整显示。
 * - pauseOnHidden/pauseOnBlur：遮挡省电策略（页面隐藏 / 窗口失焦暂停）。
 * - contentRating：Wallpaper Engine 的内容分级过滤。
 * - customDir/customPath：自定义壁纸目录 / 单个本地文件（桥端扫描时读取）。
 *
 * 应用方式：在 <html> 写 data-owl-wallpaper 属性 + 内联 CSS 变量
 * （--owl-wp-panel-mix 等），desktop-shell.css / index.css 据此切换半透明规则；
 * 关闭时移除属性即整体回退到不透明外观，组件无需感知。
 */

export type WallpaperFit = "cover" | "contain";
export type WallpaperContentRating = "all" | "everyone" | "pg13" | "mature";
export type WallpaperRotationOrder = "sequence" | "random";

export interface OwlWallpaperSettings {
	enabled: boolean;
	/** 桥端 inventory 里的壁纸 id（customPath 存在时优先用它）。 */
	selectionId: string;
	/** 单个本地壁纸文件（视频/图片/网页），优先于 selectionId。 */
	customPath: string;
	/** 额外扫描的壁纸根目录（每个子目录一张壁纸），空 = 只扫 Wallpaper Engine。 */
	customDir: string;
	volume: number;
	playbackRate: number;
	/** 壁纸暗化 0–100（黑色遮罩不透明度百分比）。 */
	dim: number;
	/** 壁纸模糊 0–24 px。 */
	blur: number;
	/** UI 面板不透明度 0–100%（开壁纸时才生效）。 */
	panelOpacity: number;
	fit: WallpaperFit;
	pauseOnHidden: boolean;
	pauseOnBlur: boolean;
	contentRating: WallpaperContentRating;
	/** scene 实时渲染帧率上限（15/30/60）；0 或非法值 = 渲染页默认。 */
	sceneFps: number;
	/** 用户属性覆盖：{ <壁纸id>: { <属性名>: 线格式值 } }（属性面板写入，热下发生效）。 */
	props: Record<string, Record<string, unknown>>;
	/** 轮播：到点在可用壁纸列表里顺次/随机切换（就绪后才切，不黑屏）。 */
	rotationEnabled: boolean;
	/** 轮播间隔（分钟，1–1440）。 */
	rotationInterval: number;
	/** 轮播顺序。 */
	rotationOrder: WallpaperRotationOrder;
}

export const DEFAULT_OWL_WALLPAPER: Readonly<OwlWallpaperSettings> = Object.freeze({
	enabled: false,
	selectionId: "",
	customPath: "",
	customDir: "",
	volume: 0,
	playbackRate: 1,
	dim: 8,
	blur: 0,
	panelOpacity: 28,
	fit: "cover",
	pauseOnHidden: true,
	pauseOnBlur: false,
	contentRating: "everyone",
	sceneFps: 30,
	props: Object.freeze({}),
	rotationEnabled: false,
	rotationInterval: 15,
	rotationOrder: "sequence",
});

const SCENE_FPS_VALUES = new Set([15, 30, 60]);

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/** 逐字段回退：坏值只影响自己那一项，不拖垮其它已保存的设置。 */
export function parseOwlWallpaper(raw: unknown): OwlWallpaperSettings {
	const value = asRecord(raw);
	const fit = value.fit === "contain" ? "contain" : "cover";
	const rating = value.contentRating as WallpaperContentRating;
	const order = value.rotationOrder as WallpaperRotationOrder;
	const rawProps = asRecord(value.props);
	const props: Record<string, Record<string, unknown>> = {};
	for (const [wid, defs] of Object.entries(rawProps)) {
		if (typeof wid !== "string" || wid === "") continue;
		const defsRecord = asRecord(defs);
		if (!Object.keys(defsRecord).length) continue;
		props[wid] = defsRecord;
	}
	return {
		enabled: value.enabled === true,
		selectionId: typeof value.selectionId === "string" ? value.selectionId : "",
		customPath: typeof value.customPath === "string" ? value.customPath : "",
		customDir: typeof value.customDir === "string" ? value.customDir : "",
		volume: clampNumber(value.volume, 0, 1, DEFAULT_OWL_WALLPAPER.volume),
		playbackRate: clampNumber(value.playbackRate, 0.5, 2, DEFAULT_OWL_WALLPAPER.playbackRate),
		dim: clampNumber(value.dim, 0, 100, DEFAULT_OWL_WALLPAPER.dim),
		blur: clampNumber(value.blur, 0, 24, DEFAULT_OWL_WALLPAPER.blur),
		panelOpacity: clampNumber(value.panelOpacity, 0, 100, DEFAULT_OWL_WALLPAPER.panelOpacity),
		fit,
		pauseOnHidden: value.pauseOnHidden !== false,
		pauseOnBlur: value.pauseOnBlur === true,
		contentRating: ["all", "everyone", "pg13", "mature"].includes(rating) ? rating : DEFAULT_OWL_WALLPAPER.contentRating,
		sceneFps: SCENE_FPS_VALUES.has(Number(value.sceneFps)) ? Number(value.sceneFps) : DEFAULT_OWL_WALLPAPER.sceneFps,
		props,
		rotationEnabled: value.rotationEnabled === true,
		rotationInterval: Math.round(clampNumber(value.rotationInterval, 1, 1440, DEFAULT_OWL_WALLPAPER.rotationInterval)),
		rotationOrder: order === "random" ? "random" : "sequence",
	};
}

/** 当前生效档（模块级副本，设置页与启动加载共用同一个 apply 入口）。 */
let current: OwlWallpaperSettings = parseOwlWallpaper(DEFAULT_OWL_WALLPAPER);

/** 给外部读取当前生效值（WallpaperLayer 初始化时避免再传一份）。 */
export function getOwlWallpaper(): OwlWallpaperSettings {
	return current;
}

/**
 * 应用一整套壁纸设置：写 <html data-owl-wallpaper> 与面板半透明变量。
 * 幂等，可反复调用（设置页拖动滑杆会高频触发）。
 */
export function applyOwlWallpaper(settings: OwlWallpaperSettings): void {
	current = parseOwlWallpaper(settings);
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.style.removeProperty("--owl-wp-panel-mix");
	root.style.removeProperty("--owl-wp-card-mix");
	root.style.removeProperty("--owl-wp-read-mix");
	if (current.enabled) {
		root.dataset.owlWallpaper = "on";
		// 半透明三档——「壁纸为主、内容是浮层」：panel = 框架薄纱；card = 对话区近乎全透；
		// read = 只给小面积元素（气泡/输入框）的玻璃块。正文直接压壁纸，靠暗化 + 文字阴影保可读。
		const panel = Math.round(current.panelOpacity);
		root.style.setProperty("--owl-wp-panel-mix", `${panel}%`);
		root.style.setProperty("--owl-wp-card-mix", `${Math.max(8, panel - 18)}%`);
		root.style.setProperty("--owl-wp-read-mix", `${Math.min(72, Math.max(46, panel + 24))}%`);
	} else {
		delete root.dataset.owlWallpaper;
		clearOwlGlassTheme();
	}
}

// ---------------------------------------------------------------- 染色玻璃
//
// 玻璃模式的全部 UI 色彩从「壁纸主题色」派生（project.json 的 schemecolor，
// 每张壁纸自带）：面板/卡片/边框/悬停 = 主题色的低饱和深/浅版，强调色跟随壁纸。
// 玻璃深浅按主题色亮度自动切换：暗壁纸 → 浅字深玻璃，亮壁纸 → 深字亮玻璃。

interface GlassPalette {
	/** 玻璃深浅档：暗壁纸=true（浅字深玻璃），亮壁纸=false（深字亮玻璃）。 */
	dark: boolean;
	accent: string;
	accentHover: string;
	panel: string;
	panel2: string;
	panel3: string;
	hover: string;
	border: string;
	text: string;
	muted: string;
	faint: string;
	/** 代码块/工具卡等需要高实底的表面。 */
	code: string;
	/** 选中态底（侧栏选中、tab 激活等 accent 软底）。 */
	accentSoft: string;
}

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

/** 解析壁纸主题色：接受 WE 的 "r g b"（0..1 浮点）与 "rgb(r,g,b)"，失败回退暖灰。 */
function parseSchemeColor(raw: string | undefined): { h: number; s: number; l: number } {
	let r = 0.64;
	let g = 0.55;
	let b = 0.42;
	if (typeof raw === "string" && raw.trim()) {
		const parts = raw.trim().split(/[\s,]+/).map(Number);
		if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
			const max = Math.max(...parts.slice(0, 3));
			const scale = max > 1 ? 1 / 255 : 1; // 兼容 0..255 写法
			[r, g, b] = parts.slice(0, 3).map((n) => clamp01(n * scale));
		}
	}
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 36, s: 0.14, l }; // 无彩 → 落暖灰，别给纯灰玻璃
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
	else if (max === g) h = ((b - r) / d + 2) / 6;
	else h = ((r - g) / d + 4) / 6;
	return { h: h * 360, s: Math.min(1, s), l };
}

/** 感知亮度（Rec.601 加权）：决定玻璃走深字还是浅字。 */
function perceivedLightness(r: number, g: number, b: number): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 由主题色派生整块玻璃色板；hue 保留、饱和度压一半、明暗按感知亮度定档。 */
function deriveGlassPalette(schemeColor: string | undefined): GlassPalette {
	const { h, s: rawS, l: rawL } = parseSchemeColor(schemeColor);
	const rgb = hslToRgb(h, rawS, rawL);
	const dark = perceivedLightness(rgb.r, rgb.g, rgb.b) <= 0.55;
	// 饱和度钳制：无彩壁纸给一点色调（14%），高饱和压到 55% 免得面板艳俗
	const s = Math.min(0.55, Math.max(0.14, rawS * 0.75));
	// 统一 hsl() 组装:h、s、l 三个数各自格式化,避免模板拼接出多余成分
	const hsl = (l: number, sat = s, alpha?: number): string => {
		const base = `hsl(${h.toFixed(1)} ${Math.round(clamp01(sat) * 100)}% ${Math.round(clamp01(l) * 100)}%)`;
		return alpha === undefined ? base : `hsl(${h.toFixed(1)} ${Math.round(clamp01(sat) * 100)}% ${Math.round(clamp01(l) * 100)}% / ${alpha})`;
	};
	if (dark) {
		const accentS = Math.max(0.42, rawS);
		const accentL = Math.min(0.66, Math.max(0.52, rawL < 0.3 ? 0.58 : rawL + 0.08));
		return {
			dark: true,
			accent: hsl(accentL, accentS),
			accentHover: hsl(Math.max(0.3, accentL - 0.07), accentS),
			panel: hsl(0.11),
			panel2: hsl(0.08),
			panel3: hsl(0.15),
			hover: hsl(0.18),
			border: hsl(0.78, s, 0.16),
			text: hsl(0.93, s * 0.4),
			muted: hsl(0.68, s * 0.45),
			faint: hsl(0.56, s * 0.4),
			code: hsl(0.13),
			accentSoft: hsl(0.5, s, 0.13),
		};
	}
	const accentS = Math.max(0.4, rawS);
	const accentL = Math.min(0.46, Math.max(0.3, rawL > 0.7 ? 0.38 : rawL - 0.06));
	return {
		dark: false,
		accent: hsl(accentL, accentS),
		accentHover: hsl(Math.max(0.24, accentL - 0.06), accentS),
		panel: hsl(0.96, s * 0.55),
		panel2: hsl(0.91, s * 0.55),
		panel3: hsl(0.99, s * 0.55),
		hover: hsl(0.88, s * 0.55),
		border: hsl(0.22, s * 0.6, 0.18),
		text: hsl(0.16, s * 0.6),
		muted: hsl(0.36, s * 0.35),
		faint: hsl(0.46, s * 0.3),
		code: hsl(0.89, s * 0.4),
		accentSoft: hsl(0.45, s * 0.7, 0.12),
	};
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = ((h % 360) + 360) % 360 / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r1, g1, b1] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = l - c / 2;
	return { r: r1 + m, g: g1 + m, b: b1 + m };
}

const GLASS_VARS = [
	"--owl-glass-accent",
	"--owl-glass-accent-hover",
	"--owl-glass-accent-soft",
	"--owl-glass-panel",
	"--owl-glass-panel-2",
	"--owl-glass-panel-3",
	"--owl-glass-hover",
	"--owl-glass-border",
	"--owl-glass-text",
	"--owl-glass-muted",	"--owl-glass-faint",
	"--owl-glass-code",
	"--owl-glass-dark",
	"--owl-wp-text-shadow",
] as const;

/**
 * 应用染色玻璃色板：从当前壁纸的主题色派生整套玻璃变量写上 <html>。
 * 由 WallpaperLayer 在选中壁纸变化时调用；关闭壁纸时调用 clear。
 */
export function applyOwlGlassTheme(schemeColor: string | undefined): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (document.documentElement.dataset.owlWallpaper !== "on") return;
	const p = deriveGlassPalette(schemeColor);
	root.style.setProperty("--owl-glass-accent", p.accent);
	root.style.setProperty("--owl-glass-accent-hover", p.accentHover);
	root.style.setProperty("--owl-glass-accent-soft", p.accentSoft);
	root.style.setProperty("--owl-glass-panel", p.panel);
	root.style.setProperty("--owl-glass-panel-2", p.panel2);
	root.style.setProperty("--owl-glass-panel-3", p.panel3);
	root.style.setProperty("--owl-glass-hover", p.hover);
	root.style.setProperty("--owl-glass-border", p.border);
	root.style.setProperty("--owl-glass-text", p.text);
	root.style.setProperty("--owl-glass-muted", p.muted);
	root.style.setProperty("--owl-glass-faint", p.faint);
	root.style.setProperty("--owl-glass-code", p.code);
	root.style.setProperty("--owl-glass-dark", p.dark ? "1" : "0");
	// 文字阴影随档位:深玻璃浅字要重黑影;亮玻璃深字只给一点白晕,重黑影会把字糊掉。
	root.style.setProperty(
		"--owl-wp-text-shadow",
		p.dark
			? "0 1px 3px rgba(0, 0, 0, 0.85), 0 0 12px rgba(0, 0, 0, 0.45)"
			: "0 1px 2px rgba(255, 255, 255, 0.6)",
	);
}

/** 清掉染色玻璃变量（关壁纸/换回无主题色时），界面回到用户主题。 */
export function clearOwlGlassTheme(): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	for (const name of GLASS_VARS) root.style.removeProperty(name);
}

/** 网页壁纸 iframe 的沙箱属性（allow-scripts = opaque origin，与上游一致的防逃逸）。 */
export const WALLPAPER_IFRAME_SANDBOX = "allow-scripts allow-pointer-lock";
