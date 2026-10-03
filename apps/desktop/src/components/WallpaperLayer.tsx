/**
 * 动态壁纸渲染层：垫在 .owl-desktop-shell 最底部的一块画布。
 *
 * 渲染策略（移植自 dsh-wallpaper-engine 的 buildMedia 优先级）：
 * - video：<video autoplay loop playsinline preload="auto">，原生倍速 + volume/muted
 *   成对设置（上游教训：只设其一 WebView2 会回退默认音量）。
 * - web：沙箱 iframe（allow-scripts = opaque origin，防冒用宿主身份），HTML 由桥端
 *   注入 site-root / seed 属性 + 兼容 shim；暂停/音量/属性经 postMessage 走 shim 控制面。
 * - scene：WebWallGL 渲染页（public/wallpaper-engine/scene-live/，上游 vendored bundle）
 *   同源**无沙箱** iframe —— 父页要直调 contentWindow.__wp 控制面，加沙箱会变
 *   opaque origin 拿不到。渲染页自己 fetch scene.pkg（mediaBase + token）解析渲染。
 *   就绪判定 = 轮询 __wpStats.frame() 的 running&&fps>0；看门狗 stall 自救/降级；
 *   音频整条跳过（渲染页回退内置模拟频谱，绝不装"接了却喂不到数据"的死桥）。
 *
 * 切层就绪门：壁纸切换（手动或轮播）先挂 staging 层（不可见但已加载），视频
 * canplay / scene 首帧 / 图片 onload 之后才接管可见层 —— 消除切换黑屏。
 * scene 实时渲染失败（首帧超时 / stall / 加载错误）降级为预览静态图，并记入
 * 会话内失败集合，本轮不再对同一壁纸尝试 live（重新扫描后重置）。
 *
 * 遮挡暂停（上游 occlusionReason 同款判定）：页面隐藏 / 窗口失焦（可配）暂停。
 * 视频每 3s 幂等重申播放意图；scene 的 __wp.pause/resume 只在状态翻转时调用
 * （上游教训：频繁 resume 会重置帧计量，首帧判定永不通过）。
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
	projectUrl: string | null;
	sceneSrc: string | null;
	pkgBytes: number | null;
	hasProps: boolean;
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

// ---------------------------------------------------------------- 层规格

type RenderSpec =
	| { kind: "video"; key: string; entryId: string; src: string }
	| { kind: "web"; key: string; entryId: string; src: string }
	| {
			kind: "sceneLive";
			key: string;
			entryId: string;
			pkgToken: string;
			fps: number;
			pkgBytes: number | null;
			previewUrl: string | null;
	  }
	| { kind: "image"; key: string; entryId: string; src: string };

function specFor(entry: WallpaperEntry, settings: OwlWallpaperSettings): RenderSpec | null {
	if (entry.type === "video" && entry.mediaUrl) {
		return { kind: "video", key: `v:${entry.mediaUrl}`, entryId: entry.id, src: entry.mediaUrl };
	}
	if (entry.type === "web" && entry.webUrl) {
		return { kind: "web", key: `w:${entry.webUrl}`, entryId: entry.id, src: entry.webUrl };
	}
	if (entry.type === "scene") {
		if (entry.sceneSrc) {
			return {
				kind: "sceneLive",
				key: `s:${entry.sceneSrc}`,
				entryId: entry.id,
				pkgToken: entry.sceneSrc,
				fps: settings.sceneFps,
				pkgBytes: entry.pkgBytes,
				previewUrl: entry.previewUrl,
			};
		}
		// 非 pkg 场景（scene.json 旧格式等）：静态预览
		if (entry.previewUrl) {
			return { kind: "image", key: `i:${entry.previewUrl}`, entryId: entry.id, src: entry.previewUrl };
		}
	}
	return null;
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

/**
 * 遮挡订阅：变化立即回调 + 3s 低频复核兜底（事件不可靠：原生模态抢焦点后 focus 不回送）。
 * 每次复核都无条件回调 —— 调用方必须自行幂等（视频：pause()/play() 幂等；scene 的
 * __wp.pause/resume 由组件内部按状态翻转去重，因为频繁 resume 会重置帧计量）。
 */
