/**
 * 短剧 tab v2 —— 窗口嵌入（owl Mirror embed）。
 *
 * 按第二轮共识：把红果窗口跨进程 SetParent 成 owl 主窗口的子窗口并去头，
 * 真实嵌在卡片里直接刷剧。三种形态（顶部窄条切换）：
 * - sidebar：嵌在侧边卡片（等比 contain，画面外露黑底）
 * - expand：放大盖住 owl 主区
 * - float：owl 内悬浮（拖拽条拖动位置，± 按钮步进缩放）
 *
 * 物理约束：原生窗口永远盖在 webview 内容之上 —— 所有控件都放在画面外的
 * 顶部窄条（webview 区域），「悬停浮层按钮」不成立。声音走红果进程自身。
 * 嵌入失败（协议报错）自动回退 WGC 帧流模式（v1 路径，保底可用）。
 *
 * 纪律与 BrowserTab 相同：帧走 canvas 直绘（frameRef + setTimeout 合并）、
 * 舞台测量「立即量一次 + RO + 1s 兜底轮询」。嵌入状态机（embed-state.ts，
 * 已单测）驱动形态与隐藏/显示规则；几何计算（embed-layout.ts，已单测）按
 * 形态舞台输出父客户区物理矩形。
 */
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import type { MirrorWindowInfo } from "../../bridge/protocol.ts";
import { BrowserSessionContext, type TabComponentProps } from "../registry.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";
import { computeLayout, hideRect, type EmbedMode } from "../../../../../packages/coding-agent/src/modes/desktop/mirror/embed-layout.ts";
import { createEmbedReducer, type EmbedAction, type EmbedState } from "../../../../../packages/coding-agent/src/modes/desktop/mirror/embed-state.ts";

interface Frame {
	data: string;
	width: number;
	height: number;
}

const TOOLBAR_H = 28;
/** 红果窗口的参考尺寸（嵌入等比 contain 用；窗口实际尺寸以系统为准）。 */
const HONGGUO_REF = { width: 568, height: 920 };

function pickHongguo(windows: MirrorWindowInfo[]): MirrorWindowInfo | undefined {
	const live = windows.filter((win) => !win.minimized);
	return live.find((win) => win.hongguo) ?? windows.find((win) => win.hongguo);
}

