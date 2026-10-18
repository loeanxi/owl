import { getOwlAnimation, STARTUP_FAST_FACTOR, systemPrefersReducedMotion } from "./animation-settings.ts";
import { createStars, drawSplashFrame, easeInOutCubic, SPLASH_BACKGROUND, SPLASH_DURATION, SPLASH_FADE_START } from "./startup-splash-scene.ts";
import type { SplashWorkerEvent, SplashWorkerRequest } from "./startup-splash.worker.ts";

export { clamp01, createMeteors, createStars, drawSplashFrame, easeInOutCubic, easeOutBack, easeOutCubic, eyeOpenness, eyeRedness, span, SPLASH_DURATION, SPLASH_FADE_START } from "./startup-splash-scene.ts";
export type { Meteor, SplashStars } from "./startup-splash-scene.ts";

export interface StartupSplashHandle {
	dismiss: () => void;
}

export interface StartupSplashOptions {
	/** 测试或调试用；默认读取 document。 */
	doc?: Document;
	/** 设置页预览：忽略启动开关与系统减少动态效果。 */
	force?: boolean;
}

/** 绘制在 Worker 中完成，避免 App 恢复会话等主线程任务打断星空。 */
export function playStartupSplash(options: StartupSplashOptions = {}): StartupSplashHandle {
	const noop: StartupSplashHandle = { dismiss: () => {} };
	const doc = options.doc ?? (typeof document === "undefined" ? undefined : document);
	if (!doc || typeof requestAnimationFrame !== "function") return noop;
	const settings = getOwlAnimation();
	if (!options.force && (!settings.startupEnabled || (settings.respectReducedMotion && systemPrefersReducedMotion()))) return noop;
	if (doc.querySelector("[data-owl-startup-splash]")) return noop;
	let canvas = doc.createElement("canvas");
	if (typeof canvas.getContext !== "function") return noop;
	const speed = settings.startupSpeed === "fast" ? STARTUP_FAST_FACTOR : 1;
	const host = doc.createElement("div");
	host.setAttribute("data-owl-startup-splash", "");
	host.setAttribute("aria-hidden", "true");
	host.style.cssText = `position:fixed;inset:0;z-index:2147483000;background:${SPLASH_BACKGROUND};cursor:default;contain:strict;will-change:opacity;`;
	canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
	host.appendChild(canvas);
	doc.body.appendChild(host);

	let width = window.innerWidth;
	let height = window.innerHeight;
	let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
	let worker: Worker | undefined;
	let transferred = false;
	let waitingToStart = false;
	let ctx: CanvasRenderingContext2D | null = null;
	let raf = 0;
	let startedAt: number | undefined;
	let fadeAnimation: Animation | undefined;
	let workerTimeout: ReturnType<typeof setTimeout> | undefined;
	let safety: ReturnType<typeof setTimeout> | undefined;
	let observer: ResizeObserver | undefined;
	let done = false;
	const stars = createStars();

	const finish = (): void => {
		if (done) return;
		done = true;
		cancelAnimationFrame(raf);
		clearTimeout(safety);
		clearTimeout(workerTimeout);
		fadeAnimation?.cancel();
		worker?.terminate();
		worker = undefined;
		observer?.disconnect();
		removeEventListener("keydown", onSkip, true);
		host.removeEventListener("pointerdown", onSkip);
		host.remove();
	};

	const tick = (now: number): void => {
		if (done || !ctx) return;
		if (startedAt === undefined) startedAt = now;
		const elapsed = ((now - startedAt) / 1000) * speed;
		try {
			const alpha = drawSplashFrame(ctx, width, height, elapsed, stars, { meteors: settings.startupMeteors });
			host.style.opacity = String(Math.max(alpha, 0));
		} catch {
			finish();
			return;
		}
		if (elapsed >= SPLASH_DURATION) finish();
		else raf = requestAnimationFrame(tick);
	};

	// 转移过的 HTML canvas 不能再拿 2D context；Worker 失败时替换画布再走原绘制路径。
	const fallback = (): void => {
		if (done || ctx) return;
		clearTimeout(workerTimeout);
		cancelAnimationFrame(raf);
		fadeAnimation?.cancel();
		fadeAnimation = undefined;
		worker?.terminate();
		worker = undefined;
		if (transferred) {
			const replacement = doc.createElement("canvas");
			replacement.style.cssText = canvas.style.cssText;
			canvas.replaceWith(replacement);
			canvas = replacement;
			transferred = false;
		}
		try { ctx = canvas.getContext("2d", { alpha: false }); } catch { ctx = null; }
		if (!ctx) { finish(); return; }
		canvas.width = Math.max(1, Math.round(width * dpr));
		canvas.height = Math.max(1, Math.round(height * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		raf = requestAnimationFrame(tick);
	};

	const onSkip = (): void => {
		if (startedAt === undefined) return;
		const elapsed = ((performance.now() - startedAt) / 1000) * speed;
		if (elapsed >= SPLASH_FADE_START) return;
		startedAt -= ((SPLASH_FADE_START - elapsed) / speed) * 1000;
		worker?.postMessage({ type: "skip" } satisfies SplashWorkerRequest);
		if (fadeAnimation) fadeAnimation.currentTime = (SPLASH_FADE_START / speed) * 1000;
	};

	observer = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
		const rect = entries[0]?.contentRect;
		if (!rect || rect.width < 1 || rect.height < 1) return;
		const nextDpr = Math.min(window.devicePixelRatio || 1, 1.5);
		if (Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1 && nextDpr === dpr) return;
		width = rect.width;
		height = rect.height;
		dpr = nextDpr;
		if (worker) worker.postMessage({ type: "resize", width, height, dpr } satisfies SplashWorkerRequest);
		else if (ctx) {
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
	}) : undefined;
	observer?.observe(host);
	safety = setTimeout(finish, 15000);
	addEventListener("keydown", onSkip, true);
	host.addEventListener("pointerdown", onSkip);

	// 只有完整支持独立画布及合成器淡出时才走 Worker，旧 WebView 保留主线程回退。
	if (typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof canvas.transferControlToOffscreen === "function" && typeof host.animate === "function") {
		try {
			worker = new Worker(new URL("./startup-splash.worker.ts", import.meta.url), { type: "module", name: "owl-startup" });
			worker.onmessage = (event: MessageEvent<SplashWorkerEvent>) => {
				if (done || !worker) return;
				if (event.data.type === "error") { fallback(); return; }
				if (event.data.type === "finished") { finish(); return; }
				if (event.data.type !== "ready" || waitingToStart || startedAt !== undefined) return;
				waitingToStart = true;
				clearTimeout(workerTimeout);
				// 先预热离屏图层，再等窗口第一条可见 rAF；不改变原生窗口的启动揭示依赖。
				raf = requestAnimationFrame((now) => {
					if (done || !worker) return;
					try {
						startedAt = now;
						// opacity 在合成器执行；主线程忙时，末尾淡出也不会逐帧停顿。
						fadeAnimation = host.animate(Array.from({ length: 33 }, (_, index) => ({ offset: index / 32, opacity: 1 - easeInOutCubic(index / 32) })), {
							delay: (SPLASH_FADE_START / speed) * 1000,
							duration: ((SPLASH_DURATION - SPLASH_FADE_START) / speed) * 1000,
							fill: "forwards",
						});
						worker.postMessage({ type: "start" } satisfies SplashWorkerRequest);
					} catch { fallback(); }
				});
			};
			worker.onerror = (event) => { event.preventDefault(); fallback(); };
			worker.onmessageerror = fallback;
			const offscreen = canvas.transferControlToOffscreen();
			transferred = true;
			worker.postMessage({ type: "init", canvas: offscreen, width, height, dpr, speed, meteors: settings.startupMeteors } satisfies SplashWorkerRequest, [offscreen]);
			workerTimeout = setTimeout(fallback, 1000);
		} catch { fallback(); }
	} else fallback();
	return { dismiss: finish };
}