function useOcclusion(policy: PausePolicy, onOcclusion: (occluded: boolean) => void): void {
	const policyRef = useRef(policy);
	policyRef.current = policy;
	const callbackRef = useRef(onOcclusion);
	callbackRef.current = onOcclusion;
	useEffect(() => {
		const apply = (): void => {
			callbackRef.current(isOccluded(policyRef.current));
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
	const spec = useMemo(() => (resolved ? specFor(resolved, settings) : null), [resolved, settings]);

	// scene live 会话级失败集合：失败过的渲染 key 本轮直接走静态预览（重新扫描后重置）
	const [liveFailedKeys, setLiveFailedKeys] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		setLiveFailedKeys(new Set());
	}, [refreshKey]);

	const effectiveSpec = useMemo<RenderSpec | null>(() => {
		if (!spec) return null;
		if (spec.kind === "sceneLive" && liveFailedKeys.has(spec.key)) {
			return spec.previewUrl
				? { kind: "image", key: `i:${spec.previewUrl}`, entryId: spec.entryId, src: spec.previewUrl }
				: null;
		}
		return spec;
	}, [spec, liveFailedKeys]);

	// 切层就绪门：staging 层不可见地加载，就绪后才接管可见层（消除切换黑屏）。
	const [shown, setShown] = useState<RenderSpec | null>(null);
	const [staging, setStaging] = useState<RenderSpec | null>(null);
	useEffect(() => {
		if (!effectiveSpec) {
			setShown(null);
			setStaging(null);
			return;
		}
		if (shown?.key === effectiveSpec.key || staging?.key === effectiveSpec.key) return;
		// 静态图即挂即显；视频/网页/场景先 staging
		if (effectiveSpec.kind === "image") {
			setShown(effectiveSpec);
			setStaging(null);
			return;
		}
		setStaging(effectiveSpec);
	}, [effectiveSpec, shown, staging]);

	const handleReady = (key: string): void => {
		setStaging((current) => {
			if (current?.key === key) {
				setShown(current);
				return null;
			}
			return current;
		});
	};
	const handleFail = (key: string): void => {
		// scene live 失败：本轮记入失败集合（自动降级静态预览），staging 让位
		setLiveFailedKeys((keys) => new Set(keys).add(key));
		setStaging((current) => (current?.key === key ? null : current));
	};

	const dimAlpha = Math.round(settings.dim) / 100;

	return (
		<div className="owl-wallpaper-layer" aria-hidden="true">
			{shown && <MediaLayer spec={shown} settings={settings} visible onReady={handleReady} onFail={handleFail} />}
			{staging && <MediaLayer spec={staging} settings={settings} visible={false} onReady={handleReady} onFail={handleFail} />}
			<div className="owl-wallpaper-dim" style={{ backgroundColor: `rgba(0,0,0,${dimAlpha})` }} />
		</div>
	);
}

interface MediaLayerProps {
	spec: RenderSpec;
	settings: OwlWallpaperSettings;
	visible: boolean;
	onReady: (key: string) => void;
	onFail: (key: string) => void;
}

function MediaLayer(props: MediaLayerProps): React.JSX.Element {
	switch (props.spec.kind) {
		case "video":
			return <VideoLayer {...props} spec={props.spec} />;
		case "web":
			return <WebFrame {...props} spec={props.spec} />;
		case "sceneLive":
			return <SceneLiveFrame {...props} spec={props.spec} />;
		case "image":
			return <ImageLayer {...props} spec={props.spec} />;
	}
}

// ---------------------------------------------------------------- 视频渲染

function VideoLayer({ spec, settings, visible, onReady, onFail }: MediaLayerProps & { spec: Extract<RenderSpec, { kind: "video" }> }) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const readyFired = useRef(false);
	const fireReady = () => {
		if (!readyFired.current) {
			readyFired.current = true;
			onReady(spec.key);
		}
	};

	// 音量：volume 与 muted 必须成对设置（只设其一 WebView2 可能不生效）。
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.volume = settings.volume;
		video.muted = settings.volume <= 0;
	}, [settings.volume]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.playbackRate = settings.playbackRate;
	}, [settings.playbackRate]);

	useOcclusion(settings, (occluded) => {
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
			src={spec.src}
			className={`owl-wallpaper-media is-${settings.fit} owl-wp-fade ${visible ? "is-on" : ""}`}
			autoPlay
			loop
			playsInline
			preload="auto"
			draggable={false}
			onCanPlay={fireReady}
			onLoadedData={fireReady}
			onError={() => onFail(spec.key)}
		/>
	);
}

