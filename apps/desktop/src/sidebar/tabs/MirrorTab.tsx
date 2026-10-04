/**
 * 短剧 tab —— 窗口镜像（owl Mirror）。
 *
 * 把本机一个顶层窗口（典型：应用宝容器里的红果短剧）经桥进程的 WGC worker
 * 抓成 JPEG 帧流画到本卡片。纯观看面：无输入转发、无 agent 工具 —— 选剧/
 * 操作直接切到原窗口（底栏按钮可一键拉回被收纳的窗口）。声音走原窗口自身
 * （系统混音器），卡片只有画面。
 *
 * 纪律与 BrowserTab 相同：帧走 canvas 直绘（frameRef + setTimeout 合并），
 * 刻意不逐帧 setState；绘制与测量都不依赖 rAF/ResizeObserver 单独工作
 * （桌面壳里可能被饿死），舞台尺寸「立即量一次 + RO + 1s 兜底轮询」。
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import type { MirrorWindowInfo } from "../../bridge/protocol.ts";
import { BrowserSessionContext, type TabComponentProps } from "../registry.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";

interface Frame {
	data: string;
	width: number;
	height: number;
}

const NO_FRAME_RETRY_MS = 3_000;

/** 红果窗口优先（桥端已标 hongguo），其后按标题排序由桥端完成。 */
function pickDefaultWindow(windows: MirrorWindowInfo[]): MirrorWindowInfo | undefined {
	const live = windows.filter((win) => !win.minimized);
	return live.find((win) => win.hongguo) ?? live[0] ?? windows.find((win) => win.hongguo);
}

