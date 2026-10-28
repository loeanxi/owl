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
 *
 * 帧的解码在合成器线程做（createImageBitmap），画布按显示尺寸开：拖窗口
 * 边框时主线程要处理整页重排，帧的解码与缩放都挤在主线程上，面板就会一直抖。
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { IabInputPayload, IabPageInfo } from "../../bridge/protocol.ts";
import { toExternalUrl } from "../../external-url.ts";
import { type TextKey, t, useT } from "../../i18n/index.ts";
import { bindIabPage, encodeIabPath, parseIabPath, unbindIabPage } from "../iab-bound.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";
import { BrowserSessionContext, type TabComponentProps } from "../registry.ts";
import { useSidebarState } from "../store.ts";
import "./browser.css";

/** 起始页的快捷目标（开发预览是浏览器 tab 的主场景）。 */
const QUICK_URLS = [
	"http://localhost:5188",
	"http://localhost:5173",
	"http://127.0.0.1:18970",
	"http://127.0.0.1:3000",
];

/** 设备模拟档案：User-Agent / 移动端布局 / 触控。 */
interface DeviceProfile {
	mobile?: boolean;
	touch?: boolean;
	userAgent?: string;
}

const IOS_PHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_TABLET_UA =
	"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

/** 设备的 CSS 视口尺寸；预设只改尺寸与设备档案（UA / 触控），不改真实浏览器。 */
const VIEWPORT_PRESETS: { label: string; labelKey?: TextKey; width: number; height: number; device?: DeviceProfile }[] =
	[
		{ label: "4K", width: 3840, height: 2160 },
		{ label: "Laptop L", width: 1440, height: 900 },
		{ label: "笔记本电脑", labelKey: "browser.presetLaptop", width: 1280, height: 860 },
		{
			label: "Surface Pro 7",
			width: 912,
			height: 1368,
			device: { mobile: true, touch: true, userAgent: IOS_TABLET_UA },
		},
		{ label: "iPad Air", width: 820, height: 1180, device: { mobile: true, touch: true, userAgent: IOS_TABLET_UA } },
		{ label: "iPad Mini", width: 768, height: 1024, device: { mobile: true, touch: true, userAgent: IOS_TABLET_UA } },
		{
			label: "Surface Duo",
			width: 540,
			height: 720,
			device: { mobile: true, touch: true, userAgent: IOS_TABLET_UA },
		},
		{
			label: "iPhone 15 Pro Max",
			width: 430,
			height: 932,
			device: { mobile: true, touch: true, userAgent: IOS_PHONE_UA },
		},
		{ label: "Pixel 8", width: 412, height: 915, device: { mobile: true, touch: true, userAgent: ANDROID_PHONE_UA } },
		{
			label: "iPhone 15 Pro",
			width: 393,
			height: 852,
			device: { mobile: true, touch: true, userAgent: IOS_PHONE_UA },
		},
		{
			label: "Samsung Galaxy S24 Ultra",
			width: 412,
			height: 915,
			device: { mobile: true, touch: true, userAgent: ANDROID_PHONE_UA },
		},
		{ label: "iPhone SE", width: 375, height: 667, device: { mobile: true, touch: true, userAgent: IOS_PHONE_UA } },
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
	// 必须先于 scheme 判断：`localhost:5188` 的 host:port 会被通用 scheme 正则当成 `localhost` 协议原样放行
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?/i.test(text)) return `http://${text}`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
	return `https://${text}`;
}

interface Frame {
	data: string;
	/** 帧的编码：帧流默认 JPEG，格式由后端告知，前端不猜。 */
	format: "jpeg" | "png";
	width: number;
	height: number;
}

/** 事件坐标 → 页面视口坐标的换算上下文（帧居中显示，四周是信箱留黑）。 */
interface StageGeometry {
	scale: number;
	frame: Frame;
	rect: DOMRect;
}

/** 拿 2D 上下文：没有 canvas 实现的环境里 getContext 会抛。 */
function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
	try {
		return canvas.getContext("2d");
	} catch {
		return null;
	}
}

