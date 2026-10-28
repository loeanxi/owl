import { createStars, drawSplashFrame, SPLASH_DURATION, SPLASH_FADE_START } from "./startup-splash-scene.ts";

export type SplashWorkerRequest =
	| {
			type: "init";
			canvas: OffscreenCanvas;
			width: number;
			height: number;
			dpr: number;
			speed: number;
			meteors: boolean;
	  }
	| { type: "start" }
	| { type: "resize"; width: number; height: number; dpr: number }
	| { type: "skip" }
	| { type: "dispose" };

export type SplashWorkerEvent = { type: "ready" } | { type: "finished" } | { type: "error"; message: string };

/** The desktop program uses DOM types; keep the worker surface local instead of mixing global libraries. */
interface SplashWorkerScope {
	onmessage: ((event: MessageEvent<SplashWorkerRequest>) => void) | null;
	postMessage: (message: SplashWorkerEvent) => void;
	requestAnimationFrame?: (callback: FrameRequestCallback) => number;
	cancelAnimationFrame?: (handle: number) => void;
	setTimeout: (callback: () => void, delay: number) => number;
	clearTimeout: (handle: number) => void;
	performance: Pick<Performance, "now">;
}

const scope = self as unknown as SplashWorkerScope;
let canvas: OffscreenCanvas | undefined;
let ctx: OffscreenCanvasRenderingContext2D | undefined;
let stars: ReturnType<typeof createStars> | undefined;
let width = 1;
let height = 1;
let dpr = 1;
let speed = 1;
let meteors = true;
let startedAt: number | undefined;
let frame: number | undefined;
let timer: number | undefined;
let running = false;
let stopped = false;

function cancelScheduled(): void {
	if (frame !== undefined) scope.cancelAnimationFrame?.(frame);
	if (timer !== undefined) scope.clearTimeout(timer);
	frame = undefined;
	timer = undefined;
}

function fail(error: unknown): void {
	if (stopped) return;
	stopped = true;
	running = false;
	cancelScheduled();
	scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function applySize(): void {
	if (!canvas || !ctx) return;
	canvas.width = Math.max(1, Math.round(width * dpr));
	canvas.height = Math.max(1, Math.round(height * dpr));
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function render(t: number): void {
	if (ctx && stars) drawSplashFrame(ctx, width, height, t, stars, { meteors });
}

function schedule(): void {
	if (scope.requestAnimationFrame && scope.cancelAnimationFrame) {
		frame = scope.requestAnimationFrame(tick);
	} else {
		timer = scope.setTimeout(() => tick(scope.performance.now()), 16);
	}
}

function tick(now: number): void {
	frame = undefined;
	timer = undefined;
	if (!running || stopped || startedAt === undefined) return;
	try {
		const t = ((now - startedAt) / 1000) * speed;
		render(t);
		if (t >= SPLASH_DURATION) {
			running = false;
			stopped = true;
			scope.postMessage({ type: "finished" });
			return;
		}
		schedule();
	} catch (error) {
		fail(error);
	}
}

scope.onmessage = ({ data }): void => {
	try {
		if (data.type === "dispose") {
			stopped = true;
			running = false;
			cancelScheduled();
			ctx = undefined;
			canvas = undefined;
			stars = undefined;
			startedAt = undefined;
			scope.onmessage = null;
			return;
		}
		if (stopped) return;
		switch (data.type) {
			case "init": {
				if (canvas) return;
				canvas = data.canvas;
				const context = canvas.getContext("2d", { alpha: false });
				if (!context) throw new Error("Startup worker could not create a Canvas 2D context.");
				ctx = context;
				width = data.width;
				height = data.height;
				dpr = data.dpr;
				speed = data.speed;
				meteors = data.meteors;
				stars = createStars();
				applySize();
				// Warm the static scene before ready; hidden-window time never enters the timeline.
				render(0);
				scope.postMessage({ type: "ready" });
				break;
			}
			case "start":
				if (!ctx || running) return;
				startedAt = scope.performance.now();
				running = true;
				render(0);
				schedule();
				break;
			case "resize":
				width = data.width;
				height = data.height;
				dpr = data.dpr;
				applySize();
				render(startedAt === undefined ? 0 : ((scope.performance.now() - startedAt) / 1000) * speed);
				break;
			case "skip": {
				if (startedAt === undefined) return;
				const elapsed = ((scope.performance.now() - startedAt) / 1000) * speed;
				if (elapsed < SPLASH_FADE_START) startedAt -= ((SPLASH_FADE_START - elapsed) / speed) * 1000;
				break;
			}
		}
	} catch (error) {
		fail(error);
	}
};