// ---------------------------------------------------------------- 图片渲染

function ImageLayer({ spec, visible, settings, onReady, onFail }: MediaLayerProps & { spec: Extract<RenderSpec, { kind: "image" }> }) {
	return (
		<img
			src={spec.src}
			alt=""
			draggable={false}
			className={`owl-wallpaper-media is-${settings.fit} owl-wp-fade ${visible ? "is-on" : ""}`}
			onLoad={() => onReady(spec.key)}
			onError={() => onFail(spec.key)}
		/>
	);
}

// ---------------------------------------------------------------- 网页渲染

function WebFrame({ spec, settings, visible, onReady, onFail }: MediaLayerProps & { spec: Extract<RenderSpec, { kind: "web" }> }) {
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const pausedRef = useRef(false);
	const readyFired = useRef(false);

	// 沙箱 iframe 不可直接触达，暂停/音量/属性经 shim 的 postMessage 控制面（{__we:1, op}）。
	const shimCall = (op: string, extra: Record<string, unknown> = {}): void => {
		frameRef.current?.contentWindow?.postMessage({ __we: 1, op, ...extra }, "*");
	};

	// 属性热下发：面板改值或换壁纸后把用户覆盖值灌进 shim
	const wire = useMemo(() => settings.props[spec.entryId] ?? {}, [settings.props, spec.entryId]);
	useEffect(() => {
		if (Object.keys(wire).length) shimCall("applyProps", { props: wire });
	}, [wire]);

	useEffect(() => {
		// iframe 内容晚于挂载：立即补发 + 延迟补发各一次（shim 未就绪时静默忽略）
		shimCall("setVolume", { v: settings.volume });
		const arm = setTimeout(() => shimCall("setVolume", { v: settings.volume }), 800);
		return () => clearTimeout(arm);
	}, [settings.volume]);

	useOcclusion(settings, (occluded) => {
		if (occluded === pausedRef.current) return;
		pausedRef.current = occluded;
		shimCall("setPaused", { v: occluded });
	});

	return (
		<iframe
			ref={frameRef}
			src={spec.src}
			title="wallpaper"
			sandbox={WALLPAPER_IFRAME_SANDBOX}
			className={`owl-wallpaper-media is-fill owl-wp-fade ${visible ? "is-on" : ""}`}
			onLoad={() => {
				if (readyFired.current) return;
				readyFired.current = true;
				onReady(spec.key);
				// 属性覆盖在 iframe 就绪后补发一次（seed 已含默认，这里只覆盖用户值）
				if (Object.keys(wire).length) shimCall("applyProps", { props: wire });
			}}
			onError={() => onFail(spec.key)}
		/>
	);
}

// ------------------------------------------------------- 场景实时渲染（WebWallGL）

/** 渲染页控制面（渲染 bundle 挂在 window 上的 __wp / __wpStats；同源 iframe 才拿得到）。 */
interface WebWallGLControl {
	pause(): void;
	resume(): void;
	setVolume(v: number): void;
	setFit(f: string): void;
	updateWebProps(props: Record<string, { value: unknown }>): void;
	pushPointer(u: number, v: number, buttons: number, mods?: number): void;
	pointerLeave(): void;
}

interface WebWallGLStats {
	frame(): { fps: number; running: boolean; idle?: boolean; occluded?: boolean; throttled?: boolean };
}

