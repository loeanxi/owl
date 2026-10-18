import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOwlAnimation } from "./animation-settings.ts";
import { playStartupSplash } from "./startup-splash.ts";
import * as scene from "./startup-splash-scene.ts";
import type { SplashWorkerEvent } from "./startup-splash.worker.ts";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let getContext: ReturnType<typeof vi.fn>;
let animate: ReturnType<typeof vi.fn>;
let fade: { cancel: ReturnType<typeof vi.fn>; currentTime: number };
let resize: ResizeObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;

class TestWorker {
	static instances: TestWorker[] = [];
	onmessage: ((event: MessageEvent<SplashWorkerEvent>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() { TestWorker.instances.push(this); }
	emit(data: SplashWorkerEvent): void { this.onmessage?.({ data } as MessageEvent<SplashWorkerEvent>); }
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("addEventListener", dom.window.addEventListener.bind(dom.window));
	vi.stubGlobal("removeEventListener", dom.window.removeEventListener.bind(dom.window));
	vi.stubGlobal("matchMedia", () => ({ matches: false }));
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
	vi.stubGlobal("Worker", TestWorker);
	vi.stubGlobal("OffscreenCanvas", class {});
	Object.assign(dom.window, { innerWidth: 1742, innerHeight: 1074, devicePixelRatio: 2 });
	frames.clear(); frameId = 0; TestWorker.instances = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	fade = { cancel: vi.fn(), currentTime: 0 };
	animate = vi.fn(() => fade);
	getContext = vi.fn(() => ({ setTransform: vi.fn() }));
	const create = dom.document.createElement.bind(dom.document);
	vi.spyOn(dom.document, "createElement").mockImplementation((tag: string) => {
		const element = create(tag);
		Object.assign(element, { animate });
		if (tag === "canvas") Object.assign(element, { getContext, transferControlToOffscreen: vi.fn(() => ({})) });
		return element;
	});
	disconnect = vi.fn();
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: ResizeObserverCallback) { resize = callback; }
		observe = vi.fn();
		disconnect = disconnect;
	});
	vi.spyOn(scene, "drawSplashFrame").mockReturnValue(1);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	applyOwlAnimation({ startupEnabled: true });
});

