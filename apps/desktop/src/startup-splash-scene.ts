/**
 * owl 启动动画：商标（16 道放射线 + 夜行猫头鹰眼睛）+ 星空 + 流星雨。
 *
 * 时间线（秒，从窗口真正显示后的第一帧起算；隐藏 WebView 会暂停 rAF，所以不会在看不见时提前播完）：
 *   0.00–1.00  星空（星云 + 银河 + 星星）淡入，自外向内收拢
 *   0.12–3.60  流星雨：约 48 颗同向流星陆续划过，穿插少数又亮又长的“主角”
 *   0.30–1.20  16 颗“星”沿商标圆环依次点亮，并用细线连成星座
 *   1.00–1.80  每颗星沿径向拉长成商标里的放射线，星座线淡出
 *   1.10–1.40  眼窝浮现，眼睛是闭着的（一道下垂的眼睑线）
 *   1.35–2.05  眼睛睁开：先微微睁开一线，停顿，再完全睁开（绿色瞳孔）
 *   2.15–2.60  瞳孔由绿渐变为红色，并向外扩散一圈红色光环
 *   2.35–      红色流光：光彗星绕瞳孔环游，一道亮光斜扫过眼窝，红色光晕呼吸
 *   2.40–2.90  “owl” 字标浮现
 *   3.70–4.20  整体淡出并微微放大，露出应用
 *
 * 性能：静态层（背景、星云、银河、光晕、星点、字标）一次性预渲染到离屏画布，每帧只 drawImage；
 * 尺寸由 ResizeObserver 缓存，逐帧不读布局；淡出交给宿主 div 的 opacity（合成器完成）。
 */
export type SplashCanvas = HTMLCanvasElement | OffscreenCanvas;
export type SplashContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const SPLASH_FADE_START = 3.7;
export const SPLASH_DURATION = 4.2;

export const SPLASH_BACKGROUND = "#03060d";
const BG_BOTTOM = "#0a1a24";
const RAY_GREEN = "#31a05b";
const RAY_GLOW = "rgba(70, 220, 130, ";
const EYE_DARK = "#241e19";
const BEAK = "#c4a82b";

/** 商标坐标系：1024×1024，中心 (512,512)。射线角度取自 app-icon.png（0°=正上，顺时针）。 */
const LOGO = 1024;
const RAY_ANGLES = [0, 18, 45, 68, 90, 112, 135, 162, 180, 198, 225, 248, 270, 292, 315, 342];
const RAY_MID = 372;
const RAY_HALF = 52;
const RAY_WIDTH = 64;
const EYES = [
	{ x: 376, y: 464 },
	{ x: 648, y: 464 },
];

/** 眼睛时间点。 */
const EYE_SOCKET_IN: [number, number] = [1.1, 1.4];
const EYE_PEEK: [number, number] = [1.35, 1.5];
const EYE_OPEN: [number, number] = [1.65, 2.05];
const EYE_RED: [number, number] = [2.15, 2.6];
const EYE_FLOW_AT = 2.35;

const GREEN_IRIS = [
	[155, 240, 180],
	[79, 207, 134],
	[47, 158, 90],
];
const RED_IRIS = [
	[255, 196, 176],
	[255, 66, 50],
	[170, 16, 30],
];
const GREEN_GLOW = [80, 230, 140];
const RED_GLOW = [255, 60, 44];
const GREEN_RING = [120, 235, 170];
const RED_RING = [255, 96, 84];

/** 绿→红的中途色：经过琥珀色，避免线性混合时中间发灰发脏。 */
const AMBER_IRIS = [
	[255, 232, 150],
	[250, 172, 50],
	[190, 100, 20],
];
const AMBER_GLOW = [255, 170, 50];
const AMBER_RING = [255, 196, 96];