interface WebWallGLWindow extends Window {
	__wp?: WebWallGLControl;
	__wpStats?: WebWallGLStats;
}

const SCENE_LIVE_FIT: Record<OwlWallpaperSettings["fit"], string> = { cover: "cover", contain: "contain" };

/** 设置存储的 {name: 线值} → 渲染页 __wp.updateWebProps 的 {name: {value}} wire 格式。 */
function toWireProps(wire: Record<string, unknown>): Record<string, { value: unknown }> {
	const out: Record<string, { value: unknown }> = {};
	for (const [name, value] of Object.entries(wire)) out[name] = { value };
	return out;
}

function buildSceneLiveUrl(spec: Extract<RenderSpec, { kind: "sceneLive" }>, settings: OwlWallpaperSettings): string {
	const fit = SCENE_LIVE_FIT[settings.fit] ?? "cover";
	const fps = [15, 30, 60].includes(settings.sceneFps) ? settings.sceneFps : 30;
	const muted = settings.volume > 0 ? "false" : "true";
	const mediaBase = `${window.location.origin}/wallpaper/media`;
	return (
		"/wallpaper-engine/scene-live/index.html?type=scene" +
		`&fit=${encodeURIComponent(fit)}` +
		`&sceneFps=${fps}` +
		`&muted=${muted}` +
		`&src=${encodeURIComponent(spec.pkgToken)}` +
		`&mediaBase=${encodeURIComponent(mediaBase)}`
	);
}

/** scene 首帧预算：15s 起步，按包体积放大（≈100MB 加 10s），硬顶 90s（上游同公式）。 */
function sceneFirstFrameBudget(pkgBytes: number | null): number {
	return Math.min(90_000, Math.max(15_000, 15_000 + (pkgBytes ?? 0) / 10_000));
}

