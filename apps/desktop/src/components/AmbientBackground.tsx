import { useEffect, useRef, useState } from "react";
import { isGlassPreset, systemPrefersReducedMotion, useOwlAnimation } from "../animation-settings.ts";
import { createAmbientEngine, type AmbientEngine, type AmbientMood, type AmbientPulseKind } from "../ambient-background.ts";
import { resolveSurfaceTheme } from "../owl-appearance.ts";

/** 渲染分辨率封顶 1.25：背景以柔光为主，肉眼无差别，像素量少三分之一以上。 */
const MAX_DPR = 1.25;

/** 当前主题是否适合显示背景：毛玻璃系预设 + 深色。 */
function themeSupportsAmbient(): boolean {
	const dataset = document.documentElement.dataset;
	return isGlassPreset(dataset.owlPreset) && resolveSurfaceTheme(dataset) === "dark";
}

function isAwake(pauseWhenUnfocused: boolean): boolean {
	return !document.hidden && (!pauseWhenUnfocused || typeof document.hasFocus !== "function" || document.hasFocus());
}

/**
 * 背景动画层（设置页「动画」分区控制）：深空星云 + 星点 + 偶发流星。
 *
 * 只用于毛玻璃系主题（liquid-glass / frost）：这类主题的面板本来就是半透明玻璃，背景光透过玻璃缓缓流动；
 * 实色主题的面板不透光，硬加背景只会把界面切成几块，所以其它主题一律不显示。
 * 生效条件：开启背景动画 && 毛玻璃主题 && 深色模式 && 未开启动态壁纸（壁纸自己就是背景，二者互斥）。
 * 生效时在 <html> 写 data-owl-ambient="on"，由 desktop-shell.css 显示画布；不生效时移除属性，外观与原来完全一致。
 *
 * 运行策略：窗口隐藏、或（可选）失焦时暂停；系统开启「减少动态效果」且遵循时只画静态一帧；帧率按设置限制。
 */
export function AmbientBackground({
	mood,
	pulse,
	wallpaperEnabled,
}: {
	mood: AmbientMood;
	/** seq 变化即触发一次脉冲（完成涟漪 / 异常泛红）。 */
	pulse: { seq: number; kind: AmbientPulseKind } | null;
	wallpaperEnabled: boolean;
}): React.JSX.Element {
	const settings = useOwlAnimation();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const engineRef = useRef<AmbientEngine | null>(null);
	const [themeOk, setThemeOk] = useState(themeSupportsAmbient);
	const [reduced, setReduced] = useState(systemPrefersReducedMotion);
	const [awake, setAwake] = useState(() => isAwake(settings.pauseWhenUnfocused));
	const pauseRef = useRef(settings.pauseWhenUnfocused);
	pauseRef.current = settings.pauseWhenUnfocused;

	const active = settings.ambientEnabled && themeOk && !wallpaperEnabled;
	const animated = active && awake && !(settings.respectReducedMotion && reduced);
	const activeRef = useRef(active);
	activeRef.current = active;

	// 主题 / 预设 / 壁纸变化 → 重新判定（用户在设置里切主题预设、开关壁纸时即时响应）。
	useEffect(() => {
		const root = document.documentElement;
		if (typeof MutationObserver !== "function") return; // 非浏览器环境（测试桩）
		const observer = new MutationObserver(() => setThemeOk(themeSupportsAmbient()));
		observer.observe(root, { attributes: true, attributeFilter: ["data-owl-theme", "data-owl-preset", "data-owl-wallpaper", "data-owl-glass-theme"] });
		return () => observer.disconnect();
	}, []);

	// 系统「减少动态效果」
	useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const query = matchMedia("(prefers-reduced-motion: reduce)");
		if (typeof query?.addEventListener !== "function") return;
		const onChange = (): void => setReduced(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	// 窗口可见性 / 焦点
	useEffect(() => {
		const update = (): void => setAwake(isAwake(pauseRef.current));
		update();
		document.addEventListener("visibilitychange", update);
		window.addEventListener("focus", update);
		window.addEventListener("blur", update);
		return () => {
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", update);
		};
	}, [settings.pauseWhenUnfocused]);

	// 显示门控：属性写在 <html>，CSS 据此显示画布（毛玻璃预设自带半透明面板，不需要额外规则）
	useEffect(() => {
		const root = document.documentElement;
		if (!active) return;
		root.dataset.owlAmbient = "on";
		return () => {
			delete root.dataset.owlAmbient;
		};
	}, [active]);

	// 引擎与画布尺寸：只在尺寸变化时重设，逐帧不读布局
	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx || typeof ResizeObserver !== "function") return;
		const engine = createAmbientEngine(ctx);
		engineRef.current = engine;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (!rect || rect.width < 2 || rect.height < 2) return;
			const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
			canvas.width = Math.round(rect.width * dpr);
			canvas.height = Math.round(rect.height * dpr);
			engine.resize(rect.width, rect.height, dpr);
			// 改尺寸会清空画布：立刻补一帧静态画面，动画循环会在下一帧接管
			if (activeRef.current) engine.render(performance.now(), { frozen: true });
		});
		observer.observe(canvas);
		return () => {
			observer.disconnect();
			engineRef.current = null;
		};
	}, []);

	useEffect(() => {
		engineRef.current?.setConfig({
			intensity: settings.ambientIntensity,
			meteors: settings.ambientMeteors,
			reactive: settings.ambientReactive,
		});
	}, [settings.ambientIntensity, settings.ambientMeteors, settings.ambientReactive]);

	useEffect(() => {
		engineRef.current?.setMood(mood);
	}, [mood]);

	// 脉冲：挂载时的旧通知不重放
	const lastPulseSeq = useRef(pulse?.seq ?? 0);
	useEffect(() => {
		if (!pulse || pulse.seq === lastPulseSeq.current) return;
		lastPulseSeq.current = pulse.seq;
		engineRef.current?.pulse(pulse.kind);
	}, [pulse]);

	// 动画循环：帧率上限；不需要动时只补一帧静态画面（暂停/减少动态效果/设置变更后保持背景不消失）
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !active) return;
		if (!animated) {
			engine.render(performance.now(), { frozen: true });
			return;
		}
		const minInterval = 1000 / settings.fps;
		let raf = 0;
		let lastFrame = -Infinity;
		const tick = (now: number): void => {
			raf = requestAnimationFrame(tick);
			if (now - lastFrame < minInterval - 2) return;
			lastFrame = now;
			engine.render(now);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [active, animated, settings.fps, settings.ambientIntensity, settings.ambientMeteors, settings.ambientReactive]);

	return <canvas ref={canvasRef} className="owl-ambient-layer" aria-hidden="true" />;
}
