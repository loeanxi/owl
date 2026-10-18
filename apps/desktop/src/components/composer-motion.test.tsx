import type * as React from "react";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerMotion } from "./use-composer-motion.ts";

interface TestAnimation {
	element: Element;
	cancel: ReturnType<typeof vi.fn>;
	onfinish: Animation["onfinish"];
	oncancel: Animation["oncancel"];
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

class TestMutationObserver {
	callback: () => void;
	observe = vi.fn();
	disconnect = vi.fn();
	constructor(callback: () => void) {
		this.callback = callback;
		preferenceObservers.push(this);
	}
}

interface Question {
	index: number;
	position?: "clipped" | "outside-window";
}

interface FixtureProps {
	owner?: string;
	client?: object;
	isCurrent?: () => boolean;
	questions?: Question[];
	foreignQuestions?: Question[];
	conversationClass?: string;
}

const defaultClient = {};
let motion: ReturnType<typeof useComposerMotion>;
let container: HTMLElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let observers: TestIntersectionObserver[];
let preferenceObservers: TestMutationObserver[];
let animations: TestAnimation[];
let mediaListeners: Set<() => void>;
let media: {
	matches: boolean;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
};

function MotionFixture({
	owner = "conversation-a",
	client = defaultClient,
	isCurrent,
	questions = [{ index: 1 }],
	foreignQuestions = [],
	conversationClass = "owl-agent-conversation",
}: FixtureProps): React.JSX.Element {
	const surfaceRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLDivElement>(null);
	motion = useComposerMotion({ surfaceRef, inputRef, owner, client, isCurrent });
	return (
		<>
			<section className={conversationClass}>
				<div className="owl-chat-scroll">
					{questions.map(({ index, position }) => (
						<div key={index} className="owl-chat-question" data-qidx={index}>
							<div className="owl-user-bubble" data-position={position}>Message {index}</div>
						</div>
					))}
				</div>
				<div ref={surfaceRef} data-testid="surface">
					<div ref={inputRef}>
						<div className="owl-composer-accept-glint" />
						<div className="owl-composer-send-glint" />
						<div className="owl-composer-editor">Unchanged draft</div>
						<button className="owl-composer-action" type="button">Send</button>
					</div>
				</div>
			</section>
			<section className="owl-agent-conversation" data-testid="foreign-conversation">
				<div className="owl-chat-scroll">
					{foreignQuestions.map(({ index }) => (
						<div key={index} className="owl-chat-question" data-qidx={index}>
							<div className="owl-user-bubble">Foreign message {index}</div>
						</div>
					))}
				</div>
			</section>
		</>
	);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) };
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("innerWidth", 1000);
	vi.stubGlobal("innerHeight", 800);
	Object.defineProperty(dom.document, "hidden", { configurable: true, value: false });
	frames = new Map();
	nextFrame = 0;
	observers = [];
	preferenceObservers = [];
	animations = [];
	mediaListeners = new Set();
	media = {
		matches: false,
		addEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.add(listener)),
		removeEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.delete(listener)),
	};
	vi.stubGlobal("matchMedia", vi.fn(() => media));
	vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
		const id = ++nextFrame;
		frames.set(id, callback);
		return id;
	}));
	vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
	vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
	vi.stubGlobal("MutationObserver", TestMutationObserver);
	vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.classList.contains("owl-user-bubble")) {
			return rect(400, this.dataset.position === "clipped" ? 600 : this.dataset.position === "outside-window" ? -200 : 400, 300, 80);
		}
		if (this.classList.contains("owl-chat-scroll")) return rect(20, 20, 700, 560);
		return rect(680, 700, 40, 40);
	});
	Object.defineProperty(dom.window.HTMLElement.prototype, "animate", {
		configurable: true,
		value: vi.fn(function (this: HTMLElement) {
			const animation: TestAnimation = {
				element: this,
				cancel: vi.fn(() => animation.oncancel?.call(animation as unknown as Animation, {} as AnimationPlaybackEvent)),
				onfinish: null,
				oncancel: null,
			};
			animations.push(animation);
			return animation as unknown as Animation;
		}),
	});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(props: FixtureProps = {}): Promise<void> {
	await act(async () => root.render(<MotionFixture {...props} />));
}