const lerp3 = (a: number[], b: number[], r: number): number[] => [
	a[0] + (b[0] - a[0]) * r,
	a[1] + (b[1] - a[1]) * r,
	a[2] + (b[2] - a[2]) * r,
];
const rgbStr = (c: number[]): string => `${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}`;
/** green → amber → red 三段混合，r 取 0..1。 */
const heat = (green: number[], amber: number[], redC: number[], r: number): string =>
	rgbStr(r < 0.5 ? lerp3(green, amber, r * 2) : lerp3(amber, redC, (r - 0.5) * 2));

interface Star {
	angle: number;
	dist: number;
	size: number;
	phase: number;
	speed: number;
	tintIndex: number;
	depth: number;
	/** 属于银河带的星：位置固定（与预渲染的银河对齐），更密更小。 */
	band: boolean;
}

/** 银河带倾角（弧度）。 */
const BAND_TILT = -0.52;

/** 确定性伪随机，保证每次启动星空一致、截图可复现。 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TINTS = ["255,255,255", "190,215,255", "170,255,215", "255,240,200"];

export function createStars(count = 320, seed = 20261016): Star[] {
	const rand = mulberry32(seed);
	const stars: Star[] = [];
	const bandCount = Math.floor(count * 0.4);
	for (let i = 0; i < count; i++) {
		const depth = rand();
		const band = i < bandCount;
		let angle: number;
		let dist: number;
		if (band) {
			// 银河带：沿一条斜带分布，横向近似正态（三个均匀数之和）
			const u = rand() * 2 - 1;
			const v = ((rand() + rand() + rand()) / 3 - 0.5) * 0.28;
			angle = Math.atan2(v, u) + BAND_TILT;
			dist = Math.min(1, Math.hypot(u, v));
		} else {
			angle = rand() * Math.PI * 2;
			// sqrt 让星星在圆盘内近似均匀分布（0..1，再乘以屏幕半对角线）
			dist = Math.sqrt(rand());
		}
		stars.push({
			angle,
			dist,
			size: band ? 0.3 + depth * 0.9 : 0.4 + depth * 1.5,
			phase: rand() * Math.PI * 2,
			speed: 0.8 + rand() * 2.2,
			tintIndex: Math.floor(rand() * TINTS.length),
			depth,
			band,
		});
	}
	return stars;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 把 t 在 [a,b] 区间映射到 0..1。 */
