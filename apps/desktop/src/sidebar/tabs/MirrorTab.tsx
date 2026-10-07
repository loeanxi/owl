/** Complete WGC frames are scaled here; input maps back to the same source window. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	DesktopClientRequestWithoutId,
	MirrorProjectionGeometry,
	MirrorWindowInfo,
} from "../../bridge/protocol.ts";
import { useT } from "../../i18n/index.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";
import type { TabComponentProps } from "../registry.ts";
import { mirrorContentPoint, type MirrorPoint, validMirrorCrop } from "./mirror-geometry.ts";

interface Frame {
	windowId: string;
	data: string;
	width: number;
	height: number;
	geometry: MirrorProjectionGeometry;
}
interface Gesture {
	pointerId: number;
	windowId: string;
	geometryId: string;
	start: MirrorPoint;
	last: MirrorPoint;
	x: number;
	y: number;
	dragging: boolean;
	axis?: "vertical" | "horizontal";
	pageCommitted: boolean;
}
type InputRequest = Extract<DesktopClientRequestWithoutId, { type: "mirror.input" }>;
type WheelRequest = InputRequest & { action: "wheel"; deltaY: number };
function takeWheelBatch(queue: WheelRequest[]): WheelRequest | undefined {
	const request = queue.shift();
	if (!request) return undefined;
	const deltaY = Math.max(-32767, Math.min(32767, request.deltaY));
	if (deltaY !== request.deltaY) queue.unshift({ ...request, deltaY: request.deltaY - deltaY });
	return { ...request, deltaY };
}
// Closing and reopening a tab must not let the old instance hide the new projection.
const connectionCommands = new WeakMap<TabComponentProps["client"], { queue: Promise<void>; generation: number }>();

export function MirrorTab({ tab, store, client }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const [windows, setWindows] = useState<MirrorWindowInfo[]>([]);
	const [supported, setSupported] = useState(true);
	const [listed, setListed] = useState(false);
	const [launching, setLaunching] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [panelVisible, setPanelVisible] = useState(false);
	const [connected, setConnected] = useState(true);
	const [retry, setRetry] = useState(0);
	const [hasFrame, setHasFrame] = useState(false);
	const [error, setError] = useState("");
	const panelRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const visibleRef = useRef(false);
	const restoringRef = useRef(false);
	const mountedRef = useRef(true);
	const selectedRef = useRef<string | undefined>(undefined);
	const activeStream = useRef<string | undefined>(undefined);
	const attachedWindow = useRef<string | undefined>(undefined);
	const projection = useRef<MirrorProjectionGeometry | undefined>(undefined);
	const frameRef = useRef<Frame | undefined>(undefined);
	const displayedFrame = useRef<Frame | undefined>(undefined);
	const decoding = useRef(false);
	const frameEpoch = useRef(0);
	const frameShown = useRef(false);
	const pointer = useRef<Gesture | undefined>(undefined);
	const queuedMove = useRef<InputRequest | undefined>(undefined);
	const moving = useRef(false);
	const queuedWheel = useRef<WheelRequest[]>([]);
	const wheelRemainder = useRef(0);
	const wheeling = useRef(false);
	const commandSession = useMemo(() => {
		let session = connectionCommands.get(client);
		if (!session) {
			session = { queue: Promise.resolve(), generation: 0 };
			connectionCommands.set(client, session);
		}
		return session;
	}, [client]);
	const listRevision = useRef(0);
	const listPending = useRef(false);
	const autoLaunched = useRef(false);
	const live = windows.filter((candidate) => !candidate.minimized);
	const hongguo = live.find((candidate) => candidate.hongguo) ?? windows.find((candidate) => candidate.hongguo);
	const windowId = hongguo?.windowId;
	selectedRef.current = windowId;

	const requestWindow = useCallback(
		<T,>(request: DesktopClientRequestWithoutId) => {
			const generation = commandSession.generation;
			const pending = commandSession.queue.then(() => {
				if (generation !== commandSession.generation) throw new Error("bridge connection changed");
				return client.request<T>(request);
			});
			commandSession.queue = pending.then(
				() => {},
				() => {},
			);
			return pending;
		},
		[client, commandSession],
	);
	const sendInput = useCallback(
		(request: InputRequest): void => {
			void requestWindow(request).catch(() => {});
		},
		[requestWindow],
	);
	const cancelPointer = useCallback((): void => {
		queuedMove.current = undefined;
		queuedWheel.current = [];
		const gesture = pointer.current;
		pointer.current = undefined;
		if (!gesture) return;
		if (gesture.axis === "horizontal")
			sendInput({
				type: "mirror.input",
				windowId: gesture.windowId,
				geometryId: gesture.geometryId,
				action: "cancel",
				...gesture.last,
			});
		try {
			canvasRef.current?.releasePointerCapture(gesture.pointerId);
		} catch {}
	}, [sendInput]);
	const drainMove = useCallback(
		function drain(): void {
			if (moving.current || !queuedMove.current) return;
			const request = queuedMove.current;
			queuedMove.current = undefined;
			moving.current = true;
			void requestWindow(request)
				.catch(() => {})
				.finally(() => {
					moving.current = false;
					if (queuedMove.current) drain();
				});
		},
		[requestWindow],
	);
	const drainWheel = useCallback(
		function drain(): void {
			if (wheeling.current) return;
			const request = takeWheelBatch(queuedWheel.current);
			if (!request) return;
			wheeling.current = true;
			void requestWindow(request)
				.catch(() => {})
				.finally(() => {
					wheeling.current = false;
					drain();
				});
		},
		[requestWindow],
	);
	const clearFrame = useCallback((): void => {
		wheelRemainder.current = 0;
		frameEpoch.current += 1;
		decoding.current = false;
		frameShown.current = false;
		frameRef.current = undefined;
		displayedFrame.current = undefined;
		projection.current = undefined;
		const canvas = canvasRef.current;
		if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
		if (mountedRef.current) setHasFrame(false);
	}, []);
	const drawNextFrame = useCallback(function drawNext(): void {
		if (decoding.current || !frameRef.current) return;
		const next = frameRef.current;
		frameRef.current = undefined;
		const epoch = frameEpoch.current;
		decoding.current = true;
		const image = new Image();
		const finish = (loaded: boolean): void => {
			if (epoch !== frameEpoch.current) return;
			decoding.current = false;
			const canvas = canvasRef.current;
			if (
				loaded &&
				canvas &&
				activeStream.current === next.windowId &&
				visibleRef.current &&
				projection.current?.geometryId === next.geometry.geometryId
			) {
				const crop = next.geometry.crop;
				if (canvas.width !== crop.width) canvas.width = crop.width;
				if (canvas.height !== crop.height) canvas.height = crop.height;
				const context = canvas.getContext("2d");
				if (context) {
					context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
					displayedFrame.current = next;
					if (!frameShown.current) {
						frameShown.current = true;
						setHasFrame(true);
					}
				}
			}
			// Finish useful work even when a newer frame arrived during decoding,
			// then jump directly to the newest pending frame instead of building a backlog.
			drawNext();
		};
		image.onload = () => finish(true);
		image.onerror = () => finish(false);
		image.src = `data:image/jpeg;base64,${next.data}`;
	}, []);
	const refreshList = useCallback((): void => {
		if (listPending.current || restoringRef.current) return;
		listPending.current = true;
		const revision = listRevision.current;
		void client
			.request<{ windows: MirrorWindowInfo[]; supported: boolean }>({ type: "mirror.list" })
			.then((response) => {
				if (!mountedRef.current || revision !== listRevision.current || !response.ok || !response.result) return;
				setWindows(response.result.windows);
				setSupported(response.result.supported);
				setListed(true);
			})
			.catch(() => {})
			.finally(() => {
				listPending.current = false;
			});
	}, [client]);

	useEffect(() => {
		mountedRef.current = true;
		refreshList();
		return () => {
			mountedRef.current = false;
		};
	}, [refreshList]);
	useEffect(() => {
		const measure = (): void => {
			const element = panelRef.current;
			const bounds = element?.getBoundingClientRect();
			let shown =
				document.visibilityState !== "hidden" &&
				Boolean(element?.getClientRects().length) &&
				Boolean(
					bounds &&
						bounds.width > 0 &&
						bounds.height > 0 &&
						bounds.right > 0 &&
						bounds.bottom > 0 &&
						bounds.left < document.documentElement.clientWidth &&
						bounds.top < document.documentElement.clientHeight,
				);
			for (let ancestor: HTMLElement | null = element; shown && ancestor; ancestor = ancestor.parentElement) {
				const style = getComputedStyle(ancestor);
				if (style.visibility === "hidden" || style.visibility === "collapse") shown = false;
			}
			visibleRef.current = shown;
			setPanelVisible(shown);
		};
		measure();
		const observer = new ResizeObserver(measure);
		if (panelRef.current) observer.observe(panelRef.current);
		const timer = setInterval(measure, 250);
		window.addEventListener("resize", measure);
		document.addEventListener("visibilitychange", measure);
		return () => {
			observer.disconnect();
			clearInterval(timer);
			window.removeEventListener("resize", measure);
			document.removeEventListener("visibilitychange", measure);
		};
	}, []);
	useEffect(() => {
		const refreshVisible = (): void => {
			if (visibleRef.current) refreshList();
		};
		const timer = setInterval(refreshVisible, 15_000);
		window.addEventListener("focus", refreshVisible);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", refreshVisible);
		};
	}, [refreshList]);
	useEffect(
		() =>
			client.onStatus((online) => {
				commandSession.generation += 1;
				commandSession.queue = Promise.resolve();
				listPending.current = false;
				listRevision.current += 1;
				pointer.current = undefined;
				queuedMove.current = undefined;
				queuedWheel.current = [];
				wheelRemainder.current = 0;
				activeStream.current = undefined;
				attachedWindow.current = undefined;
				clearFrame();
				setConnected(online);
				if (online) {
					refreshList();
					setRetry((value) => value + 1);
				}
			}),
		[client, commandSession, clearFrame, refreshList],
	);
	useEffect(
		() =>
			client.onMirrorMessage((message) => {
				if (message.type === "mirror.windows") {
					listRevision.current += 1;
					setWindows(message.windows);
					setListed(true);
					return;
				}
				if (
					message.type !== "mirror.frame" ||
					message.windowId !== activeStream.current ||
					!visibleRef.current ||
					restoringRef.current
				)
					return;
				const geometry = message.geometry ?? projection.current;
				if (
					!geometry ||
					geometry.geometryId !== projection.current?.geometryId ||
					geometry.sourceWidth !== message.width ||
					geometry.sourceHeight !== message.height ||
					!validMirrorCrop(message.width, message.height, geometry.crop)
				)
					return;
				if (pointer.current && pointer.current.geometryId !== geometry.geometryId) cancelPointer();
				const next: Frame = {
					windowId: message.windowId,
					data: message.data,
					width: message.width,
					height: message.height,
					geometry,
				};
				frameRef.current = next;
				drawNextFrame();
			}),
		[client, cancelPointer, drawNextFrame],
	);

	useEffect(() => {
		cancelPointer();
		clearFrame();
		setError("");
		if (!windowId || !panelVisible || !connected || restoring) return;
		let alive = true;
		let attachRequested = false;
		void requestWindow<MirrorProjectionGeometry>({ type: "mirror.project", windowId, visible: true })
			.then((response) => {
				if (!alive) return;
				if (!response.ok || !response.result) throw new Error(response.error ?? "projection failed");
				projection.current = response.result;
				activeStream.current = windowId;
				attachRequested = true;
				attachedWindow.current = windowId;
				return requestWindow({ type: "mirror.attach", windowId }).then((attached) => {
					if (!attached.ok) throw new Error(attached.error ?? "capture failed");
				});
			})
			.catch((failure: unknown) => {
				if (alive) setError(failure instanceof Error ? failure.message : t("mirror.waitingFrame"));
			});
		return () => {
			alive = false;
			cancelPointer();
			if (activeStream.current === windowId) activeStream.current = undefined;
			clearFrame();
			if (restoringRef.current) return;
			if (attachRequested && attachedWindow.current === windowId) {
				attachedWindow.current = undefined;
				void requestWindow({ type: "mirror.detach", windowId }).catch(() => {});
			}
			void requestWindow({ type: "mirror.project", windowId, visible: false }).catch(() => {});
		};
	}, [windowId, panelVisible, connected, restoring, retry, requestWindow, cancelPointer, clearFrame, t]);

	const getPoint = useCallback((x: number, y: number, clamp = false): MirrorPoint | undefined => {
		const frame = displayedFrame.current;
		const canvas = canvasRef.current;
		if (!frame || !canvas || !visibleRef.current || restoringRef.current || frame.windowId !== selectedRef.current)
			return undefined;
		const bounds = canvas.getBoundingClientRect();
		return mirrorContentPoint(
			{ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
			frame.geometry.crop.width,
			frame.geometry.crop.height,
			x,
			y,
			clamp,
		);
	}, []);
	const endPointer = useCallback(
		(event: PointerEvent): void => {
			const gesture = pointer.current;
			if (!gesture || event.pointerId !== gesture.pointerId) return;
			const point = getPoint(event.clientX, event.clientY, gesture.dragging);
			queuedMove.current = undefined;
			pointer.current = undefined;
			if (gesture.axis === "horizontal")
				sendInput({
					type: "mirror.input",
					windowId: gesture.windowId,
					geometryId: gesture.geometryId,
					action: "up",
					...(point ?? gesture.last),
				});
			else if (!gesture.dragging && point)
				sendInput({
					type: "mirror.input",
					windowId: gesture.windowId,
					geometryId: gesture.geometryId,
					action: "click",
					...point,
				});
			try {
				canvasRef.current?.releasePointerCapture(event.pointerId);
			} catch {}
		},
		[getPoint, sendInput],
	);
	useEffect(() => {
		window.addEventListener("pointerup", endPointer);
		window.addEventListener("pointercancel", cancelPointer);
		window.addEventListener("blur", cancelPointer);
		return () => {
			window.removeEventListener("pointerup", endPointer);
			window.removeEventListener("pointercancel", cancelPointer);
			window.removeEventListener("blur", cancelPointer);
		};
	}, [endPointer, cancelPointer]);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const wheel = (event: WheelEvent): void => {
			const point = getPoint(event.clientX, event.clientY);
			const frame = displayedFrame.current;
			if (!point || !frame || pointer.current) return;
			event.preventDefault();
			const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
			const total = Math.max(-1200, Math.min(1200, event.deltaY * factor)) + wheelRemainder.current;
			if (!Number.isFinite(total)) return;
			// Preserve subpixel motion until it reaches a native integer delta.
			const deltaY = Math.trunc(total + Math.sign(total) * 1e-9);
			wheelRemainder.current = Math.abs(total - deltaY) < 1e-9 ? 0 : total - deltaY;
			if (deltaY !== 0) {
				const queue = queuedWheel.current;
				const request: WheelRequest = {
					type: "mirror.input",
					windowId: frame.windowId,
					geometryId: frame.geometry.geometryId,
					action: "wheel",
					...point,
					deltaY,
				};
				// Keep one ordinary reversal in order. Under rapid oscillation fold
				// older undelivered turns into their net distance, preserving the newest turn.
				if (queue.length === 2 && Math.sign(queue[1].deltaY) !== Math.sign(deltaY)) {
					const net = queue[0].deltaY + queue[1].deltaY;
					queue.splice(0, 1);
					if (net === 0) queue.pop();
					else queue[0] = { ...queue[0], deltaY: net };
				}
				const previous = queue.at(-1);
				if (previous && Math.sign(previous.deltaY) === Math.sign(deltaY)) {
					queue[queue.length - 1] = { ...request, deltaY: previous.deltaY + deltaY };
				} else queue.push(request);
				drainWheel();
			}
		};
		canvas.addEventListener("wheel", wheel, { passive: false });
		return () => canvas.removeEventListener("wheel", wheel);
	}, [windowId, getPoint, drainWheel]);
	const restoreWindow = (): void => {
		if (!windowId || restoringRef.current) return;
		restoringRef.current = true;
		setRestoring(true);
		cancelPointer();
		activeStream.current = undefined;
		if (attachedWindow.current === windowId) {
			attachedWindow.current = undefined;
			void requestWindow({ type: "mirror.detach", windowId }).catch(() => {});
		}
		void requestWindow({ type: "mirror.unembed", windowId })
			.then((response) => {
				if (!response.ok) throw new Error(response.error ?? "restore failed");
				store.closeTab(tab.id);
			})
			.catch((failure: unknown) => {
				restoringRef.current = false;
				setRestoring(false);
				setError(failure instanceof Error ? failure.message : t("mirror.waitingFrame"));
			});
	};
	const launchApp = useCallback((): void => {
		setLaunching(true);
		void client
			.request({ type: "mirror.launch" })
			.then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
			.catch(() => {})
			.then(() => {
				if (mountedRef.current) {
					setLaunching(false);
					refreshList();
				}
			});
	}, [client, refreshList]);
	useEffect(() => {
		if (hongguo) {
			autoLaunched.current = true;
			return;
		}
		if (!listed || !supported || autoLaunched.current) return;
		autoLaunched.current = true;
		launchApp();
	}, [listed, supported, hongguo, launchApp]);

	return (
		<div ref={panelRef} className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 bg-owl-panel px-2" style={{ height: 28 }}>
				<span className="text-xs font-semibold text-owl-text">{t("mirror.title")}</span>
				<span className="flex-1" />
				<button
					type="button"
					title={t("mirror.rescan")}
					disabled={restoring}
					className="rounded px-1.5 py-0.5 text-owl-muted hover:text-owl-text"
					onClick={() => {
						refreshList();
						setRetry((value) => value + 1);
					}}
				>
					<IconRefresh size={11} />
				</button>
				<button
					type="button"
					disabled={!hongguo || restoring}
					title={t("mirror.restore")}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-owl-muted hover:text-owl-text"
					onClick={restoreWindow}
				>
					<IconExternal size={10} />
					{t("mirror.restore")}
				</button>
			</div>
			{!hongguo ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<h3 className="text-sm font-semibold text-owl-text">{t("mirror.emptyTitle")}</h3>
					<p className="max-w-[280px] text-xs leading-relaxed text-owl-faint">
						{supported ? t("mirror.emptyDesc") : t("mirror.unsupported")}
					</p>
					<button
						type="button"
						disabled={launching || !supported}
						className="rounded-md bg-rose-500 px-3.5 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
						onClick={launchApp}
					>
						{launching ? t("mirror.launching") : t("mirror.openApp")}
					</button>
				</div>
			) : (
				<div data-mirror-stage className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
					<canvas
						ref={canvasRef}
						data-mirror-content
						className="absolute inset-0 h-full w-full touch-none object-contain"
						aria-label={t("mirror.title")}
						onPointerDown={(event) => {
							if (event.button !== 0 || pointer.current) return;
							const point = getPoint(event.clientX, event.clientY);
							const frame = displayedFrame.current;
							if (!point || !frame) return;
							event.preventDefault();
							// Flush the bounded final wheel segments before the new gesture.
							while (queuedWheel.current.length > 0) {
								const request = takeWheelBatch(queuedWheel.current);
								if (request) sendInput(request);
							}
							pointer.current = {
								pointerId: event.pointerId,
								windowId: frame.windowId,
								geometryId: frame.geometry.geometryId,
								start: point,
								last: point,
								x: event.clientX,
								y: event.clientY,
								dragging: false,
								pageCommitted: false,
							};
							try {
								event.currentTarget.setPointerCapture(event.pointerId);
							} catch {}
						}}
						onPointerMove={(event) => {
							const gesture = pointer.current;
							if (!gesture || gesture.pointerId !== event.pointerId) return;
							if (event.pointerType === "mouse" && event.buttons === 0) {
								cancelPointer();
								return;
							}
							const point = getPoint(event.clientX, event.clientY, true);
							if (!point) {
								cancelPointer();
								return;
							}
							gesture.last = point;
							const dx = event.clientX - gesture.x;
							const dy = event.clientY - gesture.y;
							if (!gesture.dragging && Math.hypot(dx, dy) < 6) return;
							if (!gesture.dragging) {
								gesture.dragging = true;
								gesture.axis = Math.abs(dy) >= Math.abs(dx) ? "vertical" : "horizontal";
								if (gesture.axis === "horizontal")
									sendInput({
										type: "mirror.input",
										windowId: gesture.windowId,
										geometryId: gesture.geometryId,
										action: "down",
										...gesture.start,
									});
							}
							if (gesture.axis === "vertical") {
								if (
									!gesture.pageCommitted &&
									Math.abs(point.v - gesture.start.v) >= 0.09 &&
									Math.abs(dy) >= 24
								) {
									gesture.pageCommitted = true;
									sendInput({
										type: "mirror.input",
										windowId: gesture.windowId,
										geometryId: gesture.geometryId,
										action: "wheel",
										...gesture.start,
										deltaY: dy < 0 ? 120 : -120,
									});
								}
								return;
							}
							queuedMove.current = {
								type: "mirror.input",
								windowId: gesture.windowId,
								geometryId: gesture.geometryId,
								action: "move",
								...point,
							};
							drainMove();
						}}
						onLostPointerCapture={cancelPointer}
					/>
					{!hasFrame && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center">
							<span className="text-[11px] text-owl-faint">{error || t("mirror.waitingFrame")}</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