afterEach(() => {
	vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function nextFrame(now = performance.now()): void {
	const pending = [...frames.values()]; frames.clear();
	for (const callback of pending) callback(now);
}

const host = (): HTMLElement | null => document.querySelector("[data-owl-startup-splash]");
const worker = (): TestWorker => TestWorker.instances[0];

describe("startup splash render ownership and lifecycle", () => {
	it("prewarms off-thread, then waits for a visible frame before starting the timeline", () => {
		const handle = playStartupSplash();
		expect(getContext).not.toHaveBeenCalled();
		expect(worker().postMessage.mock.calls[0][0]).toMatchObject({ type: "init", width: 1742, height: 1074, dpr: 1.5, speed: 1, meteors: true });
		worker().emit({ type: "ready" });
		vi.advanceTimersByTime(2500);
		expect(worker().postMessage).toHaveBeenCalledTimes(1);
		expect(animate).not.toHaveBeenCalled();
		nextFrame();
		expect(worker().postMessage).toHaveBeenLastCalledWith({ type: "start" });
		expect(animate.mock.calls[0][1]).toMatchObject({ delay: 3700, duration: 500, fill: "forwards" });
		handle.dismiss();
	});

	it("skips through the same fade once and preserves fast playback and meteor settings", () => {
		applyOwlAnimation({ startupSpeed: "fast", startupMeteors: false });
		playStartupSplash(); worker().emit({ type: "ready" }); nextFrame();
		expect(worker().postMessage.mock.calls[0][0]).toMatchObject({ speed: 1.7, meteors: false });
		expect(animate.mock.calls[0][1].delay).toBeCloseTo(3700 / 1.7);
		vi.advanceTimersByTime(200);
		host()!.dispatchEvent(new window.Event("pointerdown"));
		expect(worker().postMessage).toHaveBeenLastCalledWith({ type: "skip" });
		expect(fade.currentTime).toBeCloseTo(3700 / 1.7);
		host()!.dispatchEvent(new window.Event("pointerdown"));
		expect(worker().postMessage.mock.calls.filter(([message]) => message.type === "skip")).toHaveLength(1);
		worker().emit({ type: "finished" });
		expect(host()).toBeNull();
	});

	it("ignores duplicate worker readiness without resetting the fade or losing pending frames", () => {
		const handle = playStartupSplash();
		worker().emit({ type: "ready" }); worker().emit({ type: "ready" });
		expect(frames.size).toBe(1);
		nextFrame(); worker().emit({ type: "ready" }); nextFrame();
		expect(animate).toHaveBeenCalledOnce();
		expect(worker().postMessage.mock.calls.filter(([message]) => message.type === "start")).toHaveLength(1);
		handle.dismiss();
	});

	it.each(["animation", "start"])("falls back immediately when %s setup throws after worker readiness", (failure) => {
		const handle = playStartupSplash();
		if (failure === "animation") animate.mockImplementation(() => { throw new Error("animation unavailable"); });
		else worker().postMessage.mockImplementation((message) => { if (message.type === "start") throw new Error("worker lost"); });
		worker().emit({ type: "ready" });
		expect(() => nextFrame()).not.toThrow();
		expect(getContext).toHaveBeenCalledOnce();
		nextFrame(); expect(scene.drawSplashFrame).toHaveBeenCalled();
		handle.dismiss(); expect(vi.getTimerCount()).toBe(0);
	});

	it("resizes the worker without resetting playback or creating a second instance", () => {
		playStartupSplash(); playStartupSplash({ force: true });
		expect(TestWorker.instances).toHaveLength(1);
		worker().emit({ type: "ready" }); nextFrame();
		resize([{ contentRect: { width: 960, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
		expect(worker().postMessage).toHaveBeenLastCalledWith({ type: "resize", width: 960, height: 700, dpr: 1.5 });
		expect(animate).toHaveBeenCalledTimes(1);
		worker().emit({ type: "finished" });
		expect(worker().terminate).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(fade.cancel).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("replaces a transferred canvas if the worker fails and retains the original fallback", () => {
		playStartupSplash();
		const transferred = host()!.querySelector("canvas");
		worker().emit({ type: "error", message: "worker blocked" });
		expect(host()!.querySelector("canvas")).not.toBe(transferred);
		expect(getContext).toHaveBeenCalledWith("2d", { alpha: false });
		expect(worker().terminate).toHaveBeenCalledTimes(1);
		nextFrame();
		expect(scene.drawSplashFrame).toHaveBeenCalled();
		nextFrame(4200);
		expect(host()).toBeNull();
	});

	it("falls back on a silent worker and removes unsupported Canvas hosts immediately", () => {
		const handle = playStartupSplash();
		vi.advanceTimersByTime(1000);
		expect(getContext).toHaveBeenCalledOnce();
		handle.dismiss(); handle.dismiss();
		expect(frames.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		vi.stubGlobal("Worker", undefined);
		getContext.mockReturnValue(null);
		playStartupSplash();
		expect(host()).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("respects the off/reduced-motion settings while allowing an explicit preview", () => {
		applyOwlAnimation({ startupEnabled: false }); playStartupSplash(); expect(host()).toBeNull();
		applyOwlAnimation({ startupEnabled: true });
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		playStartupSplash(); expect(host()).toBeNull();
		const handle = playStartupSplash({ force: true }); expect(host()).not.toBeNull();
		handle.dismiss();
		expect(worker().terminate).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("unblocks the application if playback never finishes", () => {
		playStartupSplash(); worker().emit({ type: "ready" }); nextFrame();
		vi.advanceTimersByTime(15000);
		expect(host()).toBeNull();
		expect(worker().terminate).toHaveBeenCalledOnce();
		expect(disconnect).toHaveBeenCalledOnce();
	});
});