export function MirrorTab({ tab, store, client }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const sessionId = useContext(BrowserSessionContext);
	void sessionId;

	const [windows, setWindows] = useState<MirrorWindowInfo[]>([]);
	const [supported, setSupported] = useState(true);
	const [picked, setPicked] = useState<string | undefined>(undefined);
	const [listError, setListError] = useState("");
	const [frameSize, setFrameSize] = useState<{ width: number; height: number } | undefined>(undefined);
	const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
	const [autoRestored, setAutoRestored] = useState(0);

	const stageRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef<Frame | undefined>(undefined);
	const drawScheduled = useRef(false);
	const pickedRef = useRef<string | undefined>(undefined);
	pickedRef.current = picked;

	const pickedWindow = windows.find((win) => win.windowId === picked);

	// -- 帧绘制（BrowserTab 同款纪律） ----------------------------------
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
			// contain 适配：居中信箱
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

	// -- 打开卡片：枚举窗口 + 自动绑定 ----------------------------------
	const refreshList = useCallback((): void => {
		setListError("");
		void client
			.request<{ windows: MirrorWindowInfo[]; supported: boolean }>({ type: "mirror.list" })
			.then((response) => {
				if (!response.ok || !response.result) {
					setListError(response.error ?? "mirror.list failed");
					return;
				}
				setSupported(response.result.supported);
				setWindows(response.result.windows);
				// 自动绑定：当前选择失效或未选时挑红果
				const current = pickedRef.current;
				if (!current || !response.result.windows.some((win) => win.windowId === current)) {
					const next = pickDefaultWindow(response.result.windows);
					setPicked(next?.windowId);
				}
			})
			.catch((error) => {
				setListError(error instanceof Error ? error.message : String(error));
			});
	}, [client]);

	useEffect(() => {
		refreshList();
	}, [refreshList]);

	// -- 绑定 → attach；3s 无帧重发一次（首帧可能丢，iab 同款） ----------
	useEffect(() => {
		if (!picked) return;
		const windowId = picked;
		void client.request({ type: "mirror.attach", windowId }).catch(() => {});
		const retryTimer = setTimeout(() => {
			if (!frameRef.current) {
				void client.request({ type: "mirror.attach", windowId }).catch(() => {});
			}
		}, NO_FRAME_RETRY_MS);
		return () => {
			clearTimeout(retryTimer);
			void client.request({ type: "mirror.detach", windowId }).catch(() => {});
		};
	}, [client, picked]);

	// -- 帧流 / 清单消息 -------------------------------------------------
	useEffect(() => {
		return client.onMirrorMessage((message) => {
			if (message.type === "mirror.frame") {
				if (message.windowId !== pickedRef.current) return;
				const next = { data: message.data, width: message.width, height: message.height };
				frameRef.current = next;
				setFrameSize((prev) =>
					prev && prev.width === next.width && prev.height === next.height
						? prev
						: { width: next.width, height: next.height },
				);
				scheduleDraw();
				return;
			}
			if (message.type === "mirror.windows") {
				setWindows(message.windows);
				const current = pickedRef.current;
				if (current && !message.windows.some((win) => win.windowId === current)) {
					// 绑定的窗口没了：回退自动挑选
					const next = pickDefaultWindow(message.windows);
					setPicked(next?.windowId);
				}
			}
		});
	}, [client, scheduleDraw]);

	// -- canvas 挂载/舞台尺寸就位时补画缓冲帧（后台绑定期收到的帧） --------
	useEffect(() => {
		if (frameSize && stageSize.width > 0) scheduleDraw();
	}, [frameSize, stageSize.width, scheduleDraw]);

	// -- 舞台尺寸：立即量一次 + RO + 1s 兜底轮询（BrowserTab 同款） --------
	useEffect(() => {
		const element = stageRef.current;
		if (!element) return;
		const measure = (): void => {
			setStageSize((current) => {
				const width = element.clientWidth;
				const height = element.clientHeight;
				if (current.width === width && current.height === height) return current;
				return { width, height };
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		window.addEventListener("resize", measure);
		const poll = setInterval(measure, 1_000);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			clearInterval(poll);
		};
	}, [picked, frameSize !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps

	// -- 操作 ------------------------------------------------------------
	const restoreWindow = (): void => {
		const windowId = pickedRef.current;
		if (!windowId) return;
		void client.request({ type: "mirror.restore", windowId }).catch(() => {});
	};

	const launchApp = (): void => {
		void client.request({ type: "mirror.launch" })
			.then(() => new Promise((resolve) => setTimeout(resolve, 2500)))
			.then(() => refreshList())
			.catch(() => refreshList());
	};

	// -- 渲染 ------------------------------------------------------------
	if (!supported) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
				<p className="text-xs text-owl-faint">{t("mirror.unsupported")}</p>
			</div>
		);
	}

	if (!pickedWindow) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
				<span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-400">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6" aria-hidden="true">
						<rect x="2" y="4" width="15" height="16" rx="2" />
						<path d="m22 8-5 4 5 4V8Z" fill="currentColor" stroke="none" />
					</svg>
				</span>
				<h3 className="text-sm font-semibold text-owl-text">{t("mirror.emptyTitle")}</h3>
				<p className="max-w-[280px] text-xs leading-relaxed text-owl-faint">{t("mirror.emptyDesc")}</p>
				<div className="mt-1 space-y-1 text-left text-xs leading-relaxed text-owl-muted">
					<div>1. {t("mirror.step1")}</div>
					<div>2. {t("mirror.step2")}</div>
					<div>3. {t("mirror.step3")}</div>
				</div>
				<div className="mt-2 flex items-center gap-2">
					<button
						type="button"
						className="rounded-md bg-rose-500 px-3.5 py-1.5 text-xs font-medium text-white hover:brightness-110"
						onClick={launchApp}
					>
						{t("mirror.openApp")}
					</button>
					<button
						type="button"
						className="rounded-md border border-owl-border px-3 py-1.5 text-xs text-owl-muted hover:border-owl-muted hover:text-owl-text"
						onClick={refreshList}
					>
						{t("mirror.rescan")}
					</button>
				</div>
				{listError ? <p className="text-[10px] text-rose-400/80">{listError}</p> : null}
			</div>
		);
	}

	const minimized = pickedWindow.minimized;

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶栏：标题 + 窗口选择 */}
			<div className="flex shrink-0 items-center gap-2 border-b border-owl-border/60 px-2.5 py-2">
				<span className="text-xs font-semibold text-owl-text">{t("mirror.title")}</span>
				<span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-1.5 py-px text-[10px] text-rose-400">
					{t("mirror.liveBadge")}
				</span>
				<select
					aria-label={t("mirror.pickWindow")}
					value={picked ?? ""}
					onChange={(event) => setPicked(event.target.value)}
					className="ml-auto h-6 min-w-0 max-w-[190px] truncate rounded-md border border-owl-border/50 bg-owl-panel px-1.5 text-[11px] text-owl-muted outline-none"
				>
					{windows.map((win) => (
						<option key={win.windowId} value={win.windowId}>
							{win.title || win.process}
							{win.minimized ? `（${t("mirror.minimizedTag")}）` : ""}
						</option>
					))}
				</select>
			</div>

			{/* 画面舞台 */}
			<div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
				<canvas
					ref={canvasRef}
					className={`absolute inset-0 h-full w-full transition-[filter] ${minimized ? "opacity-45 grayscale" : ""}`}
				/>
				{!minimized && frameSize ? (
					<div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1.5">
						<span className="rounded-full border border-white/15 bg-black/60 px-2 py-px text-[10px] text-emerald-300 backdrop-blur">
							{t("mirror.liveBadge")} · {frameSize.width}×{frameSize.height}
						</span>
					</div>
				) : null}
				{minimized ? (
					<div className="absolute inset-x-2 top-2 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-950/80 px-3 py-2 text-[11px] text-amber-200">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
							<circle cx="12" cy="12" r="10" />
							<path d="M10 9v6M14 9v6" />
						</svg>
						<span className="min-w-0">{t("mirror.minimizedHint")}</span>
						<button type="button" className="ml-auto shrink-0 font-semibold text-amber-300 hover:text-amber-200" onClick={restoreWindow}>
							{t("mirror.restore")}
						</button>
					</div>
				) : null}
				{!frameSize && !minimized ? (
					<div className="absolute inset-0 flex items-center justify-center">
						<span className="text-[11px] text-owl-faint">{t("mirror.waitingFrame")}</span>
					</div>
				) : null}
			</div>

			{/* 底栏 */}
			<div className="flex shrink-0 items-center gap-2 border-t border-owl-border/60 px-2.5 py-1.5 text-[10px] text-owl-faint">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3 w-3" aria-hidden="true">
					<path d="M11 5 6 9H2v6h4l5 4V5Z" />
					<path d="M15.5 8.5a5 5 0 0 1 0 7" />
				</svg>
				<span className="truncate">{t("mirror.soundNote")}</span>
				<span className="flex-1" />
				{autoRestored > 0 ? <span className="text-amber-400/80">×{autoRestored}</span> : null}
				<button
					type="button"
					title={t("mirror.rescan")}
					className="flex items-center gap-1 rounded border border-owl-border/60 px-1.5 py-0.5 text-[10px] text-owl-muted hover:border-owl-muted hover:text-owl-text"
					onClick={refreshList}
				>
					<IconRefresh size={10} />
					{t("mirror.rescanShort")}
				</button>
				<button
					type="button"
					title={t("mirror.openWindowTitle")}
					className="flex items-center gap-1 rounded border border-owl-border/60 px-1.5 py-0.5 text-[10px] text-owl-muted hover:border-owl-muted hover:text-owl-text"
					onClick={restoreWindow}
				>
					<IconExternal size={10} />
					{t("mirror.openWindow")}
				</button>
			</div>
		</div>
	);
}