export const span = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
export const easeInOutCubic = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeOutBack = (x: number): number => {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** 眼睑开合：0=闭，1=全开。先微睁一线，停顿，再完全睁开。 */
export function eyeOpenness(t: number): number {
	const peek = 0.2 * easeInOutCubic(span(t, EYE_PEEK[0], EYE_PEEK[1]));
	const full = easeOutBack(span(t, EYE_OPEN[0], EYE_OPEN[1]));
	return Math.max(0, peek + (1 - peek) * full);
}

/** 瞳孔红化程度 0..1。 */
export function eyeRedness(t: number): number {
	return easeInOutCubic(span(t, EYE_RED[0], EYE_RED[1]));
}

function rayPoint(angleDeg: number, radius: number): [number, number] {
	const a = (angleDeg * Math.PI) / 180;
	return [Math.sin(a) * radius, -Math.cos(a) * radius];
}

export interface Meteor {
	start: number;
	dur: number;
	/** 起点占屏幕宽高的比例（可超出 0..1，从屏外飞入）。 */
	x: number;
	y: number;
	angle: number;
	/** 尾迹长度、飞行距离：占屏幕对角线的比例。 */
	tail: number;
	travel: number;
	width: number;
	bright: number;
	tint: string;
}

const METEOR_TINTS = ["225,250,255", "200,255,230", "255,245,215", "210,225,255"];

/** 流星雨：方向基本一致（同一辐射点），数量多、长短快慢不一，确定性生成。 */
export function createMeteors(count = 48, seed = 7788): Meteor[] {
	const rand = mulberry32(seed);
	const meteors: Meteor[] = [];
	for (let i = 0; i < count; i++) {
		const hero = rand() < 0.14; // 少数又亮又长的“主角”
		meteors.push({
			start: 0.12 + Math.pow(rand(), 1.1) * 3.4,
			dur: hero ? 0.75 + rand() * 0.35 : 0.4 + rand() * 0.5,
			x: 0.15 + rand() * 1.1,
			y: -0.12 + rand() * 0.62,
			angle: Math.PI * (0.79 + (rand() - 0.5) * 0.06),
			tail: hero ? 0.16 + rand() * 0.1 : 0.05 + rand() * 0.1,
			travel: hero ? 0.55 + rand() * 0.3 : 0.3 + rand() * 0.4,
			width: hero ? 1.8 + rand() * 0.8 : 0.7 + rand() * 0.9,
			bright: hero ? 1 : 0.45 + rand() * 0.4,
			tint: METEOR_TINTS[Math.floor(rand() * METEOR_TINTS.length)],
		});
	}
	return meteors.sort((a, b) => a.start - b.start);
}

const METEORS = createMeteors();

export type SplashStars = ReturnType<typeof createStars>;

// ---------------------------------------------------------------------------
// 预渲染缓存
// ---------------------------------------------------------------------------

interface Scene {
	key: string;
	base: SplashCanvas;
	nebula: SplashCanvas;
	word: { canvas: SplashCanvas; w: number; h: number } | undefined;
}

let sceneCache: Scene | undefined;
let starSprites: SplashCanvas[] | undefined;
let auraSprite: SplashCanvas | undefined;

function makeCanvas(w: number, h: number): [SplashCanvas, SplashContext] {
	const c = typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(1, 1);
	c.width = Math.max(1, Math.round(w));
	c.height = Math.max(1, Math.round(h));
	return [c, c.getContext("2d") as SplashContext];
}

function getStarSprites(): SplashCanvas[] {
	if (starSprites) return starSprites;
	starSprites = TINTS.map((rgb) => {
		const [c, g] = makeCanvas(32, 32);
		const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
		grad.addColorStop(0, `rgba(${rgb}, 1)`);
		grad.addColorStop(0.3, `rgba(${rgb}, 0.9)`);
		grad.addColorStop(1, `rgba(${rgb}, 0)`);
		g.fillStyle = grad;
		g.fillRect(0, 0, 32, 32);
		return c;
	});
	return starSprites;
}

function getAuraSprite(): SplashCanvas {
	if (auraSprite) return auraSprite;
	const [c, g] = makeCanvas(256, 256);
	const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
	grad.addColorStop(0, "rgba(48, 170, 100, 0.2)");
	grad.addColorStop(0.35, "rgba(30, 120, 95, 0.085)");
	grad.addColorStop(1, "rgba(0, 0, 0, 0)");
	g.fillStyle = grad;
	g.fillRect(0, 0, 256, 256);
	auraSprite = c;
	return c;
}

function buildScene(width: number, height: number, dpr: number, cx: number, cy: number): Scene {
	const reach = Math.hypot(width, height) / 2;

	const [base, bg] = makeCanvas(width * dpr, height * dpr);
	bg.scale(dpr, dpr);
	const grad = bg.createLinearGradient(0, 0, 0, height);
	grad.addColorStop(0, SPLASH_BACKGROUND);
	grad.addColorStop(1, BG_BOTTOM);
	bg.fillStyle = grad;
	bg.fillRect(0, 0, width, height);

	const [nebula, g] = makeCanvas(width * dpr, height * dpr);
	g.scale(dpr, dpr);
	// 远处的星云：右上偏紫、左下偏青，给深空一点层次
	const blob = (x: number, y: number, r: number, rgb: string, a: number): void => {
		const rg = g.createRadialGradient(x, y, 0, x, y, r);
		rg.addColorStop(0, `rgba(${rgb}, ${a})`);
		rg.addColorStop(1, `rgba(${rgb}, 0)`);
		g.fillStyle = rg;
		g.fillRect(0, 0, width, height);
	};
	blob(width * 0.82, height * 0.2, reach * 0.62, "96, 78, 214", 0.13);
	blob(width * 0.16, height * 0.82, reach * 0.6, "24, 168, 150", 0.12);
	blob(width * 0.62, height * 0.9, reach * 0.4, "52, 110, 220", 0.07);
	// 银河带：一条斜穿画面的柔光
	g.save();
	g.translate(cx, cy);
	g.rotate(BAND_TILT);
	const bandW = reach * 0.2;
	const band = g.createLinearGradient(0, -bandW, 0, bandW);
	band.addColorStop(0, "rgba(140, 180, 255, 0)");
	band.addColorStop(0.5, "rgba(150, 190, 235, 0.085)");
	band.addColorStop(1, "rgba(140, 180, 255, 0)");
	g.fillStyle = band;
	g.fillRect(-reach * 1.2, -bandW, reach * 2.4, bandW * 2);
	g.restore();

	return { key: `${width}x${height}@${dpr}`, base, nebula, word: undefined };
}

function getWordmark(scene: Scene, fontSize: number, dpr: number): NonNullable<Scene["word"]> {
	if (scene.word) return scene.word;
	const text = "owl";
	const spacing = fontSize * 0.7;
	const font = `300 ${fontSize}px "Segoe UI", system-ui, -apple-system, "PingFang SC", sans-serif`;
	const probe = makeCanvas(8, 8)[1];
	probe.font = font;
	const widths = [...text].map((c) => probe.measureText(c).width);
	const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
	const w = Math.ceil(total + 40);
	const h = Math.ceil(fontSize * 3);
	const [canvas, g] = makeCanvas(w * dpr, h * dpr);
	g.scale(dpr, dpr);
	g.font = font;
	g.textBaseline = "middle";
	g.textAlign = "left";
	g.shadowColor = "rgba(70, 220, 130, 0.5)";
	g.shadowBlur = 10;
	g.fillStyle = "rgb(214, 245, 226)";
	let x = (w - total) / 2;
	[...text].forEach((c, i) => {
		g.fillText(c, x, h / 2);
		x += widths[i] + spacing;
	});
	scene.word = { canvas, w, h };
	return scene.word;
}

/**
 * 绘制一帧。ctx 的变换由调用方设置为 DPR 缩放，宽高为 CSS 像素。
 * 返回整体不透明度 0..1，由外层容器 opacity 实现淡出（本函数内部不做淡出）。
 */
export function drawSplashFrame(
	ctx: SplashContext,
	width: number,
	height: number,
	t: number,
	stars: SplashStars,
	options: { meteors?: boolean } = {},
): number {
	const cx = width / 2;
	const cy = height / 2 - 14;
	const reach = Math.hypot(width, height) / 2;
	// 商标做得精致小巧：宽屏下约 110–130px，把舞台留给星空和流星
	const logoSize = Math.max(84, Math.min(150, Math.min(width, height) * 0.15));
	const k = logoSize / LOGO;
	const dpr = ctx.getTransform().a || 1;

	const key = `${width}x${height}@${dpr}`;
	if (!sceneCache || sceneCache.key !== key) sceneCache = buildScene(width, height, dpr, cx, cy);
	const scene = sceneCache;

	const fade = span(t, SPLASH_FADE_START, SPLASH_DURATION);
	const alpha = 1 - easeInOutCubic(fade);
	const logoZoom = 1 + 0.08 * easeInOutCubic(fade);
	const red = eyeRedness(t);

	// ---- 背景（预渲染）----
	ctx.globalAlpha = 1;
	ctx.drawImage(scene.base, 0, 0, width, height);
	const starsIn = easeOutCubic(span(t, 0, 1.0));
	ctx.globalAlpha = starsIn;
	ctx.drawImage(scene.nebula, 0, 0, width, height);

	// 商标背后的光晕：范围大、很淡，把小巧的商标“托”在星空中央；红化后略带红
	const aura = 0.25 + 0.75 * span(t, 1.0, 2.1);
	const auraR = Math.min(width, height) * (0.34 + 0.015 * Math.sin(t * 1.6));
	ctx.globalAlpha = aura;
	ctx.drawImage(getAuraSprite(), cx - auraR, cy - auraR, auraR * 2, auraR * 2);

	// 睁眼变红时向外扩散一圈细光环（由绿转红）
	const ripple = span(t, EYE_RED[0], EYE_RED[0] + 1.1);
	if (ripple > 0 && ripple < 1) {
		ctx.globalAlpha = 1;
		ctx.strokeStyle = `rgba(${heat(GREEN_RING, AMBER_RING, RED_RING, red)}, ${0.24 * (1 - ripple)})`;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(cx, cy, logoSize * 0.5 + easeOutCubic(ripple) * Math.min(width, height) * 0.3, 0, Math.PI * 2);
		ctx.stroke();
	}

	// ---- 星空（精灵）----
	const gather = 1.25 - 0.25 * easeOutCubic(span(t, 0, 1.4)); // 自外向内收拢
	const spin = t * 0.035;
	const sprites = getStarSprites();
	for (const s of stars) {
		let x: number;
		let y: number;
		if (s.band) {
			const r = s.dist * reach;
			x = cx + Math.cos(s.angle) * r;
			y = cy + Math.sin(s.angle) * r;
		} else {
			const ang = s.angle + spin * (0.4 + s.depth);
			const r = s.dist * reach * gather;
			x = cx + Math.cos(ang) * r;
			y = cy + Math.sin(ang) * r;
		}
		if (x < -4 || y < -4 || x > width + 4 || y > height + 4) continue;
		const twinkle = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
		const a = starsIn * twinkle * (s.band ? 0.3 + 0.5 * s.depth : 0.35 + 0.65 * s.depth);
		if (a <= 0.02) continue;
		ctx.globalAlpha = a;
		const d = s.size * 3;
		ctx.drawImage(sprites[s.tintIndex], x - d, y - d, d * 2, d * 2);
		if (s.size > 1.5) {
			// 亮星加十字星芒
			ctx.globalAlpha = a * 0.5;
			ctx.fillStyle = "#fff";
			const l = s.size * 3.2 * twinkle;
			ctx.fillRect(x - l, y - 0.3, l * 2, 0.6);
			ctx.fillRect(x - 0.3, y - l, 0.6, l * 2);
		}
	}
	ctx.globalAlpha = 1;

	// ---- 流星 ----
	const diag = Math.hypot(width, height);
	ctx.save();
	ctx.globalCompositeOperation = "lighter";
	ctx.lineCap = "round";
	for (const m of options.meteors === false ? [] : METEORS) {
		if (m.start > t) break; // 已按开始时间排序
		const p = (t - m.start) / m.dur;
		if (p >= 1) continue;
		const dx = Math.cos(m.angle);
		const dy = Math.sin(m.angle);
		const hx = m.x * width + dx * m.travel * diag * p;
		const hy = m.y * height + dy * m.travel * diag * p;
		const len = m.tail * diag * (0.35 + 0.65 * Math.min(1, p * 4)); // 尾迹随加速拉长
		const tx = hx - dx * len;
		const ty = hy - dy * len;
		if (Math.max(hx, tx) < -20 || Math.min(hx, tx) > width + 20) continue;
		if (Math.max(hy, ty) < -20 || Math.min(hy, ty) > height + 20) continue;
		// 起落渐入渐出，中段最亮
		const a = Math.pow(Math.sin(p * Math.PI), 0.6) * m.bright;
		const g = ctx.createLinearGradient(tx, ty, hx, hy);
		g.addColorStop(0, `rgba(${m.tint}, 0)`);
		g.addColorStop(0.7, `rgba(${m.tint}, ${a * 0.35})`);
		g.addColorStop(1, `rgba(255, 255, 255, ${a})`);
		ctx.strokeStyle = g;
		ctx.lineWidth = m.width;
		ctx.beginPath();
		ctx.moveTo(tx, ty);
		ctx.lineTo(hx, hy);
		ctx.stroke();
		// 流星头部的小光点
		ctx.globalAlpha = a * 0.9;
		const hr = m.width * 3.2;
		ctx.drawImage(sprites[0], hx - hr, hy - hr, hr * 2, hr * 2);
		ctx.globalAlpha = 1;
	}
	ctx.restore();

	// ---- 商标 ----
	ctx.save();
	ctx.translate(cx, cy);
	ctx.scale(k * logoZoom, k * logoZoom);
	drawConstellationAndRays(ctx, t, k);
	drawEyes(ctx, t);
	ctx.restore();

	// ---- 字标（预渲染）----
	const wordIn = easeOutCubic(span(t, 2.4, 2.9));
	if (wordIn > 0) {
		const fontSize = Math.max(13, Math.round(logoSize * 0.12));
		const word = getWordmark(scene, fontSize, dpr);
		const y = cy + logoSize * 0.5 + fontSize * 1.7 + (1 - wordIn) * 6;
		ctx.globalAlpha = wordIn;
		ctx.drawImage(word.canvas, cx - word.w / 2, y - word.h / 2, word.w, word.h);
		ctx.globalAlpha = 1;
	}

	return alpha;
}

function drawConstellationAndRays(ctx: SplashContext, t: number, k: number): void {
	const n = RAY_ANGLES.length;
	const growAll = easeInOutCubic(span(t, 1.0, 1.8));
	const lineFade = 1 - span(t, 1.0, 1.7);
	const pulse = 0.85 + 0.15 * Math.sin(t * 2.2);

	// 点亮时间：自正上方顺时针依次
	const lightAt = (i: number): number => 0.3 + (i / n) * 0.8;

	// 星座线：已点亮的相邻星之间连线
	if (lineFade > 0) {
		ctx.lineWidth = 1.1 / k;
		ctx.lineCap = "round";
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const p = span(t, lightAt(i), lightAt(i) + 0.12);
			if (p <= 0) continue;
			const [x1, y1] = rayPoint(RAY_ANGLES[i], RAY_MID);
			const [x2, y2] = rayPoint(RAY_ANGLES[j], RAY_MID);
			ctx.strokeStyle = `${RAY_GLOW}${0.55 * lineFade * p})`;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x1 + (x2 - x1) * p, y1 + (y2 - y1) * p);
			ctx.stroke();
		}
	}

	for (let i = 0; i < n; i++) {
		const lit = easeOutBack(span(t, lightAt(i), lightAt(i) + 0.25));
		if (lit <= 0) continue;
		const half = RAY_HALF * growAll; // 从一个点拉长成胶囊
		const [x1, y1] = rayPoint(RAY_ANGLES[i], RAY_MID - half);
		const [x2, y2] = rayPoint(RAY_ANGLES[i], RAY_MID + half);
		const [mx, my] = rayPoint(RAY_ANGLES[i], RAY_MID);

		// 星点（拉长前的星）
		const starAlpha = clamp01(lit) * (1 - growAll * 0.6);
		if (starAlpha > 0.01) {
			const g = ctx.createRadialGradient(mx, my, 0, mx, my, 46);
			g.addColorStop(0, `rgba(235, 255, 245, ${starAlpha})`);
			g.addColorStop(0.25, `${RAY_GLOW}${0.55 * starAlpha})`);
			g.addColorStop(1, `${RAY_GLOW}0)`);
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(mx, my, 46 * Math.max(lit, 0), 0, Math.PI * 2);
			ctx.fill();
		}

		// 射线胶囊：外发光 + 本体
		const width = RAY_WIDTH * (0.5 + 0.5 * growAll) * Math.min(lit, 1.1);
		ctx.lineCap = "round";
		if (growAll > 0.05) {
			ctx.strokeStyle = `${RAY_GLOW}${0.28 * growAll * pulse})`;
			ctx.lineWidth = width + 30;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
		ctx.strokeStyle = RAY_GREEN;
		ctx.lineWidth = Math.max(width, 0.1);
		ctx.beginPath();
		ctx.moveTo(x1, y1);
		ctx.lineTo(x2, y2);
		ctx.stroke();
	}
}

