import { useEffect, useRef } from "react";

/** 只在交互或展开时工作；离屏、减少动态效果和卸载都会停止。 */
export function useReviewChangesMotion(collapsed: boolean, contextKey: string) {
	const cardRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const card = cardRef.current;
		if (!card || typeof window.matchMedia !== "function" || typeof window.requestAnimationFrame !== "function")
			return;
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		const animations = new Set<Animation>();
		let visible = true;
		let rect: DOMRect | undefined;
		let pointerFrame: number | undefined;
		let traceFrame: number | undefined;
		let traceTimer: number | undefined;
		let pointerX = 0;
		let pointerY = 0;
		const canMove = (): boolean => visible && !reduced.matches && !document.hidden;
		const stop = (): void => {
			if (pointerFrame !== undefined) window.cancelAnimationFrame(pointerFrame);
			if (traceFrame !== undefined) window.cancelAnimationFrame(traceFrame);
			if (traceTimer !== undefined) window.clearTimeout(traceTimer);
			pointerFrame = traceFrame = traceTimer = undefined;
			for (const animation of animations) animation.cancel();
			animations.clear();
			card.classList.remove("is-pointer-active", "is-tracing");
		};
		const trace = (): void => {
			if (!canMove()) return;
			if (traceFrame !== undefined) window.cancelAnimationFrame(traceFrame);
			if (traceTimer !== undefined) window.clearTimeout(traceTimer);
			card.classList.remove("is-tracing");
			traceFrame = window.requestAnimationFrame(() => {
				traceFrame = undefined;
				if (!canMove()) return;
				card.classList.add("is-tracing");
				traceTimer = window.setTimeout(() => {
					card.classList.remove("is-tracing");
					traceTimer = undefined;
				}, 800);
			});
		};
		const move = (event: PointerEvent): void => {
			if (!canMove() || event.pointerType === "touch") return;
			card.classList.add("is-pointer-active");
			rect ??= card.getBoundingClientRect();
			pointerX = event.clientX - rect.left;
			pointerY = event.clientY - rect.top;
			if (pointerFrame !== undefined) return;
			pointerFrame = window.requestAnimationFrame(() => {
				pointerFrame = undefined;
				if (!canMove()) return;
				card.style.setProperty("--owl-changes-pointer-x", `${pointerX}px`);
				card.style.setProperty("--owl-changes-pointer-y", `${pointerY}px`);
			});
		};
		const enter = (event: PointerEvent): void => {
			if (!canMove() || event.pointerType === "touch") return;
			rect = card.getBoundingClientRect();
			card.classList.add("is-pointer-active");
			move(event);
			trace();
		};
		const leave = (): void => {
			card.classList.remove("is-pointer-active");
		};
		const invalidateRect = (): void => {
			rect = undefined;
		};
		const onVisibility = (): void => {
			if (document.hidden) stop();
		};
		const observer =
			typeof IntersectionObserver === "function"
				? new IntersectionObserver(([entry]) => {
						visible = entry.isIntersecting;
						if (!visible) stop();
					})
				: undefined;
		observer?.observe(card);
		card.addEventListener("pointerenter", enter);
		card.addEventListener("pointermove", move);
		card.addEventListener("pointerleave", leave);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("resize", invalidateRect);
		window.addEventListener("scroll", invalidateRect, true);
		reduced.addEventListener("change", stop);
		if (!collapsed && canMove()) {
			// 长清单也只给前八行错落入场，最多延迟 224ms。
			[...card.querySelectorAll<HTMLElement>(".owl-changes-item")].slice(0, 8).forEach((row, index) => {
				if (typeof row.animate !== "function") return;
				const animation = row.animate(
					[
						{ opacity: 0.55, transform: "translateY(4px)" },
						{ opacity: 1, transform: "translateY(0)" },
					],
					{ duration: 230, delay: index * 32, fill: "backwards", easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
				);
				animations.add(animation);
				animation.onfinish = () => {
					animations.delete(animation);
				};
			});
			trace();
		}
		return () => {
			stop();
			observer?.disconnect();
			card.removeEventListener("pointerenter", enter);
			card.removeEventListener("pointermove", move);
			card.removeEventListener("pointerleave", leave);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("resize", invalidateRect);
			window.removeEventListener("scroll", invalidateRect, true);
			reduced.removeEventListener("change", stop);
			card.style.removeProperty("--owl-changes-pointer-x");
			card.style.removeProperty("--owl-changes-pointer-y");
		};
	}, [collapsed, contextKey]);
	return cardRef;
}
