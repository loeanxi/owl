/**
 * 背景动画引擎：深空星云 + 稀疏星点 + 偶发流星，随 Agent 状态轻微联动。
 *
 * 设计取向：这是「常驻背景」而不是「演出」——必须慢、淡、不抢文字：
 *  - 仅用于毛玻璃系主题（光透过玻璃面板流动）；三团星云（蓝、紫、青，沿用玻璃主题自带的极光色相）
 *    以 70–100 秒为周期缓慢漂移，几乎感觉不到在动；
 *  - 约 110 颗星点只做缓慢呼吸闪烁，不旋转、不位移；
 *  - 每 14–30 秒才划过一颗流星（可关）；
 *  - 状态联动（可关）：工作中主色星云呼吸并略微加快漂移；等待授权/提问时底部泛琥珀；
 *    完成时一圈极淡的涟漪；异常时底部泛红并伴随红色涟漪。
 *
 * 性能：全部是 drawImage（星云/星点是预渲染精灵）+ 少量描边，每帧约 0.3ms；帧率由组件限制（15/20/30）。
 * 引擎只管「画」，何时画、画不画由 AmbientBackground 组件根据窗口可见性/焦点/主题/设置决定。
 */

export type AmbientMood = "idle" | "working" | "waiting";
export type AmbientPulseKind = "done" | "error";

export interface AmbientConfig {
	/** 强度 10–100。 */
	intensity: number;
	/** 偶发流星。 */
	meteors: boolean;
	/** 状态联动。 */
	reactive: boolean;
}

export interface AmbientEngine {
	/** 画布 CSS 尺寸与像素比；尺寸为 0 时不绘制。 */
	resize(width: number, height: number, dpr: number): void;
	setConfig(config: AmbientConfig): void;
	setMood(mood: AmbientMood): void;
	/** 一次性脉冲：完成涟漪 / 异常泛红。仅在 reactive 开启时生效。 */
	pulse(kind: AmbientPulseKind): void;
	/** 绘制一帧；frozen=true 时不推进时间、不出流星与涟漪（暂停/减少动态效果时的静态画面）。 */
	render(nowMs: number, options?: { frozen?: boolean }): void;
}

interface Blob {
	x: number;
	y: number;
	/** 半径，占画布长边的比例。 */
	r: number;
	alpha: number;
	ax: number;
	ay: number;
	period: number;
	phase: number;
}

const BLOBS: readonly Blob[] = [
	{ x: 0.2, y: 0.78, r: 0.62, alpha: 0.5, ax: 0.07, ay: 0.05, period: 84, phase: 0 }, // 主色
	{ x: 0.84, y: 0.2, r: 0.55, alpha: 0.42, ax: 0.06, ay: 0.06, period: 97, phase: 2.1 },
	{ x: 0.58, y: 0.95, r: 0.46, alpha: 0.34, ax: 0.08, ay: 0.04, period: 71, phase: 4.0 },
];

/**
 * 三团星云的 "r,g,b" 配色（第 0 团是主色，工作中会呼吸）。
 * 背景动画只用于毛玻璃系主题：沿用玻璃主题自带极光的色相（蓝 / 紫 / 青），才能和玻璃后面的底色融为一体。
 */
const PALETTE = ["64,112,255", "176,82,255", "0,196,180"] as const;
/** 星云整体亮度倍率：极光底色本身已经够亮，背景光只负责让它「流动」。 */
const NEBULA_SCALE = 0.75;

const STAR_TINTS = ["255,255,255", "190,215,255", "170,255,215"];
const STAR_COUNT = 110;
const TWO_PI = Math.PI * 2;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

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

export interface AmbientStar {
	x: number;
	y: number;
	size: number;
	phase: number;
	speed: number;
	tint: number;
	depth: number;
}

/** 星点布局：确定性，窗口缩放时位置按比例跟随。 */
export function createAmbientStars(count = STAR_COUNT, seed = 20261016): AmbientStar[] {
	const rand = mulberry32(seed);
	const stars: AmbientStar[] = [];
	for (let i = 0; i < count; i++) {
		const depth = rand();
		stars.push({
			x: rand(),
			y: rand(),
			size: 0.7 + depth * 1.3,
			phase: rand() * TWO_PI,
			speed: 0.5 + rand() * 1.5,
			tint: Math.floor(rand() * STAR_TINTS.length),
			depth,
		});
	}
	return stars;
}

/** 强度 10–100 → 亮度增益 0.3–1.3。 */
export function ambientGain(intensity: number): number {
	return 0.3 + (clamp(intensity, 10, 100) / 100) * 1.0;
}

