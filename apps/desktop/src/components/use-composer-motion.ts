import { type RefObject, useEffect, useRef } from "react";

export interface ComposerSendMotion {
	accepted: () => void;
	cancel: () => void;
}

interface Options {
	surfaceRef: RefObject<HTMLDivElement | null>;
	inputRef: RefObject<HTMLDivElement | null>;
	/** First-session creation keeps this owner; navigating to another conversation changes it. */
	owner: string;
	client: object;
	isCurrent?: () => boolean;
}

const noSendMotion: ComposerSendMotion = { accepted: () => {}, cancel: () => {} };
const noController = {
	accept: () => {},
	send: (_delivery?: "queue" | "steer", _source?: HTMLElement): ComposerSendMotion => noSendMotion,
};

/** Decorative feedback never edits the draft, creates a message, or moves the chat scroll. */
export function useComposerMotion(options: Options) {
	const latest = useRef(options);
	latest.current = options;
	const controller = useRef(noController);
	useEffect(() => {
		const surface = options.surfaceRef.current;
		const input = options.inputRef.current;
		if (!surface || !input) return;
		const reduced =
			typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
		const animations = new Set<Animation>();
		const frames = new Set<number>();
		const dots = new Set<HTMLElement>();
		let visible = typeof IntersectionObserver === "undefined";
		let generation = 0;
		const canMove = (): boolean =>
			visible &&
			!document.hidden &&
			!reduced?.matches &&
			document.documentElement.dataset.owlChatMotion !== "off" &&
			latest.current.owner === options.owner &&
			latest.current.client === options.client;
		const stop = (): void => {
			generation++;
			for (const frame of frames) window.cancelAnimationFrame(frame);
			frames.clear();
			for (const animation of animations) animation.cancel();
			animations.clear();
			for (const dot of dots) dot.remove();
			dots.clear();
		};
		const refresh = (): void => {
			surface.dataset.composerMotion = canMove() ? "active" : "paused";
			if (!canMove()) stop();
		};
		const animate = (element: Element | null, keyframes: Keyframe[], duration: number): Animation | undefined => {
			if (!element || !canMove() || typeof element.animate !== "function") return;
			const animation = element.animate(keyframes, { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
			animations.add(animation);
			animation.onfinish = animation.oncancel = () => {
				animations.delete(animation);
			};
			return animation;
		};
		const nextFrame = (callback: () => void): void => {
			if (typeof window.requestAnimationFrame !== "function") return;
			const frame = window.requestAnimationFrame(() => {
				frames.delete(frame);
				callback();
			});
			frames.add(frame);
		};
		controller.current = {
			accept: () => {
				animate(
					input.querySelector(".owl-composer-accept-glint"),
					[
						{ opacity: 0, transform: "translateX(-12%)" },
						{ opacity: 0.8, offset: 0.3 },
						{ opacity: 0, transform: "translateX(12%)" },
					],
					280,
				);
				animate(input.querySelector(".owl-composer-editor"), [{ opacity: 0.7 }, { opacity: 1 }], 200);
			},
			send: (delivery, source) => {
				if (!canMove()) return noSendMotion;
				const button = source ?? (delivery ? null : input.querySelector<HTMLElement>(".owl-composer-action"));
				const start = button?.getBoundingClientRect();
				animate(button ?? null, [{ transform: "scale(0.92)" }, { transform: "scale(1)" }], 180);
				const gather = animate(
					input.querySelector(".owl-composer-send-glint"),
					[
						{ opacity: 0, backgroundPosition: "150% 0" },
						{ opacity: 1, offset: 0.45 },
						{ opacity: 0, backgroundPosition: "-50% 0" },
					],
					320,
				);
				const scope = surface.closest(".owl-agent-conversation, .research-conversation");
				const rows = [...(scope?.querySelectorAll<HTMLElement>(".owl-chat-question[data-qidx]") ?? [])];
				const previous = new Set(rows.flatMap((row) => [...row.querySelectorAll(".owl-user-bubble")]));
				const lastQuestion = Math.max(0, ...rows.map((row) => Number(row.dataset.qidx) || 0));
				const ticket = generation;
				let pending = true;
				return {
					cancel: () => {
						pending = false;
						gather?.cancel();
					},
					accepted: () => {
						if (!pending) return;
						pending = false;
						if (ticket !== generation || !canMove()) return;
						// Queue and steer acknowledgements are not chat deliveries. Never target an old bubble.
						if (delivery || !scope || !start || start.width <= 0 || start.height <= 0) return;
						// React commits the optimistic row, then ChatStream restores its own reading position.
						nextFrame(() =>
							nextFrame(() => {
								if (
									ticket !== generation ||
									!canMove() ||
									latest.current.isCurrent?.() === false ||
									!scope.isConnected
								)
									return;
								const candidates = [...scope.querySelectorAll<HTMLElement>(".owl-chat-question[data-qidx]")]
									.filter((row) => Number(row.dataset.qidx) > lastQuestion)
									.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".owl-user-bubble")])
									.filter((bubble) => !previous.has(bubble));
								// Concurrent replies can add another user row; ambiguous decoration is skipped.
								if (candidates.length !== 1) return;
								const bubble = candidates[0]!;
								const chat = bubble.closest(".owl-chat-scroll");
								if (!chat || !bubble.isConnected) return;
								const target = bubble.getBoundingClientRect();
								const viewport = chat.getBoundingClientRect();
								const left = Math.max(0, target.left, viewport.left),
									right = Math.min(window.innerWidth, target.right, viewport.right);
								const top = Math.max(0, target.top, viewport.top),
									bottom = Math.min(window.innerHeight, target.bottom, viewport.bottom);
								if (right - left < 8 || bottom - top < 8 || start.bottom < 0 || start.top > window.innerHeight)
									return;
								const dot = document.createElement("i");
								dot.className = "owl-composer-relay";
								dot.setAttribute("aria-hidden", "true");
								dot.style.left = `${start.left + start.width / 2}px`;
								dot.style.top = `${start.top + start.height / 2}px`;
								document.body.appendChild(dot);
								dots.add(dot);
								const dx = right - Math.min(18, (right - left) / 2) - start.left - start.width / 2;
								const dy = bottom - Math.min(14, (bottom - top) / 2) - start.top - start.height / 2;
								const relay = animate(
									dot,
									[
										{ transform: "translate(-50%, -50%) scale(1)", opacity: 0.9 },
										{
											transform: `translate(calc(-50% + ${dx * 0.65}px), calc(-50% + ${dy * 0.4}px)) scale(0.8)`,
											opacity: 0.8,
											offset: 0.5,
										},
										{
											transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.3)`,
											opacity: 0,
										},
									],
									320,
								);
								if (relay)
									relay.onfinish = relay.oncancel = () => {
										animations.delete(relay);
										dots.delete(dot);
										dot.remove();
									};
								else {
									dots.delete(dot);
									dot.remove();
								}
								animate(
									bubble,
									[
										{ opacity: 0.7, transform: "translateY(5px)" },
										{ opacity: 1, transform: "translateY(0)" },
									],
									240,
								);
							}),
						);
					},
				};
			},
		};
		const intersection =
			typeof IntersectionObserver === "function"
				? new IntersectionObserver(([entry]) => {
						visible = entry?.isIntersecting ?? false;
						refresh();
					})
				: undefined;
		intersection?.observe(surface);
		const preferences = typeof MutationObserver === "function" ? new MutationObserver(refresh) : undefined;
		preferences?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-owl-chat-motion"] });
		document.addEventListener("visibilitychange", refresh);
		reduced?.addEventListener("change", refresh);
		refresh();
		return () => {
			controller.current = noController;
			stop();
			surface.dataset.composerMotion = "paused";
			intersection?.disconnect();
			preferences?.disconnect();
			document.removeEventListener("visibilitychange", refresh);
			reduced?.removeEventListener("change", refresh);
		};
	}, [options.owner, options.client]);
	return {
		acceptSuggestion: (): void => controller.current.accept(),
		beginSend: (delivery?: "queue" | "steer", source?: HTMLElement): ComposerSendMotion =>
			controller.current.send(delivery, source),
	};
}