export function MirrorTab({ tab, store, client }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const sessionId = useContext(BrowserSessionContext);
	void sessionId;
	void tab;
	void store;

	const [windows, setWindows] = useState<MirrorWindowInfo[]>([]);
	const [supported, setSupported] = useState(true);
	const [fallback, setFallback] = useState(false); // 嵌入失败 → 帧流兜底
	const [launching, setLaunching] = useState(false);
	const [listed, setListed] = useState(false);
	const [frameSize, setFrameSize] = useState<{ width: number; height: number } | undefined>(undefined);
	const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
	const [viewport, setViewport] = useState({ width: 0, height: 0 });
	const [floatPos, setFloatPos] = useState({ x: 80, y: 80 });
	const [floatSize, setFloatSize] = useState({ width: 420, height: 700 });
	const [dragging, setDragging] = useState(false);

	// 嵌入状态机（单测覆盖的纯 reducer）
	const reducer = useCallback(
		(state: EmbedState, action: EmbedAction) => createEmbedReducer()(state, action).state,
		[],
	);
	const [state, dispatch] = useReducer(reducer, { phase: "restored" } as EmbedState);
	const mode = state.phase === "embedded" ? state.mode : "sidebar";
	const embedded = state.phase === "embedded";

	const stageRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef<Frame | undefined>(undefined);
	const drawScheduled = useRef(false);
	const windowIdRef = useRef<string | undefined>(undefined);
	const embedTried = useRef<string | undefined>(undefined);

	const hongguo = useMemo(() => pickHongguo(windows), [windows]);
	windowIdRef.current = hongguo?.windowId;

	// -- 找红果窗口（未找到时 3s 轮询） ----------------------------------
	const refreshList = useCallback((): void => {
		void client
			.request<{ windows: MirrorWindowInfo[]; supported: boolean }>({ type: "mirror.list" })
			.then((response) => {
				if (!response.ok || !response.result) return;
				setSupported(response.result.supported);
				setWindows(response.result.windows);
				setListed(true);
			})
			.catch(() => {});
	}, [client]);

	useEffect(() => {
		refreshList();
	}, [refreshList]);

	useEffect(() => {
		if (hongguo) return;
		const timer = setInterval(refreshList, 3_000);
		return () => clearInterval(timer);
	}, [refreshList, hongguo]);

	// -- 帧绘制（兜底路径） ------------------------------------------------
	const drawFrame = useCallback((): void => {
		drawScheduled.current = false;
		const canvas = canvasRef.current;
		const current = frameRef.current;
		if (!canvas || !current) return;
		if (canvas.width !== current.width || canvas.height !== current.height) {
			canvas.width = current.width;
			canvas.height = current.height;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const image = new Image();
		image.onload = () => {
			if (frameRef.current !== current) return;
			const scale = Math.min(canvas.width / current.width, canvas.height / current.height);
			const dw = current.width * scale;
			const dh = current.height * scale;
			ctx.drawImage(image, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
		};
		image.src = `data:image/jpeg;base64,${current.data}`;
	}, []);
	const scheduleDraw = useCallback((): void => {
		if (drawScheduled.current) return;
		drawScheduled.current = true;
		setTimeout(drawFrame, 0);
	}, [drawFrame]);

	// -- 几何：当前形态的舞台与目标矩形 ------------------------------------
	const stageForMode = useCallback(
		(target: EmbedMode): { width: number; height: number } => {
			const dpr = window.devicePixelRatio || 1;
			if (target === "expand") return { width: viewport.width / dpr, height: (viewport.height - TOOLBAR_H) / dpr };
			if (target === "float") return { width: viewport.width / dpr, height: (viewport.height - TOOLBAR_H) / dpr };
			return { width: stageSize.width, height: Math.max(0, stageSize.height - TOOLBAR_H) };
		},
		[viewport.width, viewport.height, stageSize.width, stageSize.height],
	);

	const sendLayout = useCallback(
		(target: EmbedMode, visible: boolean, sizeOverride?: { width: number; height: number }): void => {
			const windowId = windowIdRef.current;
			if (!windowId) return;
			const dpr = window.devicePixelRatio || 1;
			const stage = stageForMode(target);
			const rect =
				target === "float"
					? { ...floatPos, ...floatSize }
					: computeLayout(target, stage, dpr, HONGGUO_REF);
			void client.request({ type: "mirror.layout", windowId, rect, visible }).catch(() => {});
		},
		[client, stageForMode, floatPos, floatSize],
	);

	// -- 舞台/视口测量（立即 + RO + 1s 轮询） ------------------------------
	const measure = useCallback((): void => {
		const element = stageRef.current;
		if (element) {
			setStageSize((current) => {
				const width = element.clientWidth;
				const height = element.clientHeight;
				if (current.width === width && current.height === height) return current;
				return { width, height };
			});
		}
		setViewport((current) => {
			const width = window.innerWidth;
			const height = window.innerHeight;
			if (current.width === width && current.height === height) return current;
			return { width, height };
		});
	}, []);
	useEffect(() => {
		measure();
		const observer = new ResizeObserver(measure);
		if (stageRef.current) observer.observe(stageRef.current);
		window.addEventListener("resize", measure);
		const poll = setInterval(measure, 1_000);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			clearInterval(poll);
		};
	}, [measure, mode]);

	// -- 嵌入：找到红果且未嵌入 → mirror.embed（sidebar 形态起） ------------
	useEffect(() => {
		if (!hongguo || embedded || fallback) return;
		const windowId = hongguo.windowId;
		if (embedTried.current === windowId) return;
		embedTried.current = windowId;
		// 嵌入失败可能只是 BitDock 收纳竞态：1.5s 后重试一次再放弃
		const attempt = (delayMs: number): Promise<void> =>
			new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => {
				const stage = stageForMode("sidebar");
				const rect = computeLayout("sidebar", stage, window.devicePixelRatio || 1, HONGGUO_REF);
				return client.request({ type: "mirror.embed", windowId, rect });
			}).then((response) => {
				if (!response.ok) throw new Error(response.error ?? "embed failed");
				dispatch({ type: "embed", mode: "sidebar" });
			});
		void attempt(0)
			.catch(() => attempt(1500))
			.catch(() => {
				setFallback(true); // 两次都失败 → 帧流兜底
				void client.request({ type: "mirror.attach", windowId }).catch(() => {});
			});
	}, [hongguo, embedded, fallback, client, stageForMode]);

	// -- 形态/舞台变化 → 重新布局 ------------------------------------------
	const visible = embedded && state.visible;
	const layoutKey = `${mode}:${visible}:${stageSize.width}x${stageSize.height}:${viewport.width}x${viewport.height}`;
	useEffect(() => {
		if (!visible) return;
		sendLayout(mode, true);
	}, [layoutKey, visible, sendLayout, mode]); // eslint-disable-line react-hooks/exhaustive-deps

	// float 拖放/缩放 → relayout
	useEffect(() => {
		const floatVisible = embedded && state.visible;
		if (!embedded || mode !== "float" || !floatVisible) return;
		if (!dragging) {
			const windowId = windowIdRef.current;
			if (!windowId) return;
			const dpr = window.devicePixelRatio || 1;
			const stage = stageForMode("float");
			const rect = computeLayout("float", stage, dpr, HONGGUO_REF, {
				x: floatPos.x * dpr,
				y: floatPos.y * dpr,
				width: floatSize.width * dpr,
				height: floatSize.height * dpr,
			});
			void client.request({ type: "mirror.layout", windowId, rect, visible: true }).catch(() => {});
		}
	}, [floatPos, floatSize, dragging, embedded, mode, visible, stageForMode, client]);

	// owl 隐藏/显示 → 窗口屏外/恢复
	useEffect(() => {
		const onVisibility = (): void => {
			if (!embedded) return;
			if (document.visibilityState === "hidden") {
				const windowId = windowIdRef.current;
				if (windowId) {
					void client.request({ type: "mirror.layout", windowId, rect: hideRect(), visible: false }).catch(() => {});
				}
			} else {
				sendLayout(mode, true);
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [client, embedded, mode, sendLayout]);

	// 卸载：藏到屏外（不解除嵌入；重挂时按新舞台重新 embed 摆放）
	useEffect(() => {
		return () => {
			const windowId = windowIdRef.current;
			if (!windowId) return;
			void client.request({ type: "mirror.layout", windowId, rect: hideRect(), visible: false }).catch(() => {});
		};
	}, [client]);

	// 帧流兜底消息
	useEffect(() => {
		if (!fallback) return;
		return client.onMirrorMessage((message) => {
			if (message.type === "mirror.frame" && message.windowId === windowIdRef.current) {
				const next = { data: message.data, width: message.width, height: message.height };
				frameRef.current = next;
				setFrameSize((prev) =>
					prev && prev.width === next.width && prev.height === next.height
						? prev
						: { width: next.width, height: next.height },
				);
				scheduleDraw();
			}
		});
	}, [client, fallback, scheduleDraw]);

	useEffect(() => {
		if (fallback && frameSize && stageSize.width > 0) scheduleDraw();
	}, [fallback, frameSize, stageSize.width, scheduleDraw]);

	// -- 操作 ------------------------------------------------------------
	const switchMode = (target: EmbedMode): void => {
		const windowId = windowIdRef.current;
		if (!windowId) return;
		// 放大形态：先把 owl 主窗口长到贴合红果（消除黑边/裁切），再摆子窗口
		if (target === "expand") {
			const dramaW = HONGGUO_REF.width;
			const dramaH = HONGGUO_REF.height;
			const owlH = Math.min(1030, dramaH + TOOLBAR_H + 40 + 31); // 963+28工具条+31标题栏+余量
			void client
				.request({ type: "mirror.fitowl", windowId, x: 200, y: 8, width: Math.max(viewport.width, dramaW + 80), height: owlH })
				.then(() => new Promise((resolve) => setTimeout(resolve, 350)))
				.then(() => {
					const rect = { x: Math.round((viewport.width - dramaW) / 2), y: TOOLBAR_H, width: dramaW, height: HONGGUO_REF.height };
					return client.request({ type: "mirror.embed", windowId, rect });
				})
				.then(() => dispatch({ type: "embed", mode: "expand" }))
				.catch(() => {});
			return;
		}
		// 从放大切回：先还原 owl 尺寸
		if (state.phase === "embedded" && state.mode === "expand") {
			void client
				.request({ type: "mirror.fitowl", windowId, x: 200, y: 8, width: 1296, height: 900 })
				.then(() => new Promise((resolve) => setTimeout(resolve, 350)))
				.catch(() => {});
		}
		const stage = stageForMode(target);
		const rect = computeLayout(target, stage, window.devicePixelRatio || 1, HONGGUO_REF);
		void client
			.request({ type: "mirror.embed", windowId, rect })
			.then(() => dispatch({ type: "embed", mode: target }))
			.catch(() => {});
	};
	const restoreWindow = (): void => {
		const windowId = windowIdRef.current;
		if (!windowId) return;
		void client
			.request({ type: "mirror.unembed", windowId })
			.then(() => {
				embedTried.current = undefined;
				dispatch({ type: "restore" });
			})
			.then(() => new Promise((resolve) => setTimeout(resolve, 600)))
			.then(() => refreshList())
			.catch(() => {});
	};
	const autoLaunched = useRef(false);
	const launchApp = (): void => {
		setLaunching(true);
		void client
			.request({ type: "mirror.launch" })
			.then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
			.catch(() => {})
			.then(() => {
				setLaunching(false);
				refreshList();
			});
	};

	// 首次扫描没找到红果窗口 → 自动拉起红果（每次挂载只试一次，失败回落到手动按钮）
	useEffect(() => {
		if (!listed || !supported || hongguo || autoLaunched.current) return;
		autoLaunched.current = true;
		launchApp();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [listed, supported, hongguo]);

	// float 拖拽条：按住拖动（owl 前台时在拖拽条上拖，坐标差应用到 floatPos）
	const gripRef = useRef<HTMLDivElement>(null);
	const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | undefined>(
		undefined,
	);
	const onGripDown = (event: React.PointerEvent): void => {
		if (mode !== "float") return;
		(event.target as HTMLElement).setPointerCapture(event.pointerId);
		dragState.current = { startX: event.clientX, startY: event.clientY, baseX: floatPos.x, baseY: floatPos.y };
		setDragging(true);
	};
	const onGripMove = (event: React.PointerEvent): void => {
		const drag = dragState.current;
		if (!drag) return;
		setFloatPos({
			x: drag.baseX + (event.clientX - drag.startX),
			y: drag.baseY + (event.clientY - drag.startY),
		});
	};
	const onGripUp = (): void => {
		dragState.current = undefined;
		setDragging(false);
	};

	// -- 渲染 ------------------------------------------------------------
	const toolbar = (
		<div
			className="flex shrink-0 items-center gap-1.5 bg-owl-panel px-2"
			style={{ height: TOOLBAR_H }}
		>
			<span className="text-xs font-semibold text-owl-text">{t("mirror.title")}</span>
			<span className="flex-1" />
			{(
				[
					["sidebar", t("mirror.modeSidebar")],
					["expand", t("mirror.modeExpand")],
					["float", t("mirror.modeFloat")],
				] as [EmbedMode, string][]
			).map(([target, label]) => (
				<button
					key={target}
					type="button"
					className={`rounded px-1.5 py-0.5 text-[10px] ${
						embedded && mode === target ? "bg-rose-500/20 text-rose-300" : "text-owl-muted hover:text-owl-text"
					}`}
					onClick={() => switchMode(target)}
				>
					{label}
				</button>
			))}
			<span className="mx-0.5 h-3 w-px bg-owl-border" />
			<button
				type="button"
				title={t("mirror.restore")}
				className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-owl-muted hover:text-owl-text"
				onClick={restoreWindow}
			>
				<IconExternal size={10} />
				{t("mirror.restore")}
			</button>
		</div>
	);

	// 展开形态：整屏覆盖层（盖住对话区）
	if (embedded && mode === "expand") {
		return (
			<div className="fixed inset-0 z-50 flex flex-col bg-black" data-mirror-overlay>
				{toolbar}
				<div ref={stageRef} className="min-h-0 flex-1 bg-black" />
			</div>
		);
	}

	// 悬浮形态：owl 内悬浮 —— 侧栏出控制卡，主区出拖拽条（原生窗口在拖拽条下方）
	if (embedded && mode === "float") {
		const gripTop = floatPos.y - 24;
		return (
			<>
				<div className="flex h-full min-h-0 flex-col">
					{toolbar}
					<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
						<div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
							{t("mirror.floatActive")}
						</div>
						<div className="flex items-center gap-2">
							<button type="button" className="rounded-md border border-owl-border px-3 py-1.5 text-xs text-owl-muted hover:text-owl-text" onClick={() => switchMode("sidebar")}>
								{t("mirror.modeSidebar")}
							</button>
							<button type="button" className="rounded-md border border-owl-border px-3 py-1.5 text-xs text-owl-muted hover:text-owl-text" onClick={restoreWindow}>
								{t("mirror.restore")}
							</button>
						</div>
						<p className="max-w-[260px] text-[11px] leading-relaxed text-owl-faint">{t("mirror.floatHint")}</p>
					</div>
				</div>
				{/* 主区悬浮：拖拽条 + 缩放钮（webview 区；原生窗口在拖拽条正下方） */}
				<div className="fixed inset-0 z-50 pointer-events-none">
					<div
						ref={gripRef}
						className="pointer-events-auto absolute flex select-none items-center justify-between rounded-t-md bg-rose-500/90 px-2 text-[10px] text-white shadow-lg"
						style={{ left: floatPos.x, top: Math.max(0, gripTop), width: floatSize.width, height: 24, cursor: dragging ? "grabbing" : "grab" }}
						onPointerDown={onGripDown}
						onPointerMove={onGripMove}
						onPointerUp={onGripUp}
					>
						<span>{t("mirror.floatGrip")}</span>
						<span className="flex items-center gap-1">
							<button
								type="button"
								className="rounded bg-white/20 px-1.5 hover:bg-white/30"
								onClick={() => setFloatSize((size) => ({ width: Math.max(280, size.width - 60), height: Math.max(480, size.height - 100) }))}
							>−</button>
							<button
								type="button"
								className="rounded bg-white/20 px-1.5 hover:bg-white/30"
								onClick={() => setFloatSize((size) => ({ width: size.width + 60, height: size.height + 100 }))}
							>+</button>
						</span>
					</div>
				</div>
			</>
		);
	}

	// 空态：没找到红果
	if (!hongguo) {
		return (
			<div className="flex h-full flex-col">
				{toolbar}
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<h3 className="text-sm font-semibold text-owl-text">{t("mirror.emptyTitle")}</h3>
					<p className="max-w-[280px] text-xs leading-relaxed text-owl-faint">{t("mirror.emptyDesc")}</p>
					<button
						type="button"
						disabled={launching}
						className="rounded-md bg-rose-500 px-3.5 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
						onClick={launchApp}
					>
						{launching ? t("mirror.launching") : t("mirror.openApp")}
					</button>
					<button
						type="button"
						className="flex items-center gap-1 rounded border border-owl-border px-2 py-1 text-[10px] text-owl-muted hover:text-owl-text"
						onClick={refreshList}
					>
						<IconRefresh size={10} />
						{t("mirror.rescan")}
					</button>
				</div>
			</div>
		);
	}

	// 侧栏形态 / 帧流兜底：画面舞台
	return (
		<div className="flex h-full min-h-0 flex-col">
			{toolbar}
			<div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
				{fallback ? (
					<canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
				) : (
					<div className="absolute inset-0 flex items-center justify-center">
						<span className="text-[11px] text-owl-faint">{t("mirror.waitingFrame")}</span>
					</div>
				)}
			</div>
		</div>
	);
}