function makeSprite(size: number, paint: (g: CanvasRenderingContext2D, size: number) => void): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = c.height = size;
	paint(c.getContext("2d")!, size);
	return c;
}

const blobSprites = new Map<string, HTMLCanvasElement>();
function blobSprite(rgb: string): HTMLCanvasElement {
	let sprite = blobSprites.get(rgb);
	if (!sprite) {
		// 强调色在设置页里连续拖动会产生很多色值：超过上限就整体清空，避免精灵缓存无限增长
		if (blobSprites.size >= 32) blobSprites.clear();
		// 强调色在设置页里连续拖动会产生很多色值：超过上限就整体清空，避免精灵缓存无限增长
		if (blobSprites.size >= 32) blobSprites.clear();
		sprite = makeSprite(160, (g, s) => {
			const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
			grad.addColorStop(0, `rgba(${rgb}, 1)`);
			grad.addColorStop(0.35, `rgba(${rgb}, 0.5)`);
			grad.addColorStop(0.7, `rgba(${rgb}, 0.14)`);
			grad.addColorStop(1, `rgba(${rgb}, 0)`);
			g.fillStyle = grad;
			g.fillRect(0, 0, s, s);
		});
		blobSprites.set(rgb, sprite);
	}
	return sprite;
}

let starSprites: HTMLCanvasElement[] | undefined;
function starSprite(tint: number): HTMLCanvasElement {
	starSprites ??= STAR_TINTS.map((rgb) =>
		makeSprite(32, (g, s) => {
			const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
			grad.addColorStop(0, `rgba(${rgb}, 1)`);
			grad.addColorStop(0.3, `rgba(${rgb}, 0.85)`);
			grad.addColorStop(1, `rgba(${rgb}, 0)`);
			g.fillStyle = grad;
			g.fillRect(0, 0, s, s);
		}),
	);
	return starSprites[tint % starSprites.length];
}

interface Ripple {
	start: number;
	kind: AmbientPulseKind;
}

interface LiveMeteor {
	start: number;
	dur: number;
	x: number;
	y: number;
	angle: number;
	tail: number;
	travel: number;
}

/** 一次涟漪的持续时间（秒）。 */
const RIPPLE_SECONDS = 2.6;
const ERROR_SECONDS = 2.8;

