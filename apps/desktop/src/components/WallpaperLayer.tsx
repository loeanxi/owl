/**
 * 动态壁纸渲染层：垫在 .owl-desktop-shell 最底部的一块画布。
 *
 * 渲染策略（移植自 dsh-wallpaper-engine 的 buildMedia 优先级，去掉实时渲染）：
 * - video：<video autoplay loop playsinline preload="auto">，原生倍速 + volume/muted
 *   成对设置（上游教训：只设其一 WebView2 会回退默认音量）。
 * - web：沙箱 iframe（allow-scripts = opaque origin，防冒用宿主身份），HTML 由桥端
 *   注入 seed 属性 + 兼容 shim；暂停/音量经 postMessage 走 shim 的控制面。
 * - scene：v1 不做实时 WebGL 渲染，降级为工程预览静态图。
 *
 * 素材全部来自桥端 /wallpaper/inventory（含用户 customPath/customDir 的登记项，
 * id = "custom"），客户端不拼接任何文件路径。
 *
 * 遮挡暂停（上游 occlusionReason 同款判定）：页面隐藏 / 窗口失焦（可配）暂停；
 * 事件不可靠（原生模态抢焦点后 focus 不回送），低频 3s 复核兜底。
 * 视频暂停连解码一起停，是整个省电方案的核心。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { OwlWallpaperSettings } from "../wallpaper.ts";
import { WALLPAPER_IFRAME_SANDBOX } from "../wallpaper.ts";

/** 桥端 inventory 条目（wallpaper-http.ts WallpaperEntry 的客户端视图）。 */
export interface WallpaperEntry {
	id: string;
	title: string;
	type: "scene" | "video" | "web" | "application";
	mediaUrl: string | null;
	webUrl: string | null;
	previewUrl: string | null;
	contentRating: string;
	schemeColor: string;
}

export interface WallpaperInventory {
	wallpapers: WallpaperEntry[];
	installDir: string | null;
	workshopDirs: string[];
}

/** 模块级 inventory 缓存：渲染层与设置页共用一份，避免各拉一次。 */
let inventoryCache: WallpaperInventory | null = null;
let inventoryPromise: Promise<WallpaperEntry[]> | null = null;

export async function fetchInventory(force = false): Promise<WallpaperEntry[]> {
	if (!force && inventoryPromise) return inventoryPromise;
	inventoryPromise = (async () => {
		const response = await fetch(`/wallpaper/inventory${force ? "?refresh=1" : ""}`, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) throw new Error(`inventory ${response.status}`);
		const data = (await response.json()) as WallpaperInventory;
		inventoryCache = data;
		return data.wallpapers;
	})();
	return inventoryPromise;
}

export function cachedInventory(): WallpaperInventory | null {
	return inventoryCache;
}

/** 内容分级是否放行（all 全放；未标注跟随 everyone 档）。 */
export function passesRating(entry: WallpaperEntry, rating: OwlWallpaperSettings["contentRating"]): boolean {
	if (rating === "all") return true;
	const entryRating = entry.contentRating.toLowerCase();
	if (rating === "everyone") return entryRating === "" || entryRating === "everyone";
	if (rating === "pg13") return !["mature", "r18", "adult"].includes(entryRating);
	return true;
}

/** 按设置解析当前应显示的条目：customPath 优先，其次 selectionId，两级都失效返回 null。 */
export function resolveActiveEntry(
	entries: WallpaperEntry[],
	settings: Pick<OwlWallpaperSettings, "customPath" | "selectionId" | "contentRating">,
): WallpaperEntry | null {
	if (settings.customPath.trim()) {
		const custom = entries.find((entry) => entry.id === "custom");
		if (custom) return custom;
	}
	const found = entries.find((entry) => entry.id === settings.selectionId);
	if (!found || found.type === "application") return null;
	return passesRating(found, settings.contentRating) ? found : null;
}

interface PausePolicy {
	pauseOnHidden: boolean;
	pauseOnBlur: boolean;
}

/** 遮挡判定：返回是否应暂停（settings.pauseOnHidden / pauseOnBlur 门控）。 */
function isOccluded(policy: PausePolicy): boolean {
	if (policy.pauseOnHidden && document.hidden) return true;
	if (policy.pauseOnBlur && !document.hasFocus()) return true;
	return false;
}

/** 遮挡订阅：变化立即回调 + 3s 低频复核兜底（事件不可靠：原生模态抢焦点后 focus 不回送）。 */
function useOcclusion(policy: PausePolicy, onOcclusion: (occluded: boolean) => void): void {
	const policyRef = useRef(policy);
	policyRef.current = policy;
	const callbackRef = useRef(onOcclusion);
	callbackRef.current = onOcclusion;
	useEffect(() => {
		let last: boolean | null = null;
		const apply = (): void => {
			const occluded = isOccluded(policyRef.current);
			if (occluded !== last) {
				last = occluded;
				callbackRef.current(occluded);
			}
		};
		document.addEventListener("visibilitychange", apply);
		window.addEventListener("focus", apply);
		window.addEventListener("blur", apply);
		const recheck = setInterval(apply, 3000);
		apply();
		return () => {
			clearInterval(recheck);
			document.removeEventListener("visibilitychange", apply);
			window.removeEventListener("focus", apply);
			window.removeEventListener("blur", apply);
		};
	}, []);
}

