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
	dim: 32,
	blur: 0,
	panelOpacity: 36,
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
		root.style.setProperty("--owl-wp-card-mix", `${Math.max(10, panel - 20)}%`);
		root.style.setProperty("--owl-wp-read-mix", `${Math.min(70, Math.max(45, panel + 16))}%`);
	} else {
		delete root.dataset.owlWallpaper;
	}
}

/** 网页壁纸 iframe 的沙箱属性（allow-scripts = opaque origin，与上游一致的防逃逸）。 */
export const WALLPAPER_IFRAME_SANDBOX = "allow-scripts allow-pointer-lock";