export function createAmbientEngine(
	ctx: CanvasRenderingContext2D,
	options: { random?: () => number } = {},
): AmbientEngine {
	const rand = options.random ?? Math.random;
	const stars = createAmbientStars();
	let w = 0;
	let h = 0;
	let dpr = 1;
	let config: AmbientConfig = { intensity: 45, meteors: true, reactive: true };
	let mood: AmbientMood = "idle";
	let last: number | undefined;
	/** 视觉时钟（星点闪烁、涟漪、流星），暂停期间不走。 */
	let t = 0;
	/** 漂移时钟：工作中走得更快一点。 */
	let drift = 0;
	let work = 0;
	let wait = 0;
	let err = 0;
	const ripples: Ripple[] = [];
	let meteor: LiveMeteor | undefined;
	let nextMeteorAt = 3 + rand() * 4;

	function drawBlob(sprite: HTMLCanvasElement, cx: number, cy: number, radius: number, alpha: number): void {
		if (alpha <= 0.004) return;
		ctx.globalAlpha = clamp(alpha, 0, 1);
		ctx.drawImage(sprite, cx - radius, cy - radius, radius * 2, radius * 2);
	}

	function spawnMeteor(): void {
		const diag = Math.hypot(w, h);
		meteor = {
			start: t,
			dur: 1 + rand() * 0.5,
			x: (0.45 + rand() * 0.6) * w,
			y: (-0.05 + rand() * 0.25) * h,
			angle: Math.PI * (0.8 + (rand() - 0.5) * 0.06),
			tail: diag * (0.1 + rand() * 0.06),
			travel: diag * (0.5 + rand() * 0.2),
		};
	}

	return {
		resize(width, height, ratio) {
			w = width;
			h = height;
			dpr = ratio;
		},
		setConfig(next) {
			config = next;
		},
		setMood(next) {
			mood = next;
		},
		pulse(kind) {
			if (!config.reactive) return;
			ripples.push({ start: t, kind });
			if (ripples.length > 3) ripples.shift();
			if (kind === "error") err = 1;
		},
		render(nowMs, renderOptions = {}) {
			if (w < 2 || h < 2) return;
			const frozen = renderOptions.frozen === true;
			const dt = frozen || last === undefined ? 0 : Math.min((nowMs - last) / 1000, 0.25);
			last = nowMs;
			t += dt;
			const reactive = config.reactive;
			const workTarget = reactive && mood === "working" ? 1 : 0;
			const waitTarget = reactive && mood === "waiting" ? 1 : 0;
			const follow = 1 - Math.exp(-dt * 2.5);
			work += (workTarget - work) * follow;
			wait += (waitTarget - wait) * follow;
			err = reactive ? Math.max(0, err - dt / ERROR_SECONDS) : 0;
			drift += dt * (1 + 0.8 * work);

			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			const gain = ambientGain(config.intensity);
			const long = Math.max(w, h);

			// ---- 星云 ----
			BLOBS.forEach((b, i) => {
				const cx = (b.x + b.ax * Math.sin((TWO_PI * drift) / b.period + b.phase)) * w;
				const cy = (b.y + b.ay * Math.cos((TWO_PI * drift * 1.3) / b.period + b.phase)) * h;
				const breathe = i === 0 ? 1 + 0.55 * work * (0.5 + 0.5 * Math.sin((TWO_PI * t) / 3.2)) : 1;
				drawBlob(blobSprite(PALETTE[i]), cx, cy, b.r * long, b.alpha * gain * NEBULA_SCALE * breathe);
			});
			// 等待授权/提问：底部泛琥珀，节奏比工作更缓、更显眼一点
			if (wait > 0.01) {
				drawBlob(
					blobSprite("255,170,50"),
					w * 0.5,
					h * 1.0,
					long * 0.5,
					0.42 * gain * wait * (0.65 + 0.35 * Math.sin((TWO_PI * t) / 2.2)),
				);
			}
			// 异常：底部泛红，随时间衰减
			if (err > 0.01) {
				drawBlob(blobSprite("255,60,44"), w * 0.5, h * 0.93, long * 0.55, 0.55 * gain * Math.pow(err, 1.5));
			}

			// ---- 星点 ----
			const starGain = 0.5 + 0.9 * (clamp(config.intensity, 10, 100) / 100);
			for (const s of stars) {
				const twinkle = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
				const alpha = (0.25 + 0.75 * s.depth) * twinkle * starGain;
				if (alpha < 0.03) continue;
				ctx.globalAlpha = clamp(alpha, 0, 1);
				const d = s.size * 2.4;
				ctx.drawImage(starSprite(s.tint), s.x * w - d, s.y * h - d, d * 2, d * 2);
			}

			// ---- 偶发流星 / 涟漪（冻结画面不出）----
			if (!frozen) {
				if (config.meteors) {
					if (!meteor && t >= nextMeteorAt) {
						spawnMeteor();
						nextMeteorAt = t + 14 + rand() * 16;
					}
				} else {
					meteor = undefined;
				}
				if (meteor) {
					const p = (t - meteor.start) / meteor.dur;
					if (p >= 1) {
						meteor = undefined;
					} else {
						const dx = Math.cos(meteor.angle);
						const dy = Math.sin(meteor.angle);
						const hx = meteor.x + dx * meteor.travel * p;
						const hy = meteor.y + dy * meteor.travel * p;
						const len = meteor.tail * (0.4 + 0.6 * Math.min(1, p * 4));
						const a = Math.pow(Math.sin(p * Math.PI), 0.6) * 0.8 * Math.min(1, gain);
						const g = ctx.createLinearGradient(hx - dx * len, hy - dy * len, hx, hy);
						g.addColorStop(0, "rgba(225,250,255,0)");
						g.addColorStop(1, `rgba(255,255,255,${a})`);
						ctx.globalAlpha = 1;
						ctx.strokeStyle = g;
						ctx.lineWidth = 1.4;
						ctx.lineCap = "round";
						ctx.beginPath();
						ctx.moveTo(hx - dx * len, hy - dy * len);
						ctx.lineTo(hx, hy);
						ctx.stroke();
					}
				}
				for (let i = ripples.length - 1; i >= 0; i--) {
					const p = (t - ripples[i].start) / RIPPLE_SECONDS;
					if (p >= 1) {
						ripples.splice(i, 1);
						continue;
					}
					const rgb = ripples[i].kind === "error" ? "255,90,76" : "110,235,165";
					const radius = easeOutCubic(p) * long * 0.55;
					const base = ripples[i].kind === "error" ? 0.4 : 0.26;
					ctx.globalAlpha = 1;
					ctx.lineWidth = 1.5;
					ctx.strokeStyle = `rgba(${rgb}, ${base * Math.pow(1 - p, 1.5) * Math.min(1, gain)})`;
					ctx.beginPath();
					ctx.arc(w * 0.5, h * 0.86, radius, 0, TWO_PI);
					ctx.stroke();
				}
			}
			ctx.globalAlpha = 1;
		},
	};
}