export interface WallpaperLayerProps {
	settings: OwlWallpaperSettings;
	/** 外部强制刷新清单（设置页改了 customDir/customPath 或点刷新后递增）。 */
	refreshKey?: number;
}

export function WallpaperLayer({ settings, refreshKey = 0 }: WallpaperLayerProps) {
	const [entries, setEntries] = useState<WallpaperEntry[]>(() => inventoryCache?.wallpapers ?? []);

	useEffect(() => {
		let mounted = true;
		void fetchInventory(refreshKey > 0).then((list) => {
			if (mounted) setEntries(list);
		}).catch(() => {});
		return () => {
			mounted = false;
		};
	}, [refreshKey]);

	const resolved = useMemo(() => resolveActiveEntry(entries, settings), [entries, settings]);
	const dimAlpha = Math.round(settings.dim) / 100;
	const blurPx = Math.round(settings.blur);
	const blurStyle = blurPx ? ({ filter: `blur(${blurPx}px)`, transform: "scale(1.05)" } as const) : undefined;

	return (
		<div className="owl-wallpaper-layer" aria-hidden="true">
			{resolved?.type === "video" && resolved.mediaUrl && (
				<WallpaperVideo
					key={resolved.mediaUrl}
					src={resolved.mediaUrl}
					fit={settings.fit}
					volume={settings.volume}
					playbackRate={settings.playbackRate}
					pauseOnHidden={settings.pauseOnHidden}
					pauseOnBlur={settings.pauseOnBlur}
					blur={blurPx}
				/>
			)}
			{resolved?.type === "web" && resolved.webUrl && (
				<WallpaperWebFrame
					key={resolved.webUrl}
					src={resolved.webUrl}
					volume={settings.volume}
					pauseOnHidden={settings.pauseOnHidden}
					pauseOnBlur={settings.pauseOnBlur}
					blur={blurPx}
				/>
			)}
			{resolved?.type === "scene" && resolved.previewUrl && (
				<img
					key={resolved.previewUrl}
					src={resolved.previewUrl}
					alt=""
					draggable={false}
					className={`owl-wallpaper-media is-${settings.fit}`}
					style={blurStyle}
				/>
			)}
			<div className="owl-wallpaper-dim" style={{ backgroundColor: `rgba(0,0,0,${dimAlpha})` }} />
		</div>
	);
}

// ---------------------------------------------------------------- 视频渲染

function WallpaperVideo({
	src,
	fit,
	volume,
	playbackRate,
	pauseOnHidden,
	pauseOnBlur,
	blur,
}: {
	src: string;
	fit: OwlWallpaperSettings["fit"];
	volume: number;
	playbackRate: number;
	pauseOnHidden: boolean;
	pauseOnBlur: boolean;
	blur: number;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	// 音量：volume 与 muted 必须成对设置（只设其一 WebView2 可能不生效）。
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.volume = volume;
		video.muted = volume <= 0;
	}, [volume]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.playbackRate = playbackRate;
	}, [playbackRate]);

	useOcclusion({ pauseOnHidden, pauseOnBlur }, (occluded) => {
		const video = videoRef.current;
		if (!video) return;
		if (occluded) {
			if (!video.paused) video.pause();
			return;
		}
		if (video.paused) video.play().catch(() => {});
	});

	return (
		<video
			ref={videoRef}
			src={src}
			className={`owl-wallpaper-media is-${fit}`}
			autoPlay
			loop
			playsInline
			preload="auto"
			draggable={false}
			style={blur ? { filter: `blur(${blur}px)`, transform: "scale(1.05)" } : undefined}
		/>
	);
}

// ---------------------------------------------------------------- 网页渲染

function WallpaperWebFrame({
	src,
	volume,
	pauseOnHidden,
	pauseOnBlur,
	blur,
}: {
	src: string;
	volume: number;
	pauseOnHidden: boolean;
	pauseOnBlur: boolean;
	blur: number;
}) {
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const pausedRef = useRef(false);

	// 沙箱 iframe 不可直接触达，暂停/音量经 shim 的 postMessage 控制面（{__we:1, op}）。
	const shimCall = (op: string, extra: Record<string, unknown> = {}): void => {
		frameRef.current?.contentWindow?.postMessage({ __we: 1, op, ...extra }, "*");
	};

	useEffect(() => {
		// iframe 内容晚于挂载：立即补发 + 延迟补发各一次（shim 未就绪时静默忽略）。
		shimCall("setVolume", { v: volume });
		const arm = setTimeout(() => shimCall("setVolume", { v: volume }), 800);
		return () => clearTimeout(arm);
	}, [volume]);

	useOcclusion({ pauseOnHidden, pauseOnBlur }, (occluded) => {
		if (occluded === pausedRef.current) return;
		pausedRef.current = occluded;
		shimCall("setPaused", { v: occluded });
	});

	return (
		<iframe
			ref={frameRef}
			src={src}
			title="wallpaper"
			sandbox={WALLPAPER_IFRAME_SANDBOX}
			className="owl-wallpaper-media is-fill"
			style={blur ? { filter: `blur(${blur}px)`, transform: "scale(1.05)" } : undefined}
		/>
	);
}
