/**
 * owl IAB browser hub —— 桥进程托管的私有无头浏览器（playwright-core + 系统
 * Edge/Chrome，channel 启动免下载）。UI 面板通过 CDP screencast 帧流看到页面、
 * 经 iab.input 驱动；agent 通过 browser_* 工具驱动同一批页面，双方看到的是
 * 同一份实时状态 —— ZCode 桌面 IAB「agent 操控浏览器、用户看得见」的自制版。
 *
 * 页面 = 无头浏览器的一个 tab。frames 由 Page.startScreencast 推送（CDP 会话
 * 经 playwright 官方 newCDPSession API），hub 只负责转发，订阅记账在 serve.ts
 *（与 term.* 同策略：帧只发给订阅连接，页面清单变化才广播）。
 */
import { randomUUID } from "node:crypto";
import pw from "playwright-core";
import type { Browser, CDPSession, FileChooser, Page } from "playwright-core";
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { IabInputPayload, IabPageInfo } from "./protocol.ts";

/** 新页面默认视口（ZCode IAB 同款默认档）。 */
const DEFAULT_VIEWPORT = { width: 1280, height: 860 };
/** snapshot 单次返回的元素上限（超出截断并提示，防大页面刷爆上下文）。 */
const SNAPSHOT_LIMIT = 400;
/** 单页 console 环形缓冲上限（browser_console 读取最近 50 条）。 */
const CONSOLE_BUFFER_LIMIT = 100;
/** 点击/输入/滚动后的静默期：给 SPA 渲染留时间，减少模型无效往返。 */
const ACTION_SETTLE_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface BrowserHubCallbacks {
	/** 页面清单变化（导航/开关页/标题变化）。origin 标记触发方（agent 工具 or UI）。 */
	onPagesChanged: (pages: IabPageInfo[], origin: "agent" | "ui") => void;
	/** 一帧 screencast（PNG base64，文字锐利）。 */
	onFrame: (pageId: string, data: string, width: number, height: number) => void;
	/** 页面弹出了文件选择框（无头浏览器弹不出系统对话框，需要 UI 提示 / agent 应答）。 */
	onFileChooser: (pageId: string, multiple: boolean) => void;
	onDiagnostic: (message: string) => void;
}

interface PageEntry {
	page: Page;
	cdp: CDPSession;
	info: IabPageInfo;
	/** 页面 console/未捕获报错的环形缓冲（browser_console 读取）。 */
	console: string[];
	/** 页面当前等待应答的文件选择框（如有）。 */
	pendingChooser: { chooser: FileChooser; multiple: boolean } | null;
}

/** 注入页面的 ref 记账器：元素 ↔ 数字 ref，双击快照里的 ref 即可定位回元素。 */
const REF_SETUP = `
	(() => {
		if (!window.__owlRefs) window.__owlRefs = { next: 1, map: new Map() };
		return window.__owlRefs;
	})()
`;

export class BrowserHub {
	private readonly callbacks: BrowserHubCallbacks;
	private browser: Browser | null = null;
	private launchPromise: Promise<Browser> | null = null;
	private pages = new Map<string, PageEntry>();
	/** agent 工具当前作用的目标页；UI 打开/绑定不改变它。 */
	private activePageId: string | undefined;
	/** 正在执行的触发方：工具执行期间置 "agent"，事件回调用它标记 origin。 */
	private origin: "agent" | "ui" = "ui";

	constructor(callbacks: BrowserHubCallbacks) {
		this.callbacks = callbacks;
	}

	// -- 生命周期 -------------------------------------------------------------

	private ensureBrowser(): Promise<Browser> {
		if (this.browser) return Promise.resolve(this.browser);
		this.launchPromise ??= this.launchBrowser().then((browser) => {
			this.browser = browser;
			browser.on("disconnected", () => {
				// 浏览器进程意外退出（崩溃/被杀）：清账，下次使用时重新拉起
				this.browser = null;
				this.launchPromise = null;
				for (const pageId of [...this.pages.keys()]) this.pages.delete(pageId);
				this.activePageId = undefined;
				this.emitPages();
			});
			return browser;
		});
		return this.launchPromise;
	}

