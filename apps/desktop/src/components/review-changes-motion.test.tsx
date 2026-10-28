import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewChangesMotion } from "./use-review-changes-motion.ts";

interface TestAnimation {
	cancel: ReturnType<typeof vi.fn>;
	onfinish: Animation["onfinish"];
}

class TestIntersectionObserver {
	callback: (entries: Array<{ isIntersecting: boolean }>) => void;
	observe = vi.fn();
	disconnect = vi.fn();
	constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
		this.callback = callback;
		observers.push(this);
	}
	emit(isIntersecting: boolean): void {
		this.callback([{ isIntersecting }]);
	}
}

let container: HTMLElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let observers: TestIntersectionObserver[];
let animations: TestAnimation[];
let animate: ReturnType<typeof vi.fn<HTMLElement["animate"]>>;
let mediaListeners: Set<() => void>;
let media: {
	matches: boolean;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
};

function attachAnimation(element: HTMLDivElement | null): void {
	if (element) element.animate = animate;
}

function MotionFixture({ collapsed }: { collapsed: boolean }): React.JSX.Element {
	const ref = useReviewChangesMotion(collapsed, "test-turn");
	return (
		<section ref={ref}>
			<div className="owl-changes-item" ref={attachAnimation}>
				one.ts
			</div>
			<div className="owl-changes-item" ref={attachAnimation}>
				two.ts
			</div>
		</section>
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	dom.window.removeEventListener = vi.fn(dom.window.removeEventListener.bind(dom.window));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(dom.document, "hidden", { configurable: true, value: false });
	frames = new Map();
	nextFrame = 0;
	observers = [];
	animations = [];
	mediaListeners = new Set();
	media = {
		matches: false,
		addEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.add(listener)),
		removeEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.delete(listener)),
	};
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => media),
	);
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameRequestCallback) => {
			const id = ++nextFrame;
			frames.set(id, callback);
			return id;
		}),
	);
	vi.stubGlobal(
		"cancelAnimationFrame",
		vi.fn((id: number) => frames.delete(id)),
	);
	vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
	animate = vi.fn((_keyframes, _options) => {
		const animation: TestAnimation = { cancel: vi.fn(), onfinish: null };
		animations.push(animation);
		return animation as unknown as Animation;
	});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function render(collapsed: boolean): Promise<HTMLElement> {
	await act(async () => root.render(<MotionFixture collapsed={collapsed} />));
	const card = container.querySelector<HTMLElement>("section")!;
	vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
		x: 10,
		y: 20,
		left: 10,
		top: 20,
		right: 410,
		bottom: 100,
		width: 400,
		height: 80,
		toJSON: () => ({}),
	});
	return card;
}

function pointer(card: HTMLElement, type: string, x = 90, y = 60): void {
	const event = new window.Event(type);
	Object.assign(event, { pointerType: "mouse", clientX: x, clientY: y });
	card.dispatchEvent(event);
}

function flushFrames(): void {
	const current = [...frames.values()];
	frames.clear();
	for (const callback of current) callback(performance.now());
}

describe("review changes motion", () => {
	it("lights the collapsed summary on pointer interaction and stops each trace", async () => {
		const card = await render(true);
		expect(frames.size).toBe(0);
		pointer(card, "pointerenter");
		pointer(card, "pointermove", 130, 90);
		flushFrames();
		expect(card.classList.contains("is-pointer-active")).toBe(true);
		expect(card.classList.contains("is-tracing")).toBe(true);
		expect(card.style.getPropertyValue("--owl-changes-pointer-x")).toBe("120px");
		expect(card.style.getPropertyValue("--owl-changes-pointer-y")).toBe("70px");
		vi.runOnlyPendingTimers();
		expect(card.classList.contains("is-tracing")).toBe(false);
		expect(frames.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		pointer(card, "pointerleave");
		expect(card.classList.contains("is-pointer-active")).toBe(false);
		pointer(card, "pointerenter");
		flushFrames();
		expect(card.classList.contains("is-tracing")).toBe(true);
		vi.runOnlyPendingTimers();
		expect(card.classList.contains("is-tracing")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(animate).not.toHaveBeenCalled();
	});

	it("does not schedule pointer or row animations when reduced motion is requested", async () => {
		media.matches = true;
		const card = await render(false);
		pointer(card, "pointerenter");
		pointer(card, "pointermove");
		expect(requestAnimationFrame).not.toHaveBeenCalled();
		expect(animate).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(card.classList.contains("is-pointer-active")).toBe(false);
		expect(card.classList.contains("is-tracing")).toBe(false);
	});

	it("animates file rows only when expanding and cancels them when collapsing again", async () => {
		await render(true);
		expect(animate).not.toHaveBeenCalled();
		await render(false);
		expect(animate).toHaveBeenCalledTimes(2);
		expect(animations.every((animation) => animation.cancel.mock.calls.length === 0)).toBe(true);
		await render(true);
		expect(animate).toHaveBeenCalledTimes(2);
		expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
	});

	it("stops offscreen work and releases frames, timers and subscriptions on unmount", async () => {
		const card = await render(false);
		const removeCard = vi.spyOn(card, "removeEventListener");
		const removeDocument = vi.spyOn(document, "removeEventListener");
		const removeWindow = window.removeEventListener;
		pointer(card, "pointerenter");
		flushFrames();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		observers[0].emit(false);
		expect(card.classList.contains("is-tracing")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		pointer(card, "pointermove");
		expect(frames.size).toBe(0);
		observers[0].emit(true);
		pointer(card, "pointerenter");
		flushFrames();
		pointer(card, "pointermove");
		expect(frames.size).toBeGreaterThan(0);
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		await act(async () => root.render(null));
		expect(frames.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(cancelAnimationFrame).toHaveBeenCalled();
		expect(observers[0].disconnect).toHaveBeenCalledOnce();
		expect(mediaListeners.size).toBe(0);
		expect(removeCard.mock.calls.map(([type]) => type)).toEqual(
			expect.arrayContaining(["pointerenter", "pointermove", "pointerleave"]),
		);
		expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
		expect(removeWindow).toHaveBeenCalledWith("resize", expect.any(Function));
		expect(removeWindow).toHaveBeenCalledWith("scroll", expect.any(Function), true);
		expect(card.style.getPropertyValue("--owl-changes-pointer-x") || "").toBe("");
		expect(card.style.getPropertyValue("--owl-changes-pointer-y") || "").toBe("");
		pointer(card, "pointerenter");
		expect(frames.size).toBe(0);
	});
});
