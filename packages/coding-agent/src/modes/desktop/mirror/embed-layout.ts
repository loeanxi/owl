/**
 * 窗口嵌入布局纯函数（owl Mirror 短剧卡）。
 *
 * 嵌入的红果窗口是 owl 主窗口的原生子窗口，位置尺寸由 UI 按「舞台矩形」换算
 * 成父客户区物理像素后经桥下发（mirror.layout）。这里只放可单测的纯计算：
 * 等比 contain、css→物理换算、屏外隐藏矩形、悬浮夹取、窗口样式位运算。
 * 坐标约定：子窗口坐标 = 父客户区物理像素（父 = WebView2 HWND 时即视口本身）。
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type EmbedMode = "sidebar" | "expand" | "float";

// user32 窗口样式位（仅本模块用到的）
export const WS_CHILD = 0x40000000;
export const WS_CAPTION = 0x00c00000;
export const WS_THICKFRAME = 0x00040000;

/** 把 aspectW:aspectH 的画面等比 contain 进舞台，居中；尺寸/位置取整。 */
export function containRect(stageW: number, stageH: number, aspectW: number, aspectH: number): Rect {
	const w = Math.max(1, Math.round(stageW));
	const h = Math.max(1, Math.round(stageH));
	const aw = Math.max(1, aspectW);
	const ah = Math.max(1, aspectH);
	const scale = Math.min(w / aw, h / ah);
	const width = Math.max(1, Math.round(aw * scale));
	const height = Math.max(1, Math.round(ah * scale));
	return {
		x: Math.round((w - width) / 2),
		y: Math.round((h - height) / 2),
		width,
		height,
	};
}

/** webview 视口内的 css 矩形 → 父客户区物理像素矩形（含父内原点偏移）。 */
export function viewportToParentClient(css: Rect, dpr: number, originX = 0, originY = 0): Rect {
	const scale = dpr > 0 ? dpr : 1;
	const round = (v: number): number => Math.round(v);
	return {
		x: round(css.x * scale) + originX,
		y: round(css.y * scale) + originY,
		width: round(css.width * scale),
		height: round(css.height * scale),
	};
}

/**
 * 隐藏嵌入窗口的子窗口坐标：远超父客户区左上（负方向），舞台任意变大也不会
 * 重新进入可视范围（不用 -32000，那是系统最小化位置，避免与应用自身的
 * 最小化状态语义混淆）。
 */
export function hideRect(): Rect {
	return { x: -24_000, y: -24_000, width: 10, height: 10 };
}

/** 悬浮矩形夹取：尺寸超出边界先缩到边界，位置夹回界内。 */
export function clampFloatRect(rect: Rect, boundsW: number, boundsH: number): Rect {
	const width = Math.max(1, Math.min(rect.width, Math.max(1, Math.round(boundsW))));
	const height = Math.max(1, Math.min(rect.height, Math.max(1, Math.round(boundsH))));
	const maxX = Math.max(0, Math.round(boundsW) - width);
	const maxY = Math.max(0, Math.round(boundsH) - height);
	return {
		x: Math.min(Math.max(Math.round(rect.x), 0), maxX),
		y: Math.min(Math.max(Math.round(rect.y), 0), maxY),
		width,
		height,
	};
}

/**
 * 嵌入时的样式改写：去掉系统标题栏/可调边框（去头），补 WS_CHILD 位
 * （SetParent 本身不设置它，缺位会有焦点/激活怪癖）。保留其余位。
 */
export function embedStyle(style: number): number {
	return (style & ~(WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
}

/** 解除嵌入的样式还原：回到原始样式（原始样式天然没有 WS_CHILD 位）。 */
export function restoreStyle(embedded: number, original: number): number {
	void embedded;
	return original;
}

/**
 * 三形态 → 父客户区物理矩形。
 * - sidebar / expand：等比 contain 居中（画面外露 webview 黑底）。
 * - float：用用户拖放出的悬浮矩形（物理坐标），夹取到舞台界内；没有则退化
 *   为 contain 居中。
 */
export function computeLayout(
	mode: EmbedMode,
	stage: { width: number; height: number },
	dpr: number,
	windowSize: { width: number; height: number },
	floatRect?: Rect,
): Rect {
	const scale = dpr > 0 ? dpr : 1;
	if (mode === "float" && floatRect) {
		return clampFloatRect(floatRect, stage.width * scale, stage.height * scale);
	}
	const css = containRect(stage.width, stage.height, windowSize.width, windowSize.height);
	return viewportToParentClient(css, scale);
}
