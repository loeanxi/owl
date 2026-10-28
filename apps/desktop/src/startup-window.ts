import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { hasTauri } from "./bridge/native.ts";

/** 首次外观落地后才显示原生窗口；桥无响应时仍能进入默认界面。 */
export function useStartupWindow(): () => void {
	const [prepared, setPrepared] = useState(false);
	const completeAppearance = useCallback(() => setPrepared(true), []);

	useEffect(() => {
		if (prepared || !hasTauri()) return;
		const timeout = setTimeout(completeAppearance, 4000);
		return () => clearTimeout(timeout);
	}, [prepared, completeAppearance]);

	useEffect(() => {
		if (!prepared || !hasTauri()) return;
		let active = true;
		let frame: number | undefined;
		const reveal = (): void => {
			if (!active) return;
			active = false;
			clearTimeout(timeout);
			if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
			void invoke("main_window_ready").catch((error: unknown) => {
				console.error("[owl] failed to reveal the startup window", error);
			});
		};
		// effect 已在 React 提交后运行，再留一帧给外观绘制。隐藏 WebView 可能暂停 rAF，需短兜底。
		const timeout = setTimeout(reveal, 100);
		if (typeof requestAnimationFrame === "function") {
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(reveal);
			});
		}
		return () => {
			active = false;
			clearTimeout(timeout);
			if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
		};
	}, [prepared]);

	return completeAppearance;
}
