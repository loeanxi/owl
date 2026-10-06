/**
 * 短剧 tab —— 侧栏嵌入。
 *
 * 红果窗口设成 owl 的 owned 窗口，摆在侧栏舞台上，点按由红果自己接收。
 * 嵌进去之后不再改样式、不裁标题。侧栏尺寸变化时跟着摆；只有窗口被最小化
 * 或明显离开舞台时才拉回来。放大和悬浮不做。
 *
 * 嵌入失败时回退到帧流（只能看，不能点）。
 */
import { useCallback, useContext, useEffect, useReducer, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import type { MirrorWindowInfo } from "../../bridge/protocol.ts";
import { BrowserSessionContext, type TabComponentProps } from "../registry.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";
import { hideRect, viewportToParentClient } from "../../../../../packages/coding-agent/src/modes/desktop/mirror/embed-layout.ts";
import { createEmbedReducer, type EmbedAction, type EmbedState } from "../../../../../packages/coding-agent/src/modes/desktop/mirror/embed-state.ts";

interface Frame {
	data: string;
	width: number;
	height: number;
}

const TOOLBAR_H = 28;

interface StageBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

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
	const [fallback, setFallback] = useState(false);
	const [embedError, setEmbedError] = useState("");
	const [launching, setLaunching] = useState(false);
	const [listed, setListed] = useState(false);
	const [frameSize, setFrameSize] = useState<{ width: number; height: number } | undefined>(undefined);
	const [stageBox, setStageBox] = useState<StageBox>({ x: 0, y: 0, width: 0, height: 0 });

	const reducer = useCallback(
		(state: EmbedState, action: EmbedAction) => createEmbedReducer()(state, action).state,
		[],
	);
	const [state, dispatch] = useReducer(reducer, { phase: "restored" } as EmbedState);
	const embedded = state.phase === "embedded";
	const visible = state.phase === "embedded" && state.visible;

	const stageRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef<Frame | undefined>(undefined);
	const drawScheduled = useRef(false);
	const windowIdRef = useRef<string | undefined>(undefined);
	const embedTried = useRef<string | undefined>(undefined);
	const readStageRectRef = useRef<() => ReturnType<typeof viewportToParentClient> | undefined>(() => undefined);

	const hongguo = pickHongguo(windows);
	windowIdRef.current = hongguo?.windowId;

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

	const measure = useCallback((): void => {
		const element = stageRef.current;
		const shown = element !== null && element.getClientRects().length > 0;
		const box = shown ? element.getBoundingClientRect() : undefined;
		const next =
			box && box.width >= 8 && box.height >= 8
				? { x: box.left, y: box.top, width: box.width, height: box.height }
				: { x: 0, y: 0, width: 0, height: 0 };
		setStageBox((current) => {
			if (
				current.x === next.x &&
				current.y === next.y &&
				current.width === next.width &&
				current.height === next.height
			) {
				return current;
			}
			return next;
		});
	}, []);
	useEffect(() => {
		measure();
		const observer = new ResizeObserver(measure);
		if (stageRef.current) observer.observe(stageRef.current);
		window.addEventListener("resize", measure);
		const poll = setInterval(measure, 250);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			clearInterval(poll);
		};
	}, [measure, embedded, fallback, hongguo]);

	const readStageRect = useCallback(() => {
		const element = stageRef.current;
		// 侧栏关掉、切到别的页时祖先是 display:none，矩形是 0。
		// 不能退回上一次的尺寸，否则红果会停在关掉之前的位置。
		if (!element || element.getClientRects().length === 0) return undefined;
		const box = element.getBoundingClientRect();
		if (box.width < 8 || box.height < 8) return undefined;
		return viewportToParentClient(
			{ x: box.left, y: box.top, width: box.width, height: box.height },
			window.devicePixelRatio || 1,
		);
	}, []);
	readStageRectRef.current = readStageRect;

	const sendLayout = useCallback(
		(visible: boolean): void => {
			const windowId = windowIdRef.current;
			if (!windowId) return;
			if (!visible) {
				void client.request({ type: "mirror.layout", windowId, rect: hideRect(), visible: false }).catch(() => {});
				return;
			}
			const rect = readStageRect();
			if (!rect) return;
			void client.request({ type: "mirror.layout", windowId, rect, visible: true }).catch(() => {});
		},
		[client, readStageRect],
	);

	useEffect(() => {
		if (!hongguo || embedded || fallback) return;
		const windowId = hongguo.windowId;
		let alive = true;
		let attempts = 0;
		const tryEmbed = (): void => {
			if (!alive || embedTried.current === windowId) return;
			const rect = readStageRectRef.current();
			if (!rect) return;
			embedTried.current = windowId;
			attempts += 1;
			void client
				.request({ type: "mirror.embed", windowId, rect })
				.then((response) => {
					if (!alive) return;
					if (!response.ok) throw new Error(response.error ?? "embed failed");
					setEmbedError("");
					dispatch({ type: "embed", mode: "sidebar" });
				})
				.catch((error: unknown) => {
					if (!alive) return;
					embedTried.current = undefined;
					const message = error instanceof Error ? error.message : "embed failed";
					setEmbedError(message);
					if (attempts >= 4) {
						setFallback(true);
						void client.request({ type: "mirror.attach", windowId }).catch(() => {});
					}
				});
		};
		tryEmbed();
		const timer = setInterval(tryEmbed, 700);
		return () => {
			alive = false;
			clearInterval(timer);
			// 舞台尺寸一变就会重跑这个效果。进行中的请求被丢掉时必须允许再嵌一次，
			// 否则页面会一直停在「等待画面」，后面的位置更新也不会再发。
			if (embedTried.current === windowId) embedTried.current = undefined;
		};
	}, [hongguo, embedded, fallback, client]);

	const layoutKey = `${stageBox.x},${stageBox.y},${stageBox.width}x${stageBox.height}`;
	useEffect(() => {
		if (!windowIdRef.current) return;
		const rect = readStageRectRef.current();
		if (!rect) {
			sendLayout(false);
			return;
		}
		if (!visible) return;
		sendLayout(true);
	}, [layoutKey, visible, sendLayout]);

	useEffect(() => {
		const onVisibility = (): void => {
			if (!embedded) return;
			if (document.visibilityState === "hidden") sendLayout(false);
			else sendLayout(true);
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [embedded, sendLayout]);

	useEffect(() => {
		return () => {
			const windowId = windowIdRef.current;
			if (!windowId) return;
			void client.request({ type: "mirror.layout", windowId, rect: hideRect(), visible: false }).catch(() => {});
		};
	}, [client]);

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
		if (fallback && frameSize && stageBox.width > 0) scheduleDraw();
	}, [fallback, frameSize, stageBox.width, scheduleDraw]);

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

	useEffect(() => {
		if (!listed || !supported || hongguo || autoLaunched.current) return;
		autoLaunched.current = true;
		launchApp();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [listed, supported, hongguo]);

	const toolbar = (
		<div className="flex shrink-0 items-center gap-1.5 bg-owl-panel px-2" style={{ height: TOOLBAR_H }}>
			<span className="text-xs font-semibold text-owl-text">{t("mirror.title")}</span>
			<span className="flex-1" />
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

	if (!hongguo) {
		return (
			<div className="absolute inset-0 flex flex-col">
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

	return (
		<div className="absolute inset-0 flex min-h-0 flex-col">
			{toolbar}
			<div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
				{fallback ? (
					<canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
				) : embedded ? null : (
					<div className="absolute inset-0 flex items-center justify-center px-4 text-center">
						<span className="text-[11px] text-owl-faint">{embedError || t("mirror.waitingFrame")}</span>
					</div>
				)}
			</div>
		</div>
	);
}