function SceneLiveFrame({
	spec,
	settings,
	visible,
	onReady,
	onFail,
}: MediaLayerProps & { spec: Extract<RenderSpec, { kind: "sceneLive" }> }) {
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const [liveOn, setLiveOn] = useState(false);
	const pausedRef = useRef(false);
	const readyFired = useRef(false);

	const url = useMemo(() => buildSceneLiveUrl(spec, settings), [spec, settings.sceneFps, settings.fit, settings.volume > 0]);

	const wp = (): WebWallGLControl | null => {
		try {
			return (frameRef.current?.contentWindow as WebWallGLWindow | null)?.__wp ?? null;
		} catch {
			return null;
		}
	};
	const statsOf = (): { fps: number; running: boolean } | null => {
		try {
			const stats = (frameRef.current?.contentWindow as WebWallGLWindow | null)?.__wpStats;
			return stats ? stats.frame() : null;
		} catch {
			return null;
		}
	};

	// 属性热下发：面板覆盖值 → 渲染页 updateWebProps（渲染页转发给场景脚本）
	const wire = useMemo(() => settings.props[spec.entryId] ?? {}, [settings.props, spec.entryId]);
	const wireRef = useRef(wire);
	wireRef.current = wire;

	// 首帧轮询 + 看门狗（上游 liveWatch 同思路）
	useEffect(() => {
		let stopped = false;
		let ready = false;
		let startedAt = Date.now();
		let stallTicks = 0;
		const budget = sceneFirstFrameBudget(spec.pkgBytes);
		const fail = (reason: string): void => {
			if (stopped) return;
			stopped = true;
			console.warn(`[wallpaper] scene live ${reason}: ${spec.entryId}`);
			onFail(spec.key);
		};
		const poll = setInterval(() => {
			if (stopped || ready) return;
			const stats = statsOf();
			if (stats && stats.running && stats.fps > 0) {
				ready = true;
				setLiveOn(true);
				if (!readyFired.current) {
					readyFired.current = true;
					onReady(spec.key);
				}
				// 首帧后回放用户属性覆盖（面板改过的值不丢）
				try {
					if (Object.keys(wireRef.current).length) wp()?.updateWebProps(toWireProps(wireRef.current));
				} catch {}
			}
		}, 500);
		const watch = setInterval(() => {
			if (stopped) return;
			if (!ready) {
				// 页面隐藏时渲染页出不了帧是物理事实，冻结预算
				if (document.hidden) {
					startedAt = Date.now();
					return;
				}
				if (Date.now() - startedAt > budget) fail("timeout");
				return;
			}
			if (pausedRef.current) return; // 暂停期不算 stall
			const stats = statsOf();
			const alive = Boolean(stats && stats.running && stats.fps > 0);
			if (!alive) {
				stallTicks++;
				if (stallTicks === 20) {
					try {
						wp()?.resume(); // 先自救一次
					} catch {}
				} else if (stallTicks >= 40) {
					fail("stall");
				}
			} else {
				stallTicks = 0;
			}
		}, 1000);
		return () => {
			stopped = true;
			clearInterval(poll);
			clearInterval(watch);
		};
	}, [spec, onReady, onFail]);

	// 播放态（scene）：__wp.pause/resume 只在状态翻转时调（频繁 resume 会重置帧计量）
	useEffect(() => {
		let last: boolean | null = null;
		const apply = (): void => {
			const occluded = isOccluded(settings);
			if (occluded === last) return;
			last = occluded;
			pausedRef.current = occluded;
			try {
				if (occluded) wp()?.pause();
				else wp()?.resume();
			} catch {}
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 音量/填充/属性：值变化时热调
	useEffect(() => {
		try {
			wp()?.setVolume(settings.volume);
		} catch {}
	}, [settings.volume]);
	useEffect(() => {
		try {
			wp()?.setFit(SCENE_LIVE_FIT[settings.fit] ?? "cover");
		} catch {}
	}, [settings.fit]);
	useEffect(() => {
		if (!liveOn) return;
		try {
			if (Object.keys(wire).length) wp()?.updateWebProps(toWireProps(wire));
		} catch {}
	}, [wire, liveOn]);

	// 指针注入：壁纸层不收指针（pointer-events:none），父页在 window 捕获阶段取鼠标
	// 坐标换算归一化 u/v（Y 朝下），rAF 合帧后推给渲染页（上游 ensureLivePointer 同思路）。
	useEffect(() => {
		if (!liveOn) return;
		let pending: { u: number; v: number; buttons: number } | null = null;
		let raf = 0;
		const flush = (): void => {
			raf = 0;
			if (!pending) return;
			try {
				wp()?.pushPointer(pending.u, pending.v, pending.buttons, 0);
			} catch {}
			pending = null;
		};
		const onMove = (e: MouseEvent): void => {
			pending = { u: e.clientX / window.innerWidth, v: e.clientY / window.innerHeight, buttons: e.buttons & 1 };
			if (!raf) raf = requestAnimationFrame(flush);
		};
		const onLeave = (): void => {
			try {
				wp()?.pointerLeave();
			} catch {}
		};
		window.addEventListener("mousemove", onMove, true);
		window.addEventListener("mousedown", onMove, true);
		window.addEventListener("blur", onLeave);
		return () => {
			window.removeEventListener("mousemove", onMove, true);
			window.removeEventListener("mousedown", onMove, true);
			window.removeEventListener("blur", onLeave);
			if (raf) cancelAnimationFrame(raf);
		};
	}, [liveOn]);

	// 垫底：预览图先上屏（内容闸门：scene 首帧前不露黑底），首帧后 iframe 淡入盖住
	return (
		<>
			{spec.previewUrl && (
				<img
					src={spec.previewUrl}
					alt=""
					draggable={false}
					className={`owl-wallpaper-media is-${settings.fit} owl-wp-fade ${liveOn ? "is-under" : "is-on"}`}
				/>
			)}
			<iframe
				ref={frameRef}
				src={url}
				title="wallpaper-scene"
				allow="autoplay"
				className={`owl-wallpaper-media is-fill owl-wp-fade ${liveOn ? "is-on" : ""}`}
			/>
		</>
	);
}
