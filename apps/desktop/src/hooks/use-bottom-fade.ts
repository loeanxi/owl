import { useEffect, useRef } from "react";

/**
 * 溢出时给容器底边加渐隐。
 *
 * 定高容器（上下文框、输入区提示）把最后一行横切成半行时，
 * 读起来像渲染坏了。改成底边渐隐：截断处淡出，
 * "下面还有内容"看起来才是本意。
 *
 * 溢出状态随内容尺寸变化，交给 ResizeObserver 盯着。
 */
export function useBottomFade<T extends HTMLElement>(): React.RefObject<T | null> {
	const ref = useRef<T>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = (): void => {
			element.dataset.answerOverflow = element.scrollHeight > element.clientHeight + 1 ? "bottom" : "none";
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(element);
		for (const child of element.children) observer.observe(child);
		return () => observer.disconnect();
	}, []);
	return ref;
}
