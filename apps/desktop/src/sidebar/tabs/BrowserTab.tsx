/**
 * 浏览器 tab —— 内嵌真浏览器（owl IAB）。
 *
 * 旧版是 iframe（被 X-Frame-Options 卡死，且 agent 看不见）。现在是桥进程
 * 托管的私有无头浏览器（browser-hub.ts）的 screencast 视图：帧流显示页面，
 * 鼠标/键盘经 iab.input 转发回页面，agent 的 browser_* 工具驱动的是同一个
 * 页面 —— 用户看得见 agent 的每一步，agent 也能被手动引导。URL 记在
 * tab.path 上随分屏树持久化，重开应用还原。
 *
 * 帧走 canvas 直绘（ref + rAF），刻意不进 React state：screencast 每秒多帧，
 * 逐帧 setState 会把地址栏/横幅这类受控输入正在编辑的内容冲掉（受控组件
 * 重渲染会拿 state 覆写 DOM value）。state 只留低频量：绑定页元信息、帧的
 * 尺寸（视口切换才变）、舞台尺寸、文件选择横幅。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { IabInputPayload, IabPageInfo } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { bindIabPage, encodeIabPath, parseIabPath, unbindIabPage } from "../iab-bound.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";
import "./browser.css";

/** 起始页的快捷目标（开发预览是浏览器 tab 的主场景）。 */
const QUICK_URLS = [
	"http://localhost:5188",
	"http://localhost:5173",
	"http://127.0.0.1:18970",
	"http://127.0.0.1:3000",
];

/** 设备的 CSS 视口尺寸；预设只调整布局尺寸，不改变 UA 或触控模式。 */
const VIEWPORT_PRESETS = [
	{ label: "4K", width: 3840, height: 2160 },
	{ label: "Laptop L", width: 1440, height: 900 },
	{ label: "笔记本电脑", width: 1280, height: 860 },
	{ label: "Surface Pro 7", width: 912, height: 1368 },
	{ label: "iPad Air", width: 820, height: 1180 },
	{ label: "iPad Mini", width: 768, height: 1024 },
	{ label: "Surface Duo", width: 540, height: 720 },
	{ label: "iPhone 15 Pro Max", width: 430, height: 932 },
	{ label: "Pixel 8", width: 412, height: 915 },
	{ label: "iPhone 15 Pro", width: 393, height: 852 },
	{ label: "Samsung Galaxy S24 Ultra", width: 412, height: 915 },
	{ label: "iPhone SE", width: 375, height: 667 },
];

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

// -- 收藏（书签）：localStorage 全局持久化，跨工作区/跨会话共享 -------------

type Bookmark = { url: string; title: string };
const BOOKMARKS_KEY = "owl.iab.bookmarks";
const BOOKMARKS_LIMIT = 50;

function readBookmarks(): Bookmark[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? "[]") as Bookmark[];
		return Array.isArray(parsed) ? parsed.filter((bookmark) => bookmark && typeof bookmark.url === "string") : [];
	} catch {
		return [];
	}
}

function writeBookmarks(list: Bookmark[]): void {
	localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list.slice(0, BOOKMARKS_LIMIT)));
}