	/** channel 启动系统 Edge/Chrome（免下载）；都不在时回落常见安装路径探测。 */
	private async launchBrowser(): Promise<Browser> {
		const override = process.env.OWL_BROWSER_PATH;
		const attempts: Array<{ channel?: string; executablePath?: string }> = override
			? [{ executablePath: override }]
			: [{ channel: "msedge" }, { channel: "chrome" }];
		if (!override) {
			for (const path of [
				"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
				"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
				"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
				"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
			]) {
				attempts.push({ executablePath: path });
			}
		}
		let lastError: unknown;
		for (const attempt of attempts) {
			try {
				return await pw.chromium.launch({ ...attempt, headless: true });
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(
			`无法启动无头浏览器（需要系统安装 Edge 或 Chrome，或设置 OWL_BROWSER_PATH 指向浏览器可执行文件）：${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`,
		);
	}

	async dispose(): Promise<void> {
		for (const { cdp } of this.pages.values()) {
			await cdp.detach().catch(() => {});
		}
		this.pages.clear();
		await this.browser?.close().catch(() => {});
		this.browser = null;
		this.launchPromise = null;
	}

	// -- 页面管理 -------------------------------------------------------------

	private async newPage(url?: string): Promise<PageEntry> {
		const browser = await this.ensureBrowser();
		const context = browser.contexts()[0] ?? (await browser.newContext());
		const page = await context.newPage();
		await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => {});
		const pageId = randomUUID();
		const cdp = await context.newCDPSession(page);
		const entry: PageEntry = {
			page,
			cdp,
			info: { pageId, url: "", title: "", viewport: { ...DEFAULT_VIEWPORT }, active: false },
			console: [],
			pendingChooser: null,
		};
		this.pages.set(pageId, entry);
		page.on("close", () => {
			this.pages.delete(pageId);
			if (this.activePageId === pageId) this.activePageId = [...this.pages.keys()][0];
			this.emitPages();
		});
		page.on("domcontentloaded", () => this.refreshPageMeta(entry));
		// 标题是异步行内的（document.title 变化不触发导航事件）：轮询太糙，
		// 用 title 事件补偿——playwright 无 page title 事件，framed navigated 兜底。
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) this.refreshPageMeta(entry);
		});
		page.on("console", (message) => this.pushConsole(entry, `[${message.type()}] ${message.text()}`));
		page.on("pageerror", (error) => this.pushConsole(entry, `[pageerror] ${error.message}`));
		// 无头浏览器弹不出系统文件对话框：拦下事件，交给 UI 提示 / agent 应答
		page.on("filechooser", (chooser) => {
			entry.pendingChooser = { chooser, multiple: chooser.isMultiple() };
			this.callbacks.onFileChooser(pageId, chooser.isMultiple());
		});
		cdp.on("Page.screencastFrame", (params) => {
			const meta = params.metadata;
			void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
			if (!meta) return;
			this.callbacks.onFrame(pageId, params.data, meta.deviceWidth ?? 0, meta.deviceHeight ?? 0);
		});
		// PNG 帧：本地 WS 带宽充裕，换文字锐利（JPEG 的糊字在 UI 放大后没法看）
		await cdp.send("Page.startScreencast", { format: "png" }).catch(() => {});
		if (url) await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
		await this.refreshPageMeta(entry);
		return entry;
	}

	private pushConsole(entry: PageEntry, line: string): void {
		entry.console.push(line);
		if (entry.console.length > CONSOLE_BUFFER_LIMIT) entry.console.shift();
	}

	private async refreshPageMeta(entry: PageEntry): Promise<void> {
		const { page, info } = entry;
		const url = page.url();
		const title = await page.title().catch(() => "");
		if (url === info.url && title === info.title) return;
		info.url = url;
		info.title = title;
		this.emitPages();
	}

	private emitPages(): void {
		const origin = this.origin;
		this.callbacks.onPagesChanged(this.listPages(), origin);
	}

	listPages(): IabPageInfo[] {
		return [...this.pages.values()].map(({ info }) => ({
			...info,
			active: info.pageId === this.activePageId,
		}));
	}

	/** 绑定/打开：pageId 优先（只绑定），url 其次（按 URL 复用或新建），双给 = 导航既有页。 */
	async open(options: { pageId?: string; url?: string }): Promise<IabPageInfo> {
		this.origin = "ui";
		try {
			if (options.pageId) {
				const found = this.pages.get(options.pageId);
				if (!found) throw new Error(`页面不存在或已关闭: ${options.pageId}`);
				if (options.url && options.url !== found.info.url) {
					await found.page.goto(options.url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
				}
				await this.refreshPageMeta(found);
				return { ...found.info, active: found.info.pageId === this.activePageId };
			}
			if (options.url) {
				const existing = [...this.pages.values()].find(({ info }) => info.url === options.url);
				if (existing) return { ...existing.info, active: existing.info.pageId === this.activePageId };
			}
			const entry = await this.newPage(options.url);
			this.emitPages();
			return { ...entry.info, active: entry.info.pageId === this.activePageId };
		} finally {
			this.origin = "ui";
		}
	}

	async nav(pageId: string, action: "back" | "forward" | "reload"): Promise<void> {
		const entry = this.requirePage(pageId);
		this.origin = "ui";
		try {
			if (action === "back") await entry.page.goBack({ waitUntil: "load", timeout: 15_000 }).catch(() => {});
			else if (action === "forward")
				await entry.page.goForward({ waitUntil: "load", timeout: 15_000 }).catch(() => {});
			else await entry.page.reload({ waitUntil: "load", timeout: 20_000 }).catch(() => {});
			await this.refreshPageMeta(entry);
		} finally {
			this.origin = "ui";
		}
	}

	async setViewport(pageId: string, width: number, height: number): Promise<void> {
		const entry = this.requirePage(pageId);
		const clamped = {
			width: Math.min(Math.max(Math.round(width), 320), 3840),
			height: Math.min(Math.max(Math.round(height), 320), 2160),
		};
		await entry.page.setViewportSize(clamped).catch(() => {});
		entry.info.viewport = clamped;
		// 视口变化后 screencast 会自动出新一帧；这里补一次全量截图避免拼接缝
		await this.captureFrame(pageId);
		this.emitPages();
	}

	async closePage(pageId: string): Promise<void> {
		const entry = this.pages.get(pageId);
		if (!entry) return;
		await entry.page.close().catch(() => {}); // close 事件统一清账与广播
	}

	/** attach 时先推一帧全量截图，screencast 只管后续增量。 */
	async captureFrame(pageId: string): Promise<void> {
		const entry = this.pages.get(pageId);
		if (!entry) return;
		try {
			const buffer = await entry.page.screenshot({ type: "png", caret: "hide" });
			const viewport = entry.page.viewportSize() ?? DEFAULT_VIEWPORT;
			this.callbacks.onFrame(pageId, buffer.toString("base64"), viewport.width, viewport.height);
		} catch {
			// 页面正在导航时截图可能失败：忽略，等 screencast 帧补上
		}
	}

	/** 应答等待中的文件选择框（agent 工具与 iab.fileResponse 共用）。 */
	async fileResponse(pageId: string, paths: string[]): Promise<void> {
		const entry = this.requirePage(pageId);
		const pending = entry.pendingChooser;
		if (!pending) throw new Error("页面当前没有等待中的文件选择框");
		const clean = paths.map((path) => path.trim()).filter((path) => path !== "");
		if (clean.length === 0) throw new Error("paths 为空");
		if (!pending.multiple && clean.length > 1) throw new Error("该选择框只允许单选，paths 只能提供一个文件");
		await pending.chooser.setFiles(clean);
		entry.pendingChooser = null;
	}

	async input(pageId: string, payload: IabInputPayload): Promise<void> {
		const entry = this.requirePage(pageId);
		const { page } = entry;
		this.origin = "ui";
		try {
			if (payload.kind === "mouse") {
				const button = payload.button ?? "left";
				if (payload.action === "move") await page.mouse.move(payload.x, payload.y);
				else if (payload.action === "down") await page.mouse.down({ button });
				else await page.mouse.up({ button });
			} else if (payload.kind === "wheel") {
				await page.mouse.move(payload.x, payload.y);
				await page.mouse.wheel(payload.deltaX, payload.deltaY);
			} else {
				const modifiers = (payload.modifiers ?? []).filter((modifier) =>
					["Control", "Shift", "Alt", "Meta"].includes(modifier),
				) as Array<"Control" | "Shift" | "Alt" | "Meta">;
				const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);
				if (MODIFIER_KEYS.has(payload.key)) {
					// 纯修饰键：跟随 UI 的按下/抬起
					if (payload.down) await page.keyboard.down(payload.key);
					else await page.keyboard.up(payload.key);
				} else if (payload.down) {
					// 普通键在 down 时按一下（press = down+up；UI 的自动重复就是多次 press）
					for (const modifier of modifiers) await page.keyboard.down(modifier);
					await page.keyboard.press(payload.text && payload.text.length === 1 ? payload.text : payload.key);
					for (const modifier of modifiers) await page.keyboard.up(modifier);
				}
			}
		} finally {
			this.origin = "ui";
		}
	}

	private requirePage(pageId: string): PageEntry {
		const entry = this.pages.get(pageId);
		if (!entry) throw new Error(`页面不存在或已关闭: ${pageId}`);
		return entry;
	}

	// -- agent 工具 -------------------------------------------------------------

	/** agent 作用页：activePageId 缺失时取第一页，都没有就开空白页。 */
	private async agentPage(): Promise<PageEntry> {
		let entry = this.activePageId ? this.pages.get(this.activePageId) : undefined;
		if (!entry) entry = [...this.pages.values()][0];
		if (!entry) {
			entry = await this.newPage();
			this.activePageId = entry.info.pageId;
			this.emitPages();
			return entry;
		}
		if (this.activePageId !== entry.info.pageId) {
			this.activePageId = entry.info.pageId;
			this.emitPages();
		}
		return entry;
	}

	/** 工具执行包裹：期间产生的事件标 origin=agent（UI 据此自动开面板）。 */
	private async withAgent<T>(operation: () => Promise<T>): Promise<T> {
		this.origin = "agent";
		try {
			return await operation();
		} finally {
			this.origin = "ui";
		}
	}

	tools(): ToolDefinition[] {
		const hub = this;
		const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

		const navigateParams = Type.Object({
			url: Type.String({ description: "要打开的 URL，例如 http://127.0.0.1:18970/" }),
		});
		const navigate: ToolDefinition<typeof navigateParams> = {
			name: "browser_navigate",
			label: "浏览器：打开网页",
			description:
				"在内嵌浏览器里打开一个 URL（用户能在桌面端浏览器面板实时看到）。" +
				"URL 缺协议时自动补 https://。打开后用 browser_snapshot 观察页面再操作。",
			promptSnippet: "browser_navigate: 在内嵌浏览器打开 URL（用户可见）",
			parameters: navigateParams,
			execute: async (_id, params) =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					let url = params.url.trim();
					if (!url) return text("缺少 url 参数。");
					if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
					await entry.page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
					await hub.refreshPageMeta(entry);
					return text(`已打开 ${entry.info.url}（标题：${entry.info.title || "(无)"}）。用 browser_snapshot 观察页面。`);
				}),
		};

		const snapshot: ToolDefinition = {
			name: "browser_snapshot",
			label: "浏览器：读取页面快照",
			description:
				"读取内嵌浏览器当前页面的可交互元素快照（AI/ARIA 风格，带 ref 编号）。" +
				"这是浏览器操作的观察依据：点击/输入前先拍快照，动作后重新拍快照确认效果。",
			promptSnippet: "browser_snapshot: 读取内嵌浏览器的页面快照（浏览器操作的观察依据）",
			promptGuidelines: [
				"操作内嵌浏览器时遵循 观察 → 动作 → 再观察 的循环：browser_snapshot 拿到元素 ref，",
				"browser_click / browser_type 按 ref 操作，然后用新的 browser_snapshot 确认效果；",
				"视觉核对（布局/样式/截图）才用 browser_screenshot。",
			],
			parameters: Type.Object({}),
			execute: async () =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					const result = (await entry.page.evaluate(SNAPSHOT_SCRIPT)) as {
						url: string;
						title: string;
						lines: string[];
					};
					const chooserHint = entry.pendingChooser
						? `\n\n⚠️ 页面正在等待文件选择（允许多选：${entry.pendingChooser.multiple ? "是" : "否"}）。用 browser_set_file_chooser 提供本机绝对路径完成选择。`
						: "";
					const truncated =
						result.lines.length >= SNAPSHOT_LIMIT
							? `\n(已达 ${SNAPSHOT_LIMIT} 条上限，已截断——用更精确的 URL 或先操作缩小范围)`
							: "";
					return text(
						`页面：${result.title}\nURL：${result.url}\n\n${result.lines.join("\n")}${chooserHint}${truncated}`,
					);
				}),
		};

		const clickParams = Type.Object({
			ref: Type.Number({ description: "browser_snapshot 返回的 ref 编号" }),
		});
		const click: ToolDefinition<typeof clickParams> = {
			name: "browser_click",
			label: "浏览器：点击元素",
			description: "点击快照里某个 ref 对应的元素（按元素中心派发真实鼠标事件）。点击后用 browser_snapshot 确认效果。",
			promptSnippet: "browser_click: 按快照 ref 点击内嵌浏览器里的元素",
			parameters: clickParams,
			execute: async (_id, params) =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					const point = await resolveRef(entry, params.ref);
					if (!point) return text(`ref=${params.ref} 已失效（页面可能刷新过），请重新 browser_snapshot。`);
					await entry.page.mouse.move(point.x, point.y);
					await entry.page.mouse.click(point.x, point.y);
					await sleep(ACTION_SETTLE_MS);
					return text(`已点击 ref=${params.ref}${point.name ? `（${point.name}）` : ""}。用 browser_snapshot 观察结果。`);
				}),
		};

		const typeParams = Type.Object({
			ref: Type.Number({ description: "browser_snapshot 返回的 ref 编号" }),
			text: Type.String({ description: "要输入的文本" }),
			clear: Type.Optional(Type.Boolean({ description: "输入前清空已有内容（默认 false）" })),
		});
		const type: ToolDefinition<typeof typeParams> = {
			name: "browser_type",
			label: "浏览器：输入文本",
			description: "先点击聚焦快照里的 ref 元素，再输入文本。clear=true 时先清空已有内容（输入框适用）。",
			promptSnippet: "browser_type: 向内嵌浏览器的输入元素输入文本",
			parameters: typeParams,
			execute: async (_id, params) =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					const point = await resolveRef(entry, params.ref);
					if (!point) return text(`ref=${params.ref} 已失效，请重新 browser_snapshot。`);
					await entry.page.mouse.click(point.x, point.y);
					if (params.clear === true) {
						await entry.page.keyboard.down("Control");
						await entry.page.keyboard.press("a");
						await entry.page.keyboard.up("Control");
						await entry.page.keyboard.press("Delete");
					}
					await entry.page.keyboard.type(params.text, { delay: 10 });
					await sleep(ACTION_SETTLE_MS);
					return text(`已输入到 ref=${params.ref}。用 browser_snapshot 确认。`);
				}),
		};

		const pressKeyParams = Type.Object({
			key: Type.String({ description: "按键名，如 Enter / Escape / ArrowDown / Control+a" }),
		});
		const pressKey: ToolDefinition<typeof pressKeyParams> = {
			name: "browser_press_key",
			label: "浏览器：按键",
			description: "向内嵌浏览器当前焦点发送按键（如 Enter、Escape、ArrowDown；组合键用 +，如 Control+a）。",
			promptSnippet: "browser_press_key: 向内嵌浏览器发送按键",
			parameters: pressKeyParams,
			execute: async (_id, params) =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					await entry.page.keyboard.press(params.key);
					await sleep(ACTION_SETTLE_MS);
					return text(`已按下 ${params.key}。`);
				}),
		};

		const scrollParams = Type.Object({
			direction: Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "滚动方向" }),
			amount: Type.Optional(Type.Number({ description: "滚动像素数（默认 600）" })),
		});
		const scroll: ToolDefinition<typeof scrollParams> = {
			name: "browser_scroll",
			label: "浏览器：滚动页面",
			description: "在当前页面以视口中心为锚滚动。direction=up/down，amount 为像素（默认 600）。",
			promptSnippet: "browser_scroll: 滚动内嵌浏览器页面",
			parameters: scrollParams,
			execute: async (_id, params) =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					const viewport = entry.page.viewportSize() ?? DEFAULT_VIEWPORT;
					await entry.page.mouse.move(viewport.width / 2, viewport.height / 2);
					await entry.page.mouse.wheel(0, params.direction === "up" ? -(params.amount ?? 600) : (params.amount ?? 600));
					return text("已滚动。");
				}),
		};

		const screenshot: ToolDefinition = {
			name: "browser_screenshot",
			label: "浏览器：截图",
			description: "对内嵌浏览器当前页面截图并作为图片返回（视觉核对布局/样式时用；日常观察优先 browser_snapshot）。",
			promptSnippet: "browser_screenshot: 截取内嵌浏览器当前页面（返回图片）",
			parameters: Type.Object({}),
			execute: async () =>
				hub.withAgent(async () => {
					const entry = await hub.agentPage();
					const buffer = await entry.page.screenshot({ type: "jpeg", quality: 70, caret: "hide" });
					return {
						content: [
							{ type: "text" as const, text: `当前页面截图：${entry.info.url}` },
							{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/jpeg" },
						],
						details: undefined,
					};
				}),
		};

		const tabsParams = Type.Object({
			action: Type.Union(
				[Type.Literal("list"), Type.Literal("new"), Type.Literal("select"), Type.Literal("close")],
				{ description: "list=列出全部；new=新开；select=切换 agent 作用页；close=关闭" },
			),
			pageId: Type.Optional(Type.String({ description: "select/close 的目标页面 id（list 里拿，支持前缀匹配）" })),
			url: Type.Optional(Type.String({ description: "new 时可选的起始 URL" })),
		});
		const tabs: ToolDefinition<typeof tabsParams> = {
			name: "browser_tabs",
			label: "浏览器：管理标签页",
			description:
				"管理内嵌浏览器的页面（标签页）。action=list 列出全部；new 新开（可带 url）；" +
				"select 切换 agent 操作目标；close 关闭指定页。后续 browser_* 工具都作用于 select 的页面。",
			promptSnippet: "browser_tabs: 管理内嵌浏览器的标签页（列出/新开/切换/关闭）",
			parameters: tabsParams,
			execute: async (_id, params) =>
				hub.withAgent(async () => {
					const action = params.action;
					if (action === "list") {
						const pages = hub.listPages();
						if (pages.length === 0) return text("（当前没有打开的页面）");
						return text(
							pages
								.map(
									(page) =>
										`${page.active ? "* " : "  "}${page.pageId.slice(0, 8)}  ${page.title || "(无标题)"}  ${page.url}`,
								)
								.join("\n") + "\n（* = agent 当前作用页）",
						);
					}
					if (action === "new") {
						const entry = await hub.newPage(params.url ? normalizeAgentUrl(params.url) : undefined);
						hub.activePageId = entry.info.pageId;
						hub.emitPages();
						return text(`已新开页面 ${entry.info.pageId.slice(0, 8)}：${entry.info.url || "(空白页)"}`);
					}
					const wantedId = params.pageId;
					const entry = wantedId
						? (hub.pages.get(wantedId) ??
							[...hub.pages.values()].find((candidate) => candidate.info.pageId.startsWith(wantedId)))
						: undefined;
					if (!entry) return text("页面不存在，用 action=list 查看。");
					if (action === "select") {
						hub.activePageId = entry.info.pageId;
						await hub.refreshPageMeta(entry);
						return text(`已切换到 ${entry.info.title || entry.info.url}。`);
					}
					await hub.closePage(entry.info.pageId);
					return text("已关闭。");
				}),
		};

		return [navigate, snapshot, click, type, pressKey, scroll, screenshot, tabs];
	}
}