function flushFrame(): void {
	const current = [...frames.values()];
	frames.clear();
	for (const callback of current) callback(performance.now());
}

function relay(): HTMLElement | null {
	return document.querySelector(".owl-composer-relay");
}

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
	document.dispatchEvent(new window.Event("visibilitychange"));
}

describe("composer motion", () => {
	it("gives suggestion feedback without changing the draft or adding messages", async () => {
		await render();
		observers[0].emit(true);
		motion.acceptSuggestion();
		expect(animations.map(({ element }) => element.className)).toEqual([
			"owl-composer-accept-glint", "owl-composer-editor",
		]);
		expect(container.querySelector(".owl-composer-editor")?.textContent).toBe("Unchanged draft");
		expect(container.querySelectorAll(".owl-user-bubble")).toHaveLength(1);
		expect(frames.size).toBe(0);
		expect(relay()).toBeNull();
	});

	it.each(["owl-agent-conversation", "research-conversation"])("relays an accepted send only to the newly committed user bubble in %s", async (conversationClass) => {
		await render({ conversationClass });
		observers[0].emit(true);
		const receipt = motion.beginSend();
		await render({ conversationClass, questions: [{ index: 1 }, { index: 2 }] });
		expect(relay()).toBeNull();
		expect(frames.size).toBe(0);
		receipt.accepted();
		flushFrame();
		expect(relay()).toBeNull();
		flushFrame();
		expect(relay()?.getAttribute("aria-hidden")).toBe("true");
		expect(animations.filter(({ element }) => element.classList.contains("owl-user-bubble"))
			.map(({ element }) => element.textContent)).toEqual(["Message 2"]);
		receipt.accepted();
		expect(document.querySelectorAll(".owl-composer-relay")).toHaveLength(1);
		expect(frames.size).toBe(0);
		const dotAnimation = animations.find(({ element }) => element === relay())!;
		dotAnimation.onfinish?.call(dotAnimation as unknown as Animation, {} as AnimationPlaybackEvent);
		expect(relay()).toBeNull();
	});

	it("ignores bubbles in another conversation and ambiguous concurrent rows", async () => {
		await render();
		observers[0].emit(true);
		const first = motion.beginSend();
		await render({ foreignQuestions: [{ index: 2 }] });
		first.accepted();
		flushFrame();
		flushFrame();
		expect(relay()).toBeNull();
		const second = motion.beginSend();
		await render({ questions: [{ index: 1 }, { index: 2 }, { index: 3 }] });
		second.accepted();
		flushFrame();
		flushFrame();
		expect(relay()).toBeNull();
		expect(animations.some(({ element }) => element.classList.contains("owl-user-bubble"))).toBe(false);
	});

	it.each(["queue", "steer"] as const)("does not represent an accepted %s acknowledgement as a chat delivery", async (delivery) => {
		await render();
		observers[0].emit(true);
		const receipt = motion.beginSend(delivery);
		await render({ questions: [{ index: 1 }, { index: 2 }] });
		receipt.accepted();
		expect(frames.size).toBe(0);
		expect(relay()).toBeNull();
		expect(animations.some(({ element }) => element.classList.contains("owl-user-bubble"))).toBe(false);
	});

	it("cancels rejected feedback and cannot later relay the same receipt", async () => {
		await render();
		observers[0].emit(true);
		const receipt = motion.beginSend();
		const gather = animations.find(({ element }) => element.classList.contains("owl-composer-send-glint"))!;
		receipt.cancel();
		await render({ questions: [{ index: 1 }, { index: 2 }] });
		receipt.accepted();
		expect(gather.cancel).toHaveBeenCalledOnce();
		expect(frames.size).toBe(0);
		expect(relay()).toBeNull();
	});

	it("uses the latest current-session guard when first-session creation finishes", async () => {
		await render({ isCurrent: () => false });
		observers[0].emit(true);
		const receipt = motion.beginSend();
		receipt.accepted();
		flushFrame();
		await render({ isCurrent: () => true, questions: [{ index: 1 }, { index: 2 }] });
		flushFrame();
		expect(relay()).not.toBeNull();
	});

	it("does not relay when the latest current-session guard rejects the send", async () => {
		await render({ isCurrent: () => true });
		observers[0].emit(true);
		const receipt = motion.beginSend();
		receipt.accepted();
		flushFrame();
		await render({ isCurrent: () => false, questions: [{ index: 1 }, { index: 2 }] });
		flushFrame();
		expect(relay()).toBeNull();
	});

	it.each(["clipped", "outside-window"] as const)("skips a %s destination without moving the chat scroll", async (position) => {
		await render();
		observers[0].emit(true);
		const chat = container.querySelector<HTMLElement>(".owl-chat-scroll")!;
		chat.scrollTop = 123;
		const receipt = motion.beginSend();
		await render({ questions: [{ index: 1 }, { index: 2, position }] });
		receipt.accepted();
		flushFrame();
		flushFrame();
		expect(relay()).toBeNull();
		expect(chat.scrollTop).toBe(123);
	});

	it.each(["hidden", "offscreen", "reduced", "disabled"] as const)("releases active feedback when motion becomes %s", async (reason) => {
		await render();
		observers[0].emit(true);
		const receipt = motion.beginSend();
		await render({ questions: [{ index: 1 }, { index: 2 }] });
		receipt.accepted();
		flushFrame();
		flushFrame();
		expect(relay()).not.toBeNull();
		const running = [...animations];
		if (reason === "hidden") setHidden(true);
		else if (reason === "offscreen") observers[0].emit(false);
		else if (reason === "reduced") {
			media.matches = true;
			for (const listener of mediaListeners) listener();
		} else {
			document.documentElement.dataset.owlChatMotion = "off";
			preferenceObservers[0].callback();
		}
		expect(relay()).toBeNull();
		expect(frames.size).toBe(0);
		expect(running.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(container.querySelector<HTMLElement>("[data-testid='surface']")?.dataset.composerMotion).toBe("paused");
		const count = animations.length;
		motion.acceptSuggestion();
		motion.beginSend().accepted();
		expect(animations).toHaveLength(count);
		expect(frames.size).toBe(0);
	});

	it("cancels a pending relay when navigating away and ignores the stale receipt", async () => {
		await render();
		observers[0].emit(true);
		const receipt = motion.beginSend();
		receipt.accepted();
		flushFrame();
		expect(frames.size).toBe(1);
		await render({ owner: "conversation-b", questions: [{ index: 2 }] });
		observers[1].emit(true);
		expect(frames.size).toBe(0);
		expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		flushFrame();
		receipt.accepted();
		expect(relay()).toBeNull();
		expect(frames.size).toBe(0);
	});

	it.each(["owner", "client"] as const)("ignores a late acknowledgement after the %s changes", async (changed) => {
		await render();
		observers[0].emit(true);
		const receipt = motion.beginSend();
		await render({
			owner: changed === "owner" ? "conversation-b" : undefined,
			client: changed === "client" ? {} : defaultClient,
			questions: [{ index: 1 }, { index: 2 }],
		});
		observers[1].emit(true);
		receipt.accepted();
		expect(frames.size).toBe(0);
		expect(relay()).toBeNull();
	});

	it("releases subscriptions and pending work on unmount, including a late send acknowledgement", async () => {
		await render();
		observers[0].emit(true);
		const receipt = motion.beginSend();
		const removeDocument = vi.spyOn(document, "removeEventListener");
		await act(async () => root.render(null));
		expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(observers[0].disconnect).toHaveBeenCalledOnce();
		expect(preferenceObservers[0].disconnect).toHaveBeenCalledOnce();
		expect(mediaListeners.size).toBe(0);
		expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
		receipt.accepted();
		expect(relay()).toBeNull();
		expect(frames.size).toBe(0);
	});
});