/** 归一化输入：补协议、localhost 容错，空串返回空。 */
function normalizeUrl(raw: string): string {
	const text = raw.trim();
	if (!text) return "";
	if (/^https?:\/\//i.test(text)) return text;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?/i.test(text)) return `http://${text}`;
	return `https://${text}`;
}

interface Frame {
	data: string;
	width: number;
	height: number;
}

/** 事件坐标 → 页面视口坐标的换算上下文（帧居中显示，四周是信箱留黑）。 */
interface StageGeometry {
	scale: number;
	frame: Frame;
	rect: DOMRect;
}

export function BrowserTab({ api, tab, store, client }: TabComponentProps): React.JSX.Element {
	const [page, setPage] = useState<IabPageInfo | undefined>(undefined);
	const [draft, setDraft] = useState(() => parseIabPath(tab.path).url ?? "");
	const [frameSize, setFrameSize] = useState<{ width: number; height: number } | undefined>(undefined);
	const [fileChooser, setFileChooser] = useState<{ multiple: boolean } | undefined>(undefined);
	const [filePathDraft, setFilePathDraft] = useState("");
	const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
	const [responsive, setResponsive] = useState(true);
	const [viewportPreset, setViewportPreset] = useState("responsive");
	const [viewportDraft, setViewportDraft] = useState({ width: "1280", height: "860" });
	const [viewportPending, setViewportPending] = useState(false);
	const [viewportError, setViewportError] = useState("");
	const [zoom, setZoom] = useState<"auto" | number>("auto");
	const stageRef = useRef<HTMLDivElement>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const lastMoveSent = useRef(0);
	// ref 镜像：iab 消息回调与输入转发读最新值，免 stale closure
	const pageRef = useRef<IabPageInfo | undefined>(undefined);
	pageRef.current = page;
	const frameRef = useRef<Frame | undefined>(undefined);
	const drawScheduled = useRef(false);

	const applyPage = useCallback(
		(next: IabPageInfo): void => {
			const current = pageRef.current;
			if (current?.pageId !== next.pageId || current.url !== next.url) {
				// 绑定/换页/URL 被带走：持久化跟着走（pageId 优先，URL 兜底，重开应用还原）
				store.setTabPath(tab.id, encodeIabPath(next.pageId, next.url));
				setDraft(next.url);
			}
			pageRef.current = next;
			setPage(next);
		},
		[store, tab.id],
	);

	/** 把 frameRef 里的最新帧画到 canvas（setTimeout 合并同帧多次触发）。
	 *  刻意不用 requestAnimationFrame：内嵌在桌面壳里的页面 rAF 可能被永久饿死
	 *  （实测 ZCode IAB 中 rAF 不触发而 visibilityState 仍为 visible），会黑屏。 */
	const drawFrame = useCallback((): void => {
		drawScheduled.current = false;
		const canvas = canvasRef.current;
		const current = frameRef.current;
		if (!canvas || !current) return;
		if (canvas.width !== current.width || canvas.height !== current.height) {
			canvas.width = current.width;
			canvas.height = current.height;
		}
		const image = new Image();
		image.onload = () => {
			canvas.getContext("2d")?.drawImage(image, 0, 0);
		};
		image.src = `data:image/png;base64,${current.data}`;
	}, []);

	const scheduleDraw = useCallback((): void => {
		if (drawScheduled.current) return;
		drawScheduled.current = true;
		setTimeout(drawFrame, 0);
	}, [drawFrame]);

	/** 从实际画面取几何信息，固定缩放后滚动舞台仍能正确换算点击坐标。 */
	const stageGeometry = (): StageGeometry | undefined => {
		const element = surfaceRef.current;
		const current = frameRef.current;
		if (!element || !current || current.width === 0 || element.clientWidth === 0) return undefined;
		const rect = element.getBoundingClientRect();
		return {
			scale: rect.width / current.width,
			frame: current,
			rect,
		};
	};

	const toPageCoords = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
		const geometry = stageGeometry();
		if (!geometry) return undefined;
		if (
			clientX < geometry.rect.left ||
			clientX >= geometry.rect.right ||
			clientY < geometry.rect.top ||
			clientY >= geometry.rect.bottom
		)
			return undefined;
		const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), Math.max(max - 1, 0));
		return {
			x: clamp((clientX - geometry.rect.left) / geometry.scale, geometry.frame.width),
			y: clamp((clientY - geometry.rect.top) / geometry.scale, geometry.frame.height),
		};
	};

	const sendInput = (input: IabInputPayload): void => {
		const current = pageRef.current;
		if (!current) return;
		void client.request({ type: "iab.input", pageId: current.pageId, input }).catch(() => {});
	};

	// 挂载：按持久化路径绑定页面（pageId 优先，失效回落 URL）。桥还没连上时
	// 请求会被立即拒绝：挂 onStatus 等下次连上后重试，不能丢。
	useEffect(() => {
		const parsed = parseIabPath(tab.path);
		const initialPageId = parsed.pageId;
		const initialUrl = parsed.url ? normalizeUrl(parsed.url) : undefined;
		if (!initialPageId && !initialUrl) return;
		let cancelled = false;
		let retryOff: (() => void) | undefined;
		let fellBack = false;
		const attempt = (): void => {
			const request =
				initialPageId && !fellBack
					? { type: "iab.open" as const, pageId: initialPageId }
					: { type: "iab.open" as const, url: initialUrl ?? "about:blank" };
			void client
				.request<{ page: IabPageInfo }>(request)
				.then((response) => {
					if (cancelled) return;
					if (response.ok && response.result) {
						applyPage(response.result.page);
						return;
					}
					// pageId 已失效（桥重启过）：回落按 URL 绑定
					if (initialPageId && !fellBack && initialUrl) {
						fellBack = true;
						attempt();
					}
				})
				.catch(() => {
					if (cancelled) return;
					retryOff?.();
					retryOff = client.onStatus((up) => {
						if (!up || cancelled) return;
						retryOff?.();
						retryOff = undefined;
						attempt();
					});
				});
		};
		attempt();
		return () => {
			cancelled = true;
			retryOff?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 页面就位：登记 + 订阅帧流；卸载/换页时退订。绑定 3 秒后仍无一帧
	// （attach 时首帧可能丢）就重发一次 attach，让桥重新抓全量帧。
	useEffect(() => {
		if (!page) return;
		bindIabPage(page.pageId, tab.id);
		void client.request({ type: "iab.attach", pageId: page.pageId }).catch(() => {});
		const boundPageId = page.pageId;
		const boundTabId = tab.id;
		const retryTimer = setTimeout(() => {
			if (!frameRef.current) {
				void client.request({ type: "iab.attach", pageId: boundPageId }).catch(() => {});
			}
		}, 3_000);
		return () => {
			clearTimeout(retryTimer);
			unbindIabPage(boundPageId, boundTabId);
			void client.request({ type: "iab.detach", pageId: boundPageId }).catch(() => {});
		};
	}, [page?.pageId]); // eslint-disable-line react-hooks/exhaustive-deps

	// IAB 消息：帧流按 pageId 直绘 canvas；页面清单跟踪标题/URL/关闭；filechooser 弹横幅
	useEffect(() => {
		return client.onIabMessage((message) => {
			if (message.type === "iab.frame") {
				if (message.pageId === pageRef.current?.pageId) {
					const next = { data: message.data, width: message.width, height: message.height };
					frameRef.current = next;
					// 尺寸变化（视口切换）才进 state；普通帧只重绘 canvas
					setFrameSize((prev) =>
						prev && prev.width === next.width && prev.height === next.height
							? prev
							: { width: next.width, height: next.height },
					);
					scheduleDraw();
				}
				return;
			}
			if (message.type === "iab.filechooser") {
				if (message.pageId === pageRef.current?.pageId) setFileChooser({ multiple: message.multiple });
				return;
			}
			if (message.type === "iab.pages" && pageRef.current) {
				const current = pageRef.current;
				const mine = message.pages.find((candidate) => candidate.pageId === current.pageId);
				if (mine) {
					if (
						mine.url !== current.url ||
						mine.title !== current.title ||
						mine.active !== current.active ||
						mine.viewport.width !== current.viewport.width ||
						mine.viewport.height !== current.viewport.height
					)
						applyPage(mine);
				} else {
					// 绑定的页面被关掉（agent browser_tabs close / 桥重启）：回起始页
					pageRef.current = undefined;
					frameRef.current = undefined;
					setPage(undefined);
					setFrameSize(undefined);
					setFileChooser(undefined);
					store.setTabPath(tab.id, undefined);
				}
			}
		});
	}, [client, applyPage, scheduleDraw, store, tab.id]);

	// 页面元信息才是已生效的尺寸；帧流和标题更新不能覆盖用户正在编辑的尺寸。
	useEffect(() => {
		if (!page) return;
		const { width, height } = page.viewport;
		setViewportDraft({ width: String(width), height: String(height) });
		setViewportPreset((selected) => {
			const preset = VIEWPORT_PRESETS.find((candidate) => candidate.label === selected);
			return preset &&
				((preset.width === width && preset.height === height) || (preset.height === width && preset.width === height))
				? selected
				: "responsive";
		});
	}, [page?.pageId, page?.viewport.width, page?.viewport.height]);

	// canvas 挂载/舞台尺寸就位时补画缓冲帧：后台绑定期间收到的帧当时画不进
	// （canvas 未挂载），激活切回来时靠这次补绘显示，否则白屏
	useEffect(() => {
		if (frameSize && stageSize.width > 0) scheduleDraw();
	}, [frameSize, stageSize.width, scheduleDraw]);

	// 舞台尺寸 → 适应窗口缩放。立即量一次 + ResizeObserver + 1s 兜底轮询：
	// 嵌在桌面壳里的页面 ResizeObserver/rAF 可能被永久饿死（实测连初始回调
	// 都不触发），不能只依赖它们；尺寸没变时 measure 返回原对象，不会重渲染。
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
	}, [page?.pageId, frameSize !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps

	// wheel 用原生非 passive 监听才能 preventDefault（React 的 onWheel 是 passive）
	useEffect(() => {
		const element = stageRef.current;
		if (!element || !page) return;
		const onWheel = (event: WheelEvent): void => {
			const coords = toPageCoords(event.clientX, event.clientY);
			if (!coords) return;
			event.preventDefault();
			sendInput({ kind: "wheel", x: coords.x, y: coords.y, deltaX: event.deltaX, deltaY: event.deltaY });
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [page?.pageId]); // eslint-disable-line react-hooks/exhaustive-deps

	const navigate = (raw: string): void => {
		const next = normalizeUrl(raw);
		setDraft(next);
		if (!next) return;
		const current = pageRef.current;
		void client
			.request<{ page: IabPageInfo }>(
				current ? { type: "iab.open", pageId: current.pageId, url: next } : { type: "iab.open", url: next },
			)
			.then((response) => {
				if (response.ok && response.result) {
					applyPage(response.result.page);
				}
			})
			.catch(() => {});
	};

	const runNav = (action: "back" | "forward" | "reload"): void => {
		const current = pageRef.current;
		if (!current) return;
		void client.request({ type: "iab.nav", pageId: current.pageId, action }).catch(() => {});
	};

	const applyViewport = (width: number, height: number, preset = "responsive"): void => {
		const current = pageRef.current;
		if (!current || viewportPending) return;
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
			setViewportDraft({ width: String(current.viewport.width), height: String(current.viewport.height) });
			return;
		}
		const next = {
			width: Math.min(Math.max(Math.round(width), 320), 3840),
			height: Math.min(Math.max(Math.round(height), 320), 2160),
		};
		setViewportError("");
		setViewportDraft({ width: String(next.width), height: String(next.height) });
		if (next.width === current.viewport.width && next.height === current.viewport.height) {
			setViewportPreset(preset);
			return;
		}
		setViewportPending(true);
		void client
			.request({ type: "iab.viewport", pageId: current.pageId, ...next })
			.then((response) => {
				if (pageRef.current?.pageId !== current.pageId) return;
				if (!response.ok) throw new Error(response.error ?? "无法调整页面尺寸");
				setViewportPreset(preset);
			})
			.catch((error: unknown) => {
				if (pageRef.current?.pageId !== current.pageId) return;
				const viewport = pageRef.current.viewport;
				setViewportDraft({ width: String(viewport.width), height: String(viewport.height) });
				setViewportError(error instanceof Error ? error.message : "无法调整页面尺寸");
			})
			.finally(() => setViewportPending(false));
	};

	const submitViewport = (): void => {
		const width = Number(viewportDraft.width);
		const height = Number(viewportDraft.height);
		const current = pageRef.current;
		if (current && width === current.viewport.width && height === current.viewport.height) {
			setViewportDraft({ width: String(width), height: String(height) });
			return;
		}
		applyViewport(width, height);
	};

	const openExternal = (): void => {
		if (pageRef.current?.url) void api.openExternal("url", pageRef.current.url).catch(() => {});
	};

	// 文件选择框应答：绝对路径 | 分隔（真正的系统对话框在无头浏览器里弹不出）
	const submitFileChooser = (): void => {
		const current = pageRef.current;
		if (!current) return;
		const paths = filePathDraft
			.split("|")
			.map((path) => path.trim())
			.filter((path) => path !== "");
		if (paths.length === 0) return;
		void client
			.request({ type: "iab.fileResponse", pageId: current.pageId, paths })
			.then((response) => {
				if (response.ok) {
					setFileChooser(undefined);
					setFilePathDraft("");
				}
			})
			.catch(() => {});
	};

	// -- 收藏与独立窗口 --------------------------------------------------------

	const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => readBookmarks());
	const currentBookmarked = page?.url ? bookmarks.some((bookmark) => bookmark.url === page.url) : false;
	const toggleBookmark = (): void => {
		if (!page?.url) return;
		const list = readBookmarks();
		const index = list.findIndex((bookmark) => bookmark.url === page.url);
		if (index >= 0) list.splice(index, 1);
		else list.unshift({ url: page.url, title: page.title || page.url });
		writeBookmarks(list);
		setBookmarks(list);
	};
	const removeBookmark = (url: string): void => {
		const list = readBookmarks().filter((bookmark) => bookmark.url !== url);
		writeBookmarks(list);
		setBookmarks(list);
	};

	// 独立窗口打开：桌面壳里弹新窗口，普通浏览器里是新标签页；被壳拦截时退回系统浏览器
	const popout = (): void => {
		const url = pageRef.current?.url;
		if (!url) return;
		const win = window.open(url, "_blank", "noopener");
		if (!win) void api.openExternal("url", url).catch(() => {});
	};

	// 键盘：画布聚焦时全部转发给页面（含 Ctrl+T 等组合键——那是页面的快捷键，
	// 不是工作台的；App 的全局快捷键靠 data-iab-capture 让路）
	const onKeyDown = (event: React.KeyboardEvent): void => {
		if (!pageRef.current) return;
		event.preventDefault();
		event.stopPropagation();
		const modifiers = [
			...(event.ctrlKey ? ["Control"] : []),
			...(event.shiftKey ? ["Shift"] : []),
			...(event.altKey ? ["Alt"] : []),
			...(event.metaKey ? ["Meta"] : []),
		];
		sendInput({
			kind: "key",
			key: event.key,
			down: true,
			...(event.key.length === 1 ? { text: event.key } : {}),
			...(modifiers.length > 0 ? { modifiers } : {}),
		});
		// 修饰键的抬起要跟（普通键 press 已在 down 侧完成，up 无需转发）
		if (MODIFIER_KEYS.has(event.key)) sendInput({ kind: "key", key: event.key, down: false });
	};

	const mouseButtonOf = (button: number): "left" | "right" | "middle" =>
		button === 2 ? "right" : button === 1 ? "middle" : "left";

	const toolbarButton =
		"flex h-6 w-6 items-center justify-center rounded text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
	const scale = (() => {
		if (!frameSize || stageSize.width === 0) return undefined;
		return zoom === "auto" ? Math.min(stageSize.width / frameSize.width, stageSize.height / frameSize.height) : zoom;
	})();

	return (
		<div className="owl-browser flex h-full flex-col overflow-hidden bg-owl-bg" data-iab-capture>
			{/* 导航工具条；响应式控制单独一行，侧栏收窄时自然换行。 */}
			<div className="flex shrink-0 select-none items-center gap-1.5 border-b border-owl-border/40 px-2 py-1.5">
				<button type="button" title="后退" className={toolbarButton} disabled={!page} onClick={() => runNav("back")}>
					<svg
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						className="h-3 w-3"
					>
						<path d="M10 3 5 8l5 5" />
					</svg>
				</button>
				<button type="button" title="前进" className={toolbarButton} disabled={!page} onClick={() => runNav("forward")}>
					<svg
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						className="h-3 w-3"
					>
						<path d="m6 3 5 5-5 5" />
					</svg>
				</button>
				<button type="button" title="刷新" className={toolbarButton} disabled={!page} onClick={() => runNav("reload")}>
					<IconRefresh size={11} />
				</button>
				<button
					type="button"
					title="响应式预览"
					aria-label="响应式预览"
					aria-pressed={responsive}
					className={`owl-browser-responsive-toggle ${toolbarButton}`}
					disabled={!page}
					onClick={() => {
						setResponsive((enabled) => !enabled);
						setZoom("auto");
					}}
				>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
						<rect x="1.5" y="2" width="10" height="8" rx="1" />
						<path d="M4 13h5M6.5 10v3" />
						<rect x="10" y="6" width="4.5" height="7.5" rx=".8" fill="var(--color-owl-panel)" />
					</svg>
					<span>响应式</span>
				</button>
				<input
					aria-label="浏览器地址"
					value={draft}
					placeholder="输入 URL，回车打开（agent 也能看到这个页面）"
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							navigate(draft);
							(e.target as HTMLInputElement).blur();
						}
					}}
					className="h-6.5 min-w-0 flex-1 rounded-md border border-owl-border/50 bg-owl-panel px-2.5 text-xs text-owl-text outline-none placeholder:text-owl-faint focus:border-owl-accent/60"
				/>
				<button type="button" title="在独立窗口打开" className={toolbarButton} disabled={!page?.url} onClick={popout}>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
						<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
						<rect x="8" y="7.5" width="5" height="4" rx="0.5" fill="currentColor" stroke="none" />
					</svg>
				</button>
				<button
					type="button"
					title={currentBookmarked ? "取消收藏" : "收藏此页"}
					className={`${toolbarButton} ${currentBookmarked ? "text-owl-accent hover:text-owl-accent" : ""}`}
					disabled={!page?.url}
					onClick={toggleBookmark}
				>
					<svg
						viewBox="0 0 16 16"
						fill={currentBookmarked ? "currentColor" : "none"}
						stroke="currentColor"
						strokeWidth="1.3"
						className="h-3 w-3"
					>
						<path d="M4 2.5h8a.8.8 0 0 1 .8.8v10.2L8 10.2 3.2 13.5V3.3a.8.8 0 0 1 .8-.8z" />
					</svg>
				</button>
				<button
					type="button"
					title="在系统浏览器打开"
					className={toolbarButton}
					disabled={!page?.url}
					onClick={openExternal}
				>
					<IconExternal size={11} />
				</button>
			</div>

			{page && responsive && (
				<div className="owl-browser-responsive-toolbar" aria-label="响应式工具栏" aria-busy={viewportPending}>
					<label className="owl-browser-device">
						<span>尺寸:</span>
						<select
							aria-label="预览设备"
							value={viewportPreset}
							disabled={viewportPending}
							onChange={(event) => {
								const selected = event.target.value;
								const preset = VIEWPORT_PRESETS.find((candidate) => candidate.label === selected);
								if (preset) applyViewport(preset.width, preset.height, preset.label);
								else setViewportPreset("responsive");
							}}
						>
							<option value="responsive">响应式</option>
							{VIEWPORT_PRESETS.map((preset) => (
								<option key={preset.label} value={preset.label}>
									{preset.label}
								</option>
							))}
						</select>
					</label>
					<div className="owl-browser-dimensions">
						{(["width", "height"] as const).map((dimension, index) => (
							<label key={dimension}>
								{index === 1 && <span aria-hidden="true">×</span>}
								<input
									type="number"
									aria-label={dimension === "width" ? "视口宽度" : "视口高度"}
									title={dimension === "width" ? "宽度（320–3840 CSS px）" : "高度（320–2160 CSS px）"}
									min={320}
									max={dimension === "width" ? 3840 : 2160}
									step={1}
									value={viewportDraft[dimension]}
									disabled={viewportPending}
									onChange={(event) => setViewportDraft((current) => ({ ...current, [dimension]: event.target.value }))}
									onBlur={submitViewport}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											event.currentTarget.blur();
										}
									}}
								/>
							</label>
						))}
					</div>
					<button
						type="button"
						className={toolbarButton}
						aria-label="旋转视口"
						title={page.viewport.width > 2160 ? "当前宽度超出可用高度（2160px）" : "旋转视口"}
						disabled={viewportPending || page.viewport.width > 2160}
						onClick={() => applyViewport(page.viewport.height, page.viewport.width, viewportPreset)}
					>
						<svg
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
							className="h-3.5 w-3.5"
							aria-hidden="true"
						>
							<path d="M2.5 6A5.5 5.5 0 0 1 12 3.5M12 1v3h-3" />
							<rect x="4" y="6.5" width="9" height="6" rx="1" />
						</svg>
					</button>
					<select
						aria-label="预览缩放"
						title="仅缩放预览画面"
						className="owl-browser-zoom"
						value={String(zoom)}
						onChange={(event) => setZoom(event.target.value === "auto" ? "auto" : Number(event.target.value))}
					>
						<option value="auto">适应{scale ? ` ${Math.round(scale * 100)}%` : ""}</option>
						{ZOOM_LEVELS.map((level) => (
							<option key={level} value={String(level)}>
								{Math.round(level * 100)}%
							</option>
						))}
					</select>
					<button
						type="button"
						aria-label="关闭响应式预览"
						title="关闭响应式工具栏"
						className={`${toolbarButton} owl-browser-responsive-close`}
						onClick={() => {
							setResponsive(false);
							setZoom("auto");
						}}
					>
						<svg
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
							className="h-3 w-3"
							aria-hidden="true"
						>
							<path d="m4 4 8 8m0-8-8 8" />
						</svg>
					</button>
					{viewportError && (
						<span className="owl-browser-viewport-error" role="alert">
							{viewportError}
						</span>
					)}
				</div>
			)}

			{/* 内容：起始页 或 screencast 舞台 */}
			{!page ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
					<p className="text-sm text-owl-muted">内嵌浏览器</p>
					<p className="max-w-sm text-xs leading-relaxed text-owl-faint">
						桥进程托管的独立浏览器：不受 X-Frame-Options 限制，随便开什么站； Agent 的 browser_*
						工具驱动的是同一个页面，它的每一步操作你都看得到。
					</p>
					<div className="mt-1 flex flex-wrap justify-center gap-2">
						{QUICK_URLS.map((candidate) => (
							<button
								key={candidate}
								type="button"
								className="rounded-lg border border-owl-border/60 bg-owl-panel px-3 py-1.5 font-mono text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
								onClick={() => navigate(candidate)}
							>
								{candidate}
							</button>
						))}
					</div>
					{bookmarks.length > 0 && (
						<div className="mt-3 w-full max-w-sm">
							<p className="mb-1.5 text-[11px] font-medium text-owl-faint">收藏</p>
							<div className="space-y-1">
								{bookmarks.map((bookmark) => (
									<div
										key={bookmark.url}
										className="group flex items-center gap-1 rounded-lg border border-owl-border/60 bg-owl-panel px-2.5 py-1.5"
									>
										<button
											type="button"
											title={bookmark.url}
											className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-owl-muted transition-colors hover:text-owl-text"
											onClick={() => navigate(bookmark.url)}
										>
											{bookmark.title || bookmark.url}
										</button>
										<button
											type="button"
											title="删除收藏"
											className="shrink-0 text-owl-faint opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
											onClick={() => removeBookmark(bookmark.url)}
										>
											✕
										</button>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div ref={stageRef} className="owl-browser-stage relative min-h-0 flex-1 overflow-auto bg-black/40">
					{frameSize && scale ? (
						<div
							style={{
								position: "relative",
								width: Math.max(stageSize.width, frameSize.width * scale),
								height: Math.max(stageSize.height, frameSize.height * scale),
							}}
						>
							<div
								ref={surfaceRef}
								tabIndex={0}
								className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-default outline-none"
								style={{ width: frameSize.width * scale, height: frameSize.height * scale }}
								onKeyDown={onKeyDown}
								onContextMenu={(e) => e.preventDefault()}
								onMouseDown={(e) => {
									(e.currentTarget as HTMLDivElement).focus();
									const coords = toPageCoords(e.clientX, e.clientY);
									if (!coords) return;
									sendInput({
										kind: "mouse",
										action: "down",
										x: coords.x,
										y: coords.y,
										button: mouseButtonOf(e.button),
									});
								}}
								onMouseUp={(e) => {
									const coords = toPageCoords(e.clientX, e.clientY);
									if (!coords) return;
									sendInput({ kind: "mouse", action: "up", x: coords.x, y: coords.y, button: mouseButtonOf(e.button) });
								}}
								onMouseMove={(e) => {
									const now = Date.now();
									if (now - lastMoveSent.current < 40) return;
									lastMoveSent.current = now;
									const coords = toPageCoords(e.clientX, e.clientY);
									if (!coords) return;
									sendInput({ kind: "mouse", action: "move", x: coords.x, y: coords.y });
								}}
							>
								<canvas ref={canvasRef} className="h-full w-full select-none bg-white" />
							</div>
						</div>
					) : (
						<div className="flex h-full items-center justify-center">
							<span className="animate-pulse text-xs text-owl-faint">正在连接页面…</span>
						</div>
					)}
					{fileChooser && (
						<div className="absolute inset-x-2 top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-owl-accent/50 bg-owl-panel/95 px-3 py-2 shadow-lg">
							<span className="shrink-0 text-xs text-owl-text">
								页面请求选择文件（允许多选：{fileChooser.multiple ? "是" : "否"}）
							</span>
							<input
								value={filePathDraft}
								onChange={(e) => setFilePathDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										submitFileChooser();
									}
								}}
								placeholder="本机文件绝对路径，多个用 | 分隔"
								spellCheck={false}
								className="h-6 min-w-32 flex-1 rounded border border-owl-border/50 bg-owl-bg px-2 font-mono text-[11px] text-owl-text outline-none focus:border-owl-accent/60"
							/>
							<button
								type="button"
								onClick={submitFileChooser}
								className="shrink-0 rounded bg-owl-accent px-2 py-1 text-[11px] text-white transition-opacity hover:opacity-90"
							>
								提交
							</button>
							<button
								type="button"
								onClick={() => setFileChooser(undefined)}
								className="shrink-0 text-xs text-owl-faint transition-colors hover:text-owl-text"
							>
								忽略
							</button>
						</div>
					)}
					{scale !== undefined && (
						<span className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-owl-panel/90 px-1.5 py-0.5 font-mono text-[10px] text-owl-faint">
							{page.viewport.width}×{page.viewport.height} · {Math.round(scale * 100)}%
						</span>
					)}
				</div>
			)}
		</div>
	);
}
