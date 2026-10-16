/**
 * 动画设置（settings.json 的 owlAnimation 字段）：启动动画 + 背景动画 + 性能/无障碍，统一在设置页「动画」分区管理。
 *
 * 为什么用模块级存储而不是 App state：
 *  - 启动动画在 React 挂载之前就要读设置（main.tsx），桥端设置异步到达，所以同步镜像一份到
 *    localStorage（`owl.animation`），下次启动首帧即生效，与 `owl.bootAppearance` 同一思路。
 *  - 背景动画组件与设置页相隔很远，用订阅式存储省掉跨层 props（useOwlAnimation）。
 *
 * 解析逐字段回退：坏值只影响自己那一项，不拖垮其它已保存的设置。
 */
import { useSyncExternalStore } from "react";

export type StartupSpeed = "normal" | "fast";
export type AnimationFps = 15 | 20 | 30;

/** 自带半透明玻璃面板 + 极光底色的预设：背景动画只在这些主题下显示（光透过玻璃缓缓流动）。 */
const GLASS_PRESETS: ReadonlySet<string> = new Set(["liquid-glass", "frost"]);

/** 当前主题预设是否支持背景动画（目前只有毛玻璃系）。 */
export function isGlassPreset(preset: string | undefined): boolean {
	return GLASS_PRESETS.has(preset ?? "");
}

export interface OwlAnimationSettings {
	/** 启动动画总开关。 */
	startupEnabled: boolean;
	/** 启动动画播放速度：normal ≈ 4.2 秒，fast ≈ 2.5 秒。 */
	startupSpeed: StartupSpeed;
	/** 启动动画中的流星雨。 */
	startupMeteors: boolean;
	/** 背景动画总开关（仅毛玻璃主题 + 深色模式、且未开启动态壁纸时生效）。 */
	ambientEnabled: boolean;
	/** 背景动画强度 10–100：星云与星点的亮度。 */
	ambientIntensity: number;
	/** 背景中的偶发流星。 */
	ambientMeteors: boolean;
	/** 背景随 Agent 状态联动：工作呼吸 / 等待泛琥珀 / 完成涟漪 / 异常泛红。 */
	ambientReactive: boolean;
	/** 背景动画帧率上限。 */
	fps: AnimationFps;
	/** 窗口失焦或隐藏时暂停背景动画。 */
	pauseWhenUnfocused: boolean;
	/** 遵循系统「减少动态效果」：启动动画不播放，背景保持静态。 */
	respectReducedMotion: boolean;
}

export const DEFAULT_OWL_ANIMATION: Readonly<OwlAnimationSettings> = Object.freeze({
	startupEnabled: true,
	startupSpeed: "normal",
	startupMeteors: true,
	ambientEnabled: true,
	ambientIntensity: 45,
	ambientMeteors: true,
	ambientReactive: true,
	fps: 20,
	pauseWhenUnfocused: true,
	respectReducedMotion: true,
});

export const AMBIENT_INTENSITY_MIN = 10;
export const AMBIENT_INTENSITY_MAX = 100;
const FPS_VALUES: readonly AnimationFps[] = [15, 20, 30];

/** 启动动画快速档的时间倍率（时间线整体加速）。 */
export const STARTUP_FAST_FACTOR = 1.7;

/** localStorage 镜像键；启动动画在桥端设置到达之前靠它决定是否/如何播放。 */
export const ANIMATION_MIRROR_KEY = "owl.animation";
/** 旧版调试开关：值为 off 时关闭启动动画（镜像不存在时仍然生效）。 */
const LEGACY_STARTUP_KEY = "owl.startupSplash";

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

export function parseOwlAnimation(raw: unknown): OwlAnimationSettings {
	const value = asRecord(raw);
	const d = DEFAULT_OWL_ANIMATION;
	const fps = Number(value.fps) as AnimationFps;
	return {
		startupEnabled: bool(value.startupEnabled, d.startupEnabled),
		startupSpeed: value.startupSpeed === "fast" ? "fast" : "normal",
		startupMeteors: bool(value.startupMeteors, d.startupMeteors),
		ambientEnabled: bool(value.ambientEnabled, d.ambientEnabled),
		ambientIntensity: Math.round(clampNumber(value.ambientIntensity, AMBIENT_INTENSITY_MIN, AMBIENT_INTENSITY_MAX, d.ambientIntensity)),
		ambientMeteors: bool(value.ambientMeteors, d.ambientMeteors),
		ambientReactive: bool(value.ambientReactive, d.ambientReactive),
		fps: FPS_VALUES.includes(fps) ? fps : d.fps,
		pauseWhenUnfocused: bool(value.pauseWhenUnfocused, d.pauseWhenUnfocused),
		respectReducedMotion: bool(value.respectReducedMotion, d.respectReducedMotion),
	};
}

function sameSettings(a: OwlAnimationSettings, b: OwlAnimationSettings): boolean {
	return (Object.keys(a) as (keyof OwlAnimationSettings)[]).every((key) => a[key] === b[key]);
}

/** 从 localStorage 镜像恢复；没有镜像时兼容旧开关 owl.startupSplash=off。 */
export function readAnimationMirror(storage?: Pick<Storage, "getItem">): OwlAnimationSettings {
	let store = storage;
	if (!store) {
		try {
			store = typeof localStorage === "undefined" ? undefined : localStorage;
		} catch {
			store = undefined;
		}
	}
	if (!store) return parseOwlAnimation(undefined);
	try {
		const text = store.getItem(ANIMATION_MIRROR_KEY);
		if (text) return parseOwlAnimation(JSON.parse(text));
		if (store.getItem(LEGACY_STARTUP_KEY) === "off") return parseOwlAnimation({ startupEnabled: false });
	} catch {
		/* 存储不可用或 JSON 损坏：回退默认。 */
	}
	return parseOwlAnimation(undefined);
}

function writeAnimationMirror(settings: OwlAnimationSettings): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(ANIMATION_MIRROR_KEY, JSON.stringify(settings));
	} catch {
		/* 存储不可用：本次会话内仍然生效。 */
	}
}

// ---------------------------------------------------------------- 订阅式存储 ----

let current: OwlAnimationSettings = readAnimationMirror();
const listeners = new Set<() => void>();

/** 当前生效值（引用稳定，直到 applyOwlAnimation 真正改变了某个字段）。 */
export function getOwlAnimation(): OwlAnimationSettings {
	return current;
}

/** 应用一整套动画设置并同步本地镜像；与当前值相同则不触发订阅。幂等，滑杆高频调用安全。 */
export function applyOwlAnimation(next: unknown): OwlAnimationSettings {
	const parsed = parseOwlAnimation(next);
	if (sameSettings(parsed, current)) return current;
	current = parsed;
	writeAnimationMirror(parsed);
	for (const listener of [...listeners]) listener();
	return current;
}

export function subscribeOwlAnimation(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useOwlAnimation(): OwlAnimationSettings {
	return useSyncExternalStore(subscribeOwlAnimation, getOwlAnimation, getOwlAnimation);
}

/** 系统是否开启了「减少动态效果」。 */
export function systemPrefersReducedMotion(): boolean {
	try {
		return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}