/** 眼睛：闭着 → 睁开（绿）→ 变红 → 红色流光。坐标系为商标 1024 空间。 */
function drawEyes(ctx: SplashContext, t: number): void {
	const open = eyeOpenness(t);
	const socketIn = easeOutCubic(span(t, EYE_SOCKET_IN[0], EYE_SOCKET_IN[1]));
	const red = eyeRedness(t);
	const flow = easeOutCubic(span(t, EYE_FLOW_AT, EYE_FLOW_AT + 0.5)); // 流光强度

	if (socketIn > 0) {
		EYES.forEach((e, idx) => {
			const mirror = idx === 0 ? 1 : -1;
			ctx.save();
			ctx.translate(e.x - 512, e.y - 512);

			// 红色外发光：先画，叠加在眼窝周围
			if (red > 0.01) {
				const breathe = 0.8 + 0.2 * Math.sin(t * 4.2);
				const rg = ctx.createRadialGradient(0, 0, 40, 0, 0, 190);
				rg.addColorStop(0, `rgba(${RED_GLOW.join(",")}, ${0.34 * red * breathe})`);
				rg.addColorStop(1, `rgba(${RED_GLOW.join(",")}, 0)`);
				ctx.save();
				ctx.globalCompositeOperation = "lighter";
				ctx.fillStyle = rg;
				ctx.beginPath();
				ctx.arc(0, 0, 190, 0, Math.PI * 2);
				ctx.fill();
				ctx.restore();
			}

			// 眼窝：深色圆 + 细微轮廓（由绿转红），避免在深色背景里“消失”
			ctx.scale(socketIn, socketIn);
			ctx.fillStyle = EYE_DARK;
			ctx.beginPath();
			ctx.arc(0, 0, 112, 0, Math.PI * 2);
			ctx.fill();
			const socket = ctx.createRadialGradient(0, 0, 70, 0, 0, 112);
			socket.addColorStop(0, "rgba(60, 50, 40, 0)");
			socket.addColorStop(1, "rgba(0, 0, 0, 0.55)");
			ctx.fillStyle = socket;
			ctx.beginPath();
			ctx.arc(0, 0, 112, 0, Math.PI * 2);
			ctx.fill();
			ctx.lineWidth = 5;
			ctx.strokeStyle = `rgba(${heat(GREEN_RING, AMBER_RING, RED_RING, red)}, ${0.28 + 0.25 * open + 0.2 * red})`;
			ctx.beginPath();
			ctx.arc(0, 0, 112, 0, Math.PI * 2);
			ctx.stroke();

			// 闭着的眼睑线：一道微微下垂的弧
			const lidAlpha = 1 - clamp01(open * 4);
			if (lidAlpha > 0.01) {
				ctx.lineCap = "round";
				ctx.lineWidth = 8;
				ctx.strokeStyle = `rgba(${heat(GREEN_RING, AMBER_RING, RED_RING, red)}, ${0.5 * lidAlpha})`;
				ctx.beginPath();
				ctx.moveTo(-64, -4);
				ctx.quadraticCurveTo(0, 22, 64, -4);
				ctx.stroke();
			}

			// 睁开的缝隙：眼睑滑开，露出完整瞳孔
			if (open > 0.03) {
				const aperture = Math.min(open, 1.1) * 100;
				ctx.save();
				ctx.beginPath();
				ctx.ellipse(0, 0, 100, aperture, 0, 0, Math.PI * 2);
				ctx.clip();

				const glowRgb = heat(GREEN_GLOW, AMBER_GLOW, RED_GLOW, red);
				const pupilGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 96);
				pupilGlow.addColorStop(0, `rgba(${glowRgb}, ${0.45 + 0.2 * red})`);
				pupilGlow.addColorStop(1, `rgba(${glowRgb}, 0)`);
				ctx.fillStyle = pupilGlow;
				ctx.beginPath();
				ctx.arc(0, 0, 96, 0, Math.PI * 2);
				ctx.fill();

				const iris = ctx.createRadialGradient(-12, -14, 4, 0, 0, 46);
				iris.addColorStop(0, `rgb(${heat(GREEN_IRIS[0], AMBER_IRIS[0], RED_IRIS[0], red)})`);
				iris.addColorStop(0.55, `rgb(${heat(GREEN_IRIS[1], AMBER_IRIS[1], RED_IRIS[1], red)})`);
				iris.addColorStop(1, `rgb(${heat(GREEN_IRIS[2], AMBER_IRIS[2], RED_IRIS[2], red)})`);
				ctx.fillStyle = iris;
				ctx.beginPath();
				ctx.arc(0, 0, 46, 0, Math.PI * 2);
				ctx.fill();

				const hi = easeOutCubic(span(t, 1.95, 2.25));
				ctx.fillStyle = `rgba(255, 253, 235, ${hi})`;
				ctx.beginPath();
				ctx.arc(-14, -14, 14 * hi, 0, Math.PI * 2);
				ctx.fill();

				// ---- 红色流光 ----
				if (flow > 0.01 && red > 0.3) {
					const power = flow * red;
					ctx.save();
					ctx.globalCompositeOperation = "lighter";

					// 1) 光彗星绕瞳孔环游：亮头 + 渐隐拖尾，两只眼镜像反向
					const head = t * 5.4 * mirror;
					const STEPS = 22;
					const STEP = 0.075;
					ctx.lineCap = "round";
					for (let j = 0; j < STEPS; j++) {
						const f = j / STEPS;
						const s0 = head - (j + 1) * STEP * mirror;
						const s1 = head - j * STEP * mirror;
						ctx.strokeStyle = `rgba(255, ${70 + Math.round(120 * (1 - f))}, 60, ${Math.pow(1 - f, 1.6) * 0.95 * power})`;
						ctx.lineWidth = 3 + 15 * (1 - f);
						ctx.beginPath();
						ctx.arc(0, 0, 66, Math.min(s0, s1), Math.max(s0, s1));
						ctx.stroke();
					}
					const hx = Math.cos(head) * 66;
					const hy = Math.sin(head) * 66;
					const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 30);
					hg.addColorStop(0, `rgba(255, 235, 220, ${0.9 * power})`);
					hg.addColorStop(0.4, `rgba(255, 90, 70, ${0.5 * power})`);
					hg.addColorStop(1, "rgba(255, 60, 44, 0)");
					ctx.fillStyle = hg;
					ctx.beginPath();
					ctx.arc(hx, hy, 30, 0, Math.PI * 2);
					ctx.fill();

					// 2) 一道亮光斜扫过眼窝，周期约 1.5 秒
					const phase = ((((t - EYE_FLOW_AT) / 1.5) % 1) + 1) % 1;
					const sx = -170 + phase * 340;
					ctx.rotate(-0.5);
					const sheen = ctx.createLinearGradient(sx - 42, 0, sx + 42, 0);
					sheen.addColorStop(0, "rgba(255, 150, 130, 0)");
					sheen.addColorStop(0.5, `rgba(255, 190, 170, ${0.42 * power})`);
					sheen.addColorStop(1, "rgba(255, 150, 130, 0)");
					ctx.fillStyle = sheen;
					ctx.fillRect(sx - 42, -220, 84, 440);
					ctx.restore();
				}
				ctx.restore();
			}
			ctx.restore();
		});
	}

	// 喙
	const beakIn = easeOutCubic(span(t, 1.8, 2.1));
	if (beakIn > 0) {
		ctx.save();
		ctx.translate(0, 100);
		ctx.scale(beakIn, beakIn);
		ctx.translate(0, -100);
		ctx.globalAlpha *= beakIn;
		ctx.fillStyle = BEAK;
		ctx.beginPath();
		ctx.moveTo(0, 552 - 512);
		ctx.lineTo(-48, 610 - 512);
		ctx.quadraticCurveTo(0, 668 - 512, 48, 610 - 512);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}
}