/**
 * 解码一帧图像。
 *
 * 优先 createImageBitmap：解码在合成器线程做，主线程不阻塞 —— 拖窗口边框时
 * 主线程本来就要处理整页重排，JPEG 解码挤进来，面板画面就掉帧、看着在抖。
 * 环境不支持时退回 Image（解码在主线程，但每帧仍只解一次）。
 */
async function decodeFrameImage(frame: Frame): Promise<CanvasImageSource | undefined> {
	if (typeof createImageBitmap === "function" && typeof atob === "function") {
		try {
			const binary = atob(frame.data);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			return await createImageBitmap(new Blob([bytes], { type: `image/${frame.format}` }));
		} catch {
			/* 落到 Image 路径 */
		}
	}
	try {
		return await new Promise<CanvasImageSource | undefined>((resolve) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => resolve(undefined);
			image.src = `data:image/${frame.format};base64,${frame.data}`;
		});
	} catch {
		return undefined;
	}
}

export function BrowserTab({ api, tab, store, client }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const sessionId = useContext(BrowserSessionContext);
	const sidebarState = useSidebarState(store);
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
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
	/** agent 能否操作本页：关掉后本会话的浏览器动作一律 fail closed。 */
	const [agentControl, setAgentControl] = useState(true);
	/** 本会话的页面清单：agent 会开多个页，侧栏要看得见、能切。 */
	const [pages, setPages] = useState<IabPageInfo[]>([]);
	/** agent 正在操作的元素（页面 CSS 坐标）：侧栏像素镜像里靠它高亮。 */
	const [highlight, setHighlight] = useState<{ x: number; y: number; width: number; height: number } | undefined>(
		undefined,
	);
	const stageRef = useRef<HTMLDivElement>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const lastMoveSent = useRef(0);
	// ref 镜像：iab 消息回调与输入转发读最新值，免 stale closure
	const pageRef = useRef<IabPageInfo | undefined>(undefined);
	pageRef.current = page;
	const frameRef = useRef<Frame | undefined>(undefined);
	const drawScheduled = useRef(false);
	/** 已解码的当前帧：重绘直接贴它，不必重新解码整张 JPEG。 */
	const decodedRef = useRef<CanvasImageSource | undefined>(undefined);
	/** 当前缩放（重绘时算画布尺寸用）。 */
	const scaleRef = useRef(1);

	/** 适应缩放：auto 时按舞台尺寸等比缩放，其余是用户指定的倍率。 */
	const scale = (() => {
		if (!frameSize || stageSize.width === 0) return undefined;
		return zoom === "auto" ? Math.min(stageSize.width / frameSize.width, stageSize.height / frameSize.height) : zoom;
	})();
	scaleRef.current = scale ?? 1;

	const applyPage = useCallback(
		(next: IabPageInfo): void => {
			const current = pageRef.current;
			if (current?.pageId !== next.pageId || current.url !== next.url || current.sessionId !== next.sessionId) {
				// 绑定/换页/URL 被带走：持久化跟着走（pageId 优先，URL 兜底，重开应用还原）
				store.setTabPath(tab.id, encodeIabPath(next.pageId, next.url, next.sessionId));
				setDraft(next.url);
			}
			pageRef.current = next;
			setPage(next);
		},
		[store, tab.id],
	);

	/** 把当前帧画到 canvas（setTimeout 合并同帧多次触发）。
	 *  刻意不用 requestAnimationFrame：内嵌在桌面壳里的页面 rAF 可能被永久饿死
	 *  （实测 ZCode IAB 中 rAF 不触发而 visibilityState 仍为 visible），会黑屏。 */
	const drawFrame = useCallback((): void => {
		drawScheduled.current = false;
		const canvas = canvasRef.current;
		const source = decodedRef.current;
		const current = frameRef.current;
		if (!canvas || !source || !current) return;
		// 画布按「显示尺寸 × 设备像素」开，合成器 1:1 贴图。
		// 早先按帧原始尺寸（1280×860）开、再靠 CSS 缩到 40% 显示：拖窗口边框时
		// 每次布局变化都要把整张位图重新缩放采样，画面整片都在动 —— 看着就是抖。
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(1, Math.round(current.width * scaleRef.current * ratio));
		const height = Math.max(1, Math.round(current.height * scaleRef.current * ratio));
		// 改后备存储会清空画布，紧接着同一次绘制补上：中间不留空白帧。
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		const context = canvasContext(canvas);
		if (!context) return;
		try {
			context.drawImage(source, 0, 0, width, height);
		} catch {
			/* 源不可用（解码失败/被回收）：这一帧跳过，下一帧补上 */
		}
	}, []);

	const scheduleDraw = useCallback((): void => {
		if (drawScheduled.current) return;
		drawScheduled.current = true;
		setTimeout(drawFrame, 0);
	}, [drawFrame]);

	/** canvas 元素换了（挂上/重挂）时补画：新画布是空的。 */
	const setCanvas = useCallback(
		(element: HTMLCanvasElement | null): void => {
			canvasRef.current = element;
			if (element) scheduleDraw();
		},
		[scheduleDraw],
	);

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
			const ownerSessionId = parsed.sessionId ?? sessionIdRef.current;
			const request =
				initialPageId && !fellBack
					? { type: "iab.open" as const, pageId: initialPageId }
					: {
							type: "iab.open" as const,
							url: initialUrl ?? "about:blank",
							...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
						};
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

	// 未建聊天时用户先打开的页面，在该面板成为当前聊天的操作目标时认领。
	// 已归属其他聊天的页面保留手动查看，不随聊天切换重新绑定。
	useEffect(() => {
		if (!sessionId || !page || page.sessionId || sidebarState.activeId !== tab.id) return;
		let cancelled = false;
		void client
			.request<{ page: IabPageInfo }>({ type: "iab.open", pageId: page.pageId, sessionId })
			.then((response) => {
				if (!cancelled && response.ok && response.result) applyPage(response.result.page);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [client, sessionId, page?.pageId, page?.sessionId, sidebarState.activeId, tab.id, applyPage]);

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
					const next = {
						data: message.data,
						format: message.format,
						width: message.width,
						height: message.height,
					};
					frameRef.current = next;
					// 尺寸变化（视口切换）才进 state；普通帧只重绘 canvas
					setFrameSize((prev) =>
						prev && prev.width === next.width && prev.height === next.height
							? prev
							: { width: next.width, height: next.height },
					);
					// 解码异步做：解码没回来之前继续显示旧帧（不闪），回来才换。
					void decodeFrameImage(next).then((source) => {
						if (!source || frameRef.current !== next) return;
						const previous = decodedRef.current;
						decodedRef.current = source;
						if (previous !== undefined && typeof (previous as ImageBitmap).close === "function") {
							(previous as ImageBitmap).close();
						}
						scheduleDraw();
					});
				}
				return;
			}
			if (message.type === "iab.filechooser") {
				if (message.pageId === pageRef.current?.pageId) setFileChooser({ multiple: message.multiple });
				return;
			}
			if (message.type === "iab.highlight") {
				if (message.pageId === pageRef.current?.pageId) setHighlight(message.rect ?? undefined);
				return;
			}
			if (message.type === "iab.pages") {
				setPages(
					message.pages.filter(
						(candidate) => !sessionId || !candidate.sessionId || candidate.sessionId === sessionId,
					),
				);
				if (!pageRef.current) return;
				const current = pageRef.current;
				const mine = message.pages.find((candidate) => candidate.pageId === current.pageId);
				if (mine) {
					if (
						mine.url !== current.url ||
						mine.title !== current.title ||
						mine.active !== current.active ||
						mine.sessionId !== current.sessionId ||
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
				((preset.width === width && preset.height === height) ||
					(preset.height === width && preset.width === height))
				? selected
				: "responsive";
		});
	}, [page?.pageId, page?.viewport.width, page?.viewport.height]);

	// 画布就位/缩放变了时补画缓冲帧：后台绑定期间收到的帧当时画不进
	// （canvas 未挂载），激活切回来时靠这次补绘显示，否则白屏。
	// 依赖缩放而不是舞台尺寸：拖窗口边框时舞台尺寸每步都变，可画面内容没变，
	// 不该每步都重画（重画要贴一次图，积多了面板就跟着抖）。
	useEffect(() => {
		if (frameSize && scale !== undefined) scheduleDraw();
	}, [frameSize, scale, scheduleDraw]);

	// 舞台尺寸 → 适应窗口缩放。立即量一次 + ResizeObserver + 1s 兜底轮询：
	// 嵌在桌面壳里的页面 ResizeObserver/rAF 可能被永久饿死（实测连初始回调
	// 都不触发），不能只依赖它们；尺寸没变时 measure 返回原对象，不会重渲染。
	// 必须量 getBoundingClientRect（小数）而不是 clientWidth/clientHeight（四舍五入
	// 的整数）：缩放按整数算会把画布撑得比真实内容盒宽零点几像素，overflow-auto
	// 就冒出滚动条，拖动时小数部分反复扫过取整边界，滚动条不停出现消失，画面抖。
	useEffect(() => {
		const element = stageRef.current;
		if (!element) return;
		const measure = (): void => {
			setStageSize((current) => {
				const rect = element.getBoundingClientRect();
				const width = rect.width;
				const height = rect.height;
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
		const ownerSessionId = current?.sessionId ?? sessionIdRef.current;
		void client
			.request<{ page: IabPageInfo }>({
				type: "iab.open",
				...(current ? { pageId: current.pageId } : {}),
				url: next,
				...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
			})
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

	const applyViewport = (width: number, height: number, preset = "responsive", device?: DeviceProfile): void => {
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
		const sameSize = next.width === current.viewport.width && next.height === current.viewport.height;
		if (sameSize && !device) {
			setViewportPreset(preset);
			return;
		}
		setViewportPending(true);
		void client
			.request({ type: "iab.viewport", pageId: current.pageId, ...next, ...(device ? { device } : {}) })
			.then((response) => {
				if (pageRef.current?.pageId !== current.pageId) return;
				if (!response.ok) throw new Error(response.error ?? t("browser.resizeFailed"));
				setViewportPreset(preset);
			})
			.catch((error: unknown) => {
				if (pageRef.current?.pageId !== current.pageId) return;
				const viewport = pageRef.current.viewport;
				setViewportDraft({ width: String(viewport.width), height: String(viewport.height) });
				setViewportError(error instanceof Error ? error.message : t("browser.resizeFailed"));
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

	/** agent 操作总闸：关掉后本会话的浏览器动作立刻 fail closed。 */
	const toggleAgentControl = (): void => {
		if (!sessionId) return;
		const next = !agentControl;
		setAgentControl(next);
		void client.request({ type: "session.setBrowserControl", sessionId, enabled: next }).catch(() => {
			setAgentControl(!next);
		});
	};

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

	// 独立窗口打开：桌面壳里弹新窗口，普通浏览器里是新标签页；被壳拦截时退回系统浏览器。
	// 页面地址由被访问站点自己决定（可能落到 file:、javascript: 等 scheme），
	// 交给壳之前统一过白名单，只放行 http(s)。
	const popout = (): void => {
		const target = toExternalUrl(pageRef.current?.url ?? "");
		if (!target) return;
		// target 已由 toExternalUrl 限定为 http(s)。
		const win = window.open(target, "_blank", "noopener");
		if (!win) void api.openExternal("url", target).catch(() => {});
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

	return (
		<div className="owl-browser flex h-full flex-col overflow-hidden bg-owl-bg" data-iab-capture>
			{/* 标签页条：agent 会开多个页，侧栏要看得见、能切。 */}
			{pages.length > 1 ? (
				<div className="owl-browser-tabs flex shrink-0 items-center gap-1 overflow-x-auto border-b border-owl-border/40 px-2 py-1">
					{pages.map((candidate) => (
						<button
							key={candidate.pageId}
							type="button"
							className={`owl-browser-tab ${candidate.pageId === page?.pageId ? "owl-browser-tab--active" : ""}`}
							title={candidate.title || candidate.url}
							onClick={() => {
								void client.request({ type: "iab.open", pageId: candidate.pageId }).catch(() => {});
							}}
						>
							<span className="truncate">{candidate.title || candidate.url || t("browser.newTab")}</span>
						</button>
					))}
				</div>
			) : null}
			{/* 导航工具条；响应式控制单独一行，侧栏收窄时自然换行。 */}
			<div className="flex shrink-0 select-none flex-wrap items-center gap-1.5 border-b border-owl-border/40 px-2 py-1.5">
				<button
					type="button"
					title={t("browser.back")}
					className={toolbarButton}
					disabled={!page}
					onClick={() => runNav("back")}
				>
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
				<button
					type="button"
					title={t("browser.forward")}
					className={toolbarButton}
					disabled={!page}
					onClick={() => runNav("forward")}
				>
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
				<button
					type="button"
					title={t("common.refresh")}
					className={toolbarButton}
					disabled={!page}
					onClick={() => runNav("reload")}
				>
					<IconRefresh size={11} />
				</button>
				<button
					type="button"
					title={t("browser.responsiveToggle")}
					aria-label={t("browser.responsiveToggle")}
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
					<span>{t("browser.responsive")}</span>
				</button>
				<input
					aria-label={t("browser.urlAria")}
					value={draft}
					placeholder={t("browser.urlPlaceholder")}
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
				<button
					type="button"
					title={t("browser.popout")}
					className={toolbarButton}
					disabled={!page?.url}
					onClick={popout}
				>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
						<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
						<rect x="8" y="7.5" width="5" height="4" rx="0.5" fill="currentColor" stroke="none" />
					</svg>
				</button>
				<button
					type="button"
					title={currentBookmarked ? t("browser.unbookmark") : t("browser.bookmark")}
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
					title={agentControl ? t("browser.agentControl") : t("browser.agentControlOff")}
					aria-label={agentControl ? t("browser.agentControl") : t("browser.agentControlOff")}
					aria-pressed={agentControl}
					className={`${toolbarButton} ${agentControl ? "text-owl-accent hover:text-owl-accent" : ""}`}
					disabled={!sessionId}
					onClick={toggleAgentControl}
				>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3 w-3">
						<path d="M8 4.5a3.5 3.5 0 0 1 3.5 3.5v1.2l1.3 1.8H3.2l1.3-1.8V8A3.5 3.5 0 0 1 8 4.5Z" />
						<path d="M6.6 12.2a1.5 1.5 0 0 0 2.8 0" />
					</svg>
				</button>
				<button
					type="button"
					title={t("browser.openExternal")}
					className={toolbarButton}
					disabled={!page?.url}
					onClick={openExternal}
				>
					<IconExternal size={11} />
				</button>
			</div>

			{page && responsive && (
				<div
					className="owl-browser-responsive-toolbar"
					aria-label={t("browser.responsiveToolbar")}
					aria-busy={viewportPending}
				>
					<label className="owl-browser-device">
						<span>{t("browser.size")}</span>
						<select
							aria-label={t("browser.device")}
							value={viewportPreset}
							disabled={viewportPending}
							onChange={(event) => {
								const selected = event.target.value;
								const preset = VIEWPORT_PRESETS.find((candidate) => candidate.label === selected);
								if (preset) applyViewport(preset.width, preset.height, preset.label, preset.device);
								else setViewportPreset("responsive");
							}}
						>
							<option value="responsive">{t("browser.responsive")}</option>
							{VIEWPORT_PRESETS.map((preset) => (
								<option key={preset.label} value={preset.label}>
									{preset.labelKey ? t(preset.labelKey) : preset.label}
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
									aria-label={dimension === "width" ? t("browser.viewportWidth") : t("browser.viewportHeight")}
									title={dimension === "width" ? t("browser.widthHint") : t("browser.heightHint")}
									min={320}
									max={dimension === "width" ? 3840 : 2160}
									step={1}
									value={viewportDraft[dimension]}
									disabled={viewportPending}
									onChange={(event) =>
										setViewportDraft((current) => ({ ...current, [dimension]: event.target.value }))
									}
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
						aria-label={t("browser.rotate")}
						title={page.viewport.width > 2160 ? t("browser.rotateBlocked") : t("browser.rotate")}
						disabled={viewportPending || page.viewport.width > 2160}
						onClick={() =>
							applyViewport(
								page.viewport.height,
								page.viewport.width,
								viewportPreset,
								VIEWPORT_PRESETS.find((candidate) => candidate.label === viewportPreset)?.device,
							)
						}
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
						aria-label={t("browser.zoom")}
						title={t("browser.zoomTitle")}
						className="owl-browser-zoom"
						value={String(zoom)}
						onChange={(event) => setZoom(event.target.value === "auto" ? "auto" : Number(event.target.value))}
					>
						<option value="auto">
							{t("browser.fit")}
							{scale ? ` ${Math.round(scale * 100)}%` : ""}
						</option>
						{ZOOM_LEVELS.map((level) => (
							<option key={level} value={String(level)}>
								{Math.round(level * 100)}%
							</option>
						))}
					</select>
					<button
						type="button"
						aria-label={t("browser.closeResponsive")}
						title={t("browser.closeResponsiveToolbar")}
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
					<p className="text-sm text-owl-muted">{t("browser.embeddedTitle")}</p>
					<p className="max-w-sm text-xs leading-relaxed text-owl-faint">{t("browser.embeddedDesc")}</p>
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
							<p className="mb-1.5 text-[11px] font-medium text-owl-faint">{t("browser.bookmarks")}</p>
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
											title={t("browser.deleteBookmark")}
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
				// 适应缩放下内容永远贴合舞台，overflow-hidden 把拖动窗口时 state 慢一拍
				// 的瞬时溢出直接裁掉：不冒滚动条，画面就没有可震荡的东西。固定缩放才
				// 真的需要滚动（overflow-auto），且那时内容尺寸不随舞台变，滚动条稳定。
				<div
					ref={stageRef}
					className={`owl-browser-stage relative min-h-0 flex-1 bg-black/40 ${zoom === "auto" ? "overflow-hidden" : "overflow-auto"}`}
				>
					{frameSize && scale ? (
						// 填满舞台交给 CSS（width/height:100%）：内容超了用 min-* 撑出滚动区。
						// 早先用 JS 量的 clientWidth 定宽，整数与亚像素布局差出的零点几像素
						// 会反复触发滚动条出现/消失，拖动窗口时画面跟着抖。
						<div
							className="owl-browser-fit"
							style={{ minWidth: frameSize.width * scale, minHeight: frameSize.height * scale }}
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
									sendInput({
										kind: "mouse",
										action: "up",
										x: coords.x,
										y: coords.y,
										button: mouseButtonOf(e.button),
									});
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
								<canvas ref={setCanvas} className="h-full w-full select-none bg-white" />
								{highlight && scale ? (
									<div
										className="owl-browser-highlight"
										style={{
											left: highlight.x * scale,
											top: highlight.y * scale,
											width: Math.max(highlight.width * scale, 4),
											height: Math.max(highlight.height * scale, 4),
										}}
									/>
								) : null}
							</div>
						</div>
					) : (
						<div className="flex h-full items-center justify-center">
							<span className="animate-pulse text-xs text-owl-faint">{t("browser.connecting")}</span>
						</div>
					)}
					{fileChooser && (
						<div className="absolute inset-x-2 top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-owl-accent/50 bg-owl-panel/95 px-3 py-2 shadow-lg">
							<span className="shrink-0 text-xs text-owl-text">
								{t("browser.fileChooser", { yes: fileChooser.multiple ? t("browser.yes") : t("browser.no") })}
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
								placeholder={t("browser.filePathPlaceholder")}
								spellCheck={false}
								className="h-6 min-w-32 flex-1 rounded border border-owl-border/50 bg-owl-bg px-2 font-mono text-[11px] text-owl-text outline-none focus:border-owl-accent/60"
							/>
							<button
								type="button"
								onClick={submitFileChooser}
								className="shrink-0 rounded bg-owl-accent px-2 py-1 text-[11px] text-white transition-opacity hover:opacity-90"
							>
								{t("common.submit")}
							</button>
							<button
								type="button"
								onClick={() => setFileChooser(undefined)}
								className="shrink-0 text-xs text-owl-faint transition-colors hover:text-owl-text"
							>
								{t("browser.ignore")}
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