function normalizeAgentUrl(raw: string): string {
	const url = raw.trim();
	return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** ref → 可点击坐标（滚动到视口内取中心）。元素丢失返回 null（快照过期）。 */
async function resolveRef(
	entry: { page: Page },
	ref: number,
): Promise<{ x: number; y: number; name?: string } | null> {
	const target = (await entry.page.evaluate(
		`(() => {
			const el = window.__owlRefs?.map.get(${ref});
			if (!el || !el.isConnected) return null;
			el.scrollIntoView({ block: "center", inline: "center" });
			const rect = el.getBoundingClientRect();
			const name = (el.getAttribute("aria-label") || el.textContent || el.value || el.placeholder || "")
				.trim().replace(/\\s+/g, " ").slice(0, 40);
			return {
				x: Math.round(rect.x + Math.min(Math.max(rect.width / 2, 2), rect.width - 2)),
				y: Math.round(rect.y + Math.min(Math.max(rect.height / 2, 2), rect.height - 2)),
				name,
			};
		})()`
	)) as { x: number; y: number; name?: string } | null;
	return target;
}

const SNAPSHOT_SCRIPT = `
	(() => {
		const refs = ${REF_SETUP};
		const roleOf = (el) => {
			const explicit = el.getAttribute("role");
			if (explicit) return explicit;
			const tag = el.tagName;
			if (tag === "A" && el.hasAttribute("href")) return "link";
			if (tag === "INPUT") {
				const type = (el.type || "text").toLowerCase();
				if (type === "checkbox") return "checkbox";
				if (type === "radio") return "radio";
				if (type === "button" || type === "submit") return "button";
				return "textbox";
			}
			if (tag === "SELECT") return "combobox";
			if (tag === "TEXTAREA") return "textbox";
			if (tag === "SUMMARY") return "summary";
			if (/^H[1-6]$/.test(tag)) return "heading";
			if (el.isContentEditable) return "textbox";
			if (tag === "BUTTON") return "button";
			if (tag === "LABEL") return "label";
			if (tag === "VIDEO" || tag === "AUDIO") return "media";
			return tag.toLowerCase();
		};
		const lines = [];
		const seen = new Set();
		for (const el of document.querySelectorAll(
			"a[href], button, input, select, textarea, summary, [role], [contenteditable=true], [onclick],"
			+ " h1, h2, h3, h4, h5, h6, p, li, td, th"
		)) {
			if (lines.length >= ${SNAPSHOT_LIMIT}) break;
			if (!(el instanceof Element) || seen.has(el)) continue;
			seen.add(el);
			const rect = el.getBoundingClientRect();
			if (rect.width < 2 || rect.height < 2) continue;
			const style = getComputedStyle(el);
			if (style.display === "none" || style.visibility === "hidden") continue;
			let ref = el.__owlRef;
			if (!ref) {
				ref = refs.next++;
				el.__owlRef = ref;
				refs.map.set(ref, el);
			}
			const role = roleOf(el);
			const rawName = (el.getAttribute("aria-label") || el.getAttribute("placeholder")
				|| (el instanceof HTMLElement ? el.value : "") || el.textContent || "")
				.trim().replace(/\\s+/g, " ").slice(0, 80);
			// 纯文本容器（p/li/td/th/heading）没字就不占行
			if (!rawName && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) continue;
			let extra = "";
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				if (el.value) extra = \` 值="\${String(el.value).slice(0, 60)}"\`;
				if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)) {
					extra += el.checked ? " [已选]" : " [未选]";
				}
			}
			lines.push(\`[ref=\${ref}] \${role}\${rawName ? \` "\${rawName}"\` : ""}\${extra}\`);
		}
		return { url: location.href, title: document.title, lines };
	})()
`;

