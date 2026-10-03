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
import type { Browser, BrowserContext, CDPSession, FileChooser, Page } from "playwright-core";
import pw from "playwright-core";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../core/extensions/index.ts";
import { BrowserInteraction, initializeBrowserInteraction } from "./browser-interaction.ts";
import { BrowserNetworkJournal } from "./browser-network.ts";
import { BrowserOperationQueue } from "./browser-queue.ts";
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
	onPagesChanged: (pages: IabPageInfo[], origin: "agent" | "ui", originSessionId?: string) => void;
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
	interaction: BrowserInteraction;
	network: BrowserNetworkJournal;
	/** Next ref survives navigation so a stale number never targets the new document. */
	nextRefSeed: number;
	/** 页面当前等待应答的文件选择框（如有）。 */
	pendingChooser: { chooser: FileChooser; multiple: boolean } | null;
}

/** 注入页面的 ref 记账器：元素 ↔ 数字 ref，双击快照里的 ref 即可定位回元素。 */
const REF_SETUP = `
	(() => {
		if (!window.__owlRefs) window.__owlRefs = { next: __OWL_REF_SEED__, map: new Map() };
		window.__owlRefs.next = Math.max(window.__owlRefs.next, __OWL_REF_SEED__);
		return window.__owlRefs;
	})()
`;

export class BrowserHub {
	private readonly callbacks: BrowserHubCallbacks;
	private browser: Browser | null = null;
	private launchPromise: Promise<Browser> | null = null;
	private pages = new Map<string, PageEntry>();
	private readonly activePages = new Map<string, string>();
	private readonly contexts = new Map<string, BrowserContext>();
	private uiContext: BrowserContext | undefined;
	private readonly operations = new BrowserOperationQueue();

	constructor(callbacks: BrowserHubCallbacks) {
		this.callbacks = callbacks;
	}

	// -- 生命周期 -------------------------------------------------------------

	private ensureBrowser(): Promise<Browser> {
		if (this.browser) return Promise.resolve(this.browser);
		this.launchPromise ??= this.launchBrowser()
			.then((browser) => {
				this.browser = browser;
				browser.on("disconnected", () => {
					// 浏览器进程意外退出（崩溃/被杀）：清账，下次使用时重新拉起
					this.browser = null;
					this.launchPromise = null;
					for (const entry of this.pages.values()) entry.network.dispose();
					this.pages.clear();
					this.activePages.clear();
					this.contexts.clear();
					this.uiContext = undefined;
					this.emitPages();
				});
				return browser;
			})
			.catch((error: unknown) => {
				this.launchPromise = null;
				throw error;
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
		for (const { cdp, network } of this.pages.values()) {
			network.dispose();
			await cdp.detach().catch(() => {});
		}
		this.pages.clear();
		this.activePages.clear();
		this.contexts.clear();
		this.uiContext = undefined;
		await this.browser?.close().catch(() => {});
		this.browser = null;
		this.launchPromise = null;
	}

	// -- 页面管理 -------------------------------------------------------------

	private async newPage(url?: string, sessionId?: string): Promise<PageEntry> {
		await initializeBrowserInteraction();
		const browser = await this.ensureBrowser();
		let context = sessionId ? this.contexts.get(sessionId) : this.uiContext;
		if (!context) {
			context = await browser.newContext();
			if (sessionId) this.contexts.set(sessionId, context);
			else this.uiContext = context;
		}
		const page = await context.newPage();
		await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => {});
		const pageId = randomUUID();
		const cdp = await context.newCDPSession(page);
		const entry: PageEntry = {
			page,
			cdp,
			info: { pageId, sessionId, url: "", title: "", viewport: { ...DEFAULT_VIEWPORT }, active: false },
			console: [],
			interaction: new BrowserInteraction(page),
			network: new BrowserNetworkJournal(page),
			nextRefSeed: 1,
			pendingChooser: null,
		};
		this.pages.set(pageId, entry);
		page.on("close", () => {
			entry.network.dispose();
			this.pages.delete(pageId);
			const owner = entry.info.sessionId;
			if (owner && this.activePages.get(owner) === pageId) {
				const next = [...this.pages.values()].find((candidate) => candidate.info.sessionId === owner);
				if (next) this.activePages.set(owner, next.info.pageId);
				else this.activePages.delete(owner);
			}
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

	private emitPages(origin: "agent" | "ui" = "ui", originSessionId?: string): void {
		this.callbacks.onPagesChanged(this.listPages(), origin, originSessionId);
	}

	listPages(sessionId?: string): IabPageInfo[] {
		return [...this.pages.values()]
			.filter(({ info }) => sessionId === undefined || info.sessionId === sessionId)
			.map(({ info }) => ({
				...info,
				active: info.sessionId !== undefined && this.activePages.get(info.sessionId) === info.pageId,
			}));
	}

	private claimPage(entry: PageEntry, sessionId: string): void {
		if (entry.info.sessionId !== undefined && entry.info.sessionId !== sessionId) {
			throw new Error("这个浏览器页面属于其他聊天，当前 agent 不能操作它");
		}
		entry.info.sessionId = sessionId;
		this.activePages.set(sessionId, entry.info.pageId);
	}

	async disposeSession(sessionId: string): Promise<void> {
		await this.operations.run(`session:${sessionId}`, async () => {
			for (const entry of [...this.pages.values()]) {
				if (entry.info.sessionId === sessionId) await entry.page.close();
			}
			this.activePages.delete(sessionId);
			const context = this.contexts.get(sessionId);
			this.contexts.delete(sessionId);
			await context?.close();
			this.emitPages();
		});
	}

	/** 绑定/打开：pageId 优先（只绑定），url 其次（按 URL 复用或新建），双给 = 导航既有页。 */
	async open(options: { pageId?: string; url?: string; sessionId?: string }): Promise<IabPageInfo> {
		const owner = options.sessionId ?? (options.pageId ? this.pages.get(options.pageId)?.info.sessionId : undefined);
		return this.operations.run(owner ? `session:${owner}` : "ui:open", async () => {
			if (options.pageId) {
				const found = this.pages.get(options.pageId);
				if (!found) throw new Error(`页面不存在或已关闭: ${options.pageId}`);
				if (options.sessionId) this.claimPage(found, options.sessionId);
				if (options.url && options.url !== found.info.url) {
					await found.page.goto(options.url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
				}
				await this.refreshPageMeta(found);
				this.emitPages();
				return this.listPages().find((info) => info.pageId === found.info.pageId)!;
			}
			if (options.url) {
				const existing = [...this.pages.values()].find(
					({ info }) => info.url === options.url && info.sessionId === options.sessionId,
				);
				if (existing) {
					if (options.sessionId) this.claimPage(existing, options.sessionId);
					this.emitPages();
					return this.listPages().find((info) => info.pageId === existing.info.pageId)!;
				}
			}
			const entry = await this.newPage(options.url, options.sessionId);
			if (options.sessionId) this.activePages.set(options.sessionId, entry.info.pageId);
			this.emitPages();
			return this.listPages().find((info) => info.pageId === entry.info.pageId)!;
		});
	}

	async nav(pageId: string, action: "back" | "forward" | "reload"): Promise<void> {
		await this.withPage(pageId, async (entry) => {
			if (action === "back") await entry.page.goBack({ waitUntil: "load", timeout: 15_000 });
			else if (action === "forward") await entry.page.goForward({ waitUntil: "load", timeout: 15_000 });
			else await entry.page.reload({ waitUntil: "load", timeout: 20_000 });
			await this.refreshPageMeta(entry);
		});
	}

	async setViewport(pageId: string, width: number, height: number): Promise<void> {
		if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("视口宽高必须是有限数字");
		await this.withPage(pageId, async (entry) => {
			const clamped = {
				width: Math.min(Math.max(Math.round(width), 320), 3840),
				height: Math.min(Math.max(Math.round(height), 320), 2160),
			};
			await entry.page.setViewportSize(clamped);
			entry.info.viewport = clamped;
			await this.captureFrame(pageId);
			this.emitPages();
		});
	}

	async closePage(pageId: string): Promise<void> {
		const entry = this.pages.get(pageId);
		if (!entry) return;
		await this.withPage(pageId, (current) => current.page.close());
	}

	/** attach 时先推一帧全量截图，screencast 只管后续增量。截图可能因页面
	 *  正在导航而失败，静态页之后也不会自己重绘——失败就重试，保证首帧必达。 */
	async captureFrame(pageId: string): Promise<void> {
		const entry = this.pages.get(pageId);
		if (!entry) return;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const buffer = await entry.page.screenshot({ type: "png", caret: "hide" });
				const viewport = entry.page.viewportSize() ?? DEFAULT_VIEWPORT;
				this.callbacks.onFrame(pageId, buffer.toString("base64"), viewport.width, viewport.height);
				return;
			} catch {
				await sleep(300);
			}
		}
	}

	/** 应答等待中的文件选择框（agent 工具与 iab.fileResponse 共用）。 */
	async fileResponse(pageId: string, paths: string[]): Promise<void> {
		await this.withPage(pageId, async (entry) => {
			const pending = entry.pendingChooser;
			if (!pending) throw new Error("页面当前没有等待中的文件选择框");
			const clean = paths.map((path) => path.trim()).filter((path) => path !== "");
			if (clean.length === 0) throw new Error("paths 为空");
			if (!pending.multiple && clean.length > 1) throw new Error("该选择框只允许单选，paths 只能提供一个文件");
			await pending.chooser.setFiles(clean);
			entry.pendingChooser = null;
		});
	}

	async input(pageId: string, payload: IabInputPayload): Promise<void> {
		await this.withPage(pageId, async ({ page }) => {
			if (payload.kind === "mouse") {
				const button = payload.button ?? "left";
				// 视口/显示缩放变化后，按下与抬起也要使用这次请求的坐标。
				await page.mouse.move(payload.x, payload.y);
				if (payload.action === "down") await page.mouse.down({ button });
				else if (payload.action === "up") await page.mouse.up({ button });
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
		});
	}

	private requirePage(pageId: string): PageEntry {
		const entry = this.pages.get(pageId);
		if (!entry) throw new Error(`页面不存在或已关闭: ${pageId}`);
		return entry;
	}

	private withPage<T>(pageId: string, operation: (entry: PageEntry) => Promise<T>): Promise<T> {
		const entry = this.requirePage(pageId);
		const key = entry.info.sessionId ? `session:${entry.info.sessionId}` : `page:${pageId}`;
		return this.operations.run(key, () => operation(this.requirePage(pageId)));
	}

	// -- agent 工具 -------------------------------------------------------------

	private async agentPage(sessionId: string, pageId?: string): Promise<PageEntry> {
		if (pageId) {
			const entry = this.requirePage(pageId);
			this.claimPage(entry, sessionId);
			return entry;
		}
		const active = this.activePages.get(sessionId);
		let entry = active ? this.pages.get(active) : undefined;
		if (!entry) entry = [...this.pages.values()].find((candidate) => candidate.info.sessionId === sessionId);
		if (!entry) {
			entry = await this.newPage(undefined, sessionId);
		}
		this.claimPage(entry, sessionId);
		return entry;
	}

	/** 工具执行包裹：期间产生的事件标 origin=agent（UI 据此自动开面板）。
	 *  收尾时无条件广播一次页面清单——snapshot/screenshot 这类不改变页面
	 *  清单的操作也要让 UI 知道「agent 在动浏览器」（停靠位切右列等联动）。 */
	private withAgent<T>(sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.operations.run(
			`session:${sessionId}`,
			async () => {
				try {
					return await operation();
				} finally {
					this.emitPages("agent", sessionId);
				}
			},
			signal,
		);
	}

	tools(sessionId: string): ToolDefinition[] {
		if (!sessionId.trim()) throw new Error("浏览器工具必须绑定聊天");
		const pageFields = {
			pageId: Type.Optional(Type.String({ description: "当前聊天拥有的目标页；省略使用本聊天活动页" })),
		};
		const targetFields = {
			ref: Type.Optional(Type.Number({ description: "browser_snapshot 返回的 ref；与 selector 二选一" })),
			selector: Type.Optional(Type.String({ description: "唯一 CSS 选择器；与 ref 二选一" })),
		};
		const text = (value: string) => ({
			content: [{ type: "text" as const, text: value }],
			details: { sessionId, pageId: this.activePages.get(sessionId) },
		});
		const json = (value: object) => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({ sessionId, pageId: this.activePages.get(sessionId), ...value }, null, 2),
				},
			],
			details: { sessionId, pageId: this.activePages.get(sessionId), ...value },
		});
		const bind = (tool: ToolDefinition): ToolDefinition => ({
			...tool,
			execute: (id, params, signal, onUpdate, context) =>
				this.withAgent(sessionId, () => tool.execute(id, params, signal, onUpdate, context), signal),
		});
		const tools: ToolDefinition[] = [
			defineTool({
				name: "browser_navigate",
				label: "浏览器：打开网页",
				description: "在当前聊天的内嵌浏览器打开 URL。导航失败会返回错误；随后用 browser_snapshot 确认页面。",
				promptSnippet: "browser_navigate: 在本聊天浏览器打开 URL",
				parameters: Type.Object({ ...pageFields, url: Type.String({ description: "要打开的 URL" }) }),
				execute: async (_id, params) => {
					const url = normalizeAgentUrl(params.url);
					const entry = await this.agentPage(sessionId, params.pageId);
					try {
						await entry.page.goto(url, { waitUntil: "load", timeout: 20_000 });
					} finally {
						await this.refreshPageMeta(entry);
					}
					return text(
						`已打开 ${entry.info.url}（标题：${entry.info.title || "(无)"}）。用 browser_snapshot 观察页面。`,
					);
				},
			}),
			defineTool({
				name: "browser_snapshot",
				label: "浏览器：读取页面快照",
				description: "读取本聊天页面的元素、状态和 ref。ref 跨导航不复用，元素失效时必须重新观察。",
				promptSnippet: "browser_snapshot: 读取页面元素及状态",
				promptGuidelines: [
					"浏览器操作遵循观察→动作→再观察：先 browser_snapshot，再按 ref 或唯一 selector 操作，然后确认结果。",
					"浏览器工具仅能操作本聊天拥有的页面。页面 ref 失效时重新观察；不要把其他聊天的 pageId 当作当前页面。",
				],
				parameters: Type.Object(pageFields),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					const result = (await entry.page.evaluate(
						SNAPSHOT_SCRIPT.replaceAll("__OWL_REF_SEED__", String(entry.nextRefSeed)),
					)) as {
						url: string;
						title: string;
						lines: string[];
						nextRef: number;
					};
					entry.nextRefSeed = Math.max(entry.nextRefSeed, result.nextRef);
					const chooser = entry.pendingChooser
						? "\n页面等待文件选择；用 browser_set_file_chooser 提供本机路径。"
						: "";
					const truncated =
						result.lines.length >= SNAPSHOT_LIMIT ? `\n(已达 ${SNAPSHOT_LIMIT} 条上限，请缩小页面范围)` : "";
					return text(
						`页面：${result.title}\nURL：${result.url}\n\n${result.lines.join("\n")}${chooser}${truncated}`,
					);
				},
			}),
			defineTool({
				name: "browser_click",
				label: "浏览器：点击元素",
				description: "按 fresh ref 或唯一 selector 点击。检查可见、稳定、未遮挡、未禁用；支持鼠标按钮和双击。",
				promptSnippet: "browser_click: 点击可交互元素",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
					clickCount: Type.Optional(Type.Number({ minimum: 1, maximum: 2 })),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					await entry.interaction.click(params, { button: params.button, clickCount: params.clickCount });
					await sleep(ACTION_SETTLE_MS);
					return text("已点击。用 browser_snapshot 确认页面变化。");
				},
			}),
			defineTool({
				name: "browser_type",
				label: "浏览器：输入文本",
				description: "向可编辑控件输入并读回校验。clear=true 替换；默认追加。结果不返回实际输入文本。",
				promptSnippet: "browser_type: 追加或替换文本并校验",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					text: Type.String(),
					clear: Type.Optional(Type.Boolean()),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					return json(await entry.interaction.fill(params, params.text, { append: params.clear !== true }));
				},
			}),
			defineTool({
				name: "browser_fill",
				label: "浏览器：填写控件",
				description: "替换 input、textarea 或 contenteditable 内容并校验；拒绝禁用、只读控件。填写表单优先使用。",
				promptSnippet: "browser_fill: 填写表单并读回校验",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					text: Type.String(),
					append: Type.Optional(Type.Boolean()),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					return json(await entry.interaction.fill(params, params.text, { append: params.append }));
				},
			}),
			defineTool({
				name: "browser_select",
				label: "浏览器：选择下拉选项",
				description: "按 option 的 value 选择原生 select 并核对选中值。自定义下拉先观察后点击。",
				promptSnippet: "browser_select: 选择原生下拉并校验",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					values: Type.Array(Type.String(), { minItems: 1 }),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					return json(await entry.interaction.selectOptions(params, params.values));
				},
			}),
			defineTool({
				name: "browser_hover",
				label: "浏览器：悬停",
				description: "在可见元素上悬停，触发菜单或提示；随后重新观察。",
				promptSnippet: "browser_hover: 悬停元素",
				parameters: Type.Object({ ...pageFields, ...targetFields }),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					await entry.interaction.hover(params);
					await sleep(ACTION_SETTLE_MS);
					return text("已悬停。用 browser_snapshot 观察菜单或提示。");
				},
			}),
			defineTool({
				name: "browser_focus",
				label: "浏览器：调整焦点",
				description: "聚焦或离开指定控件，触发真实 focus/blur 事件。",
				promptSnippet: "browser_focus: 聚焦或离开控件",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					action: Type.Union([Type.Literal("focus"), Type.Literal("blur")]),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					if (params.action === "focus") await entry.interaction.focus(params);
					else await entry.interaction.blur(params);
					return text(params.action === "focus" ? "已聚焦控件。" : "已离开控件。");
				},
			}),
			defineTool({
				name: "browser_press_key",
				label: "浏览器：按键",
				description: "向本聊天页面当前焦点发送按键；可先指定 ref 或 selector 聚焦目标。",
				promptSnippet: "browser_press_key: 发送按键",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					key: Type.String({ description: "Enter、Escape 或 Control+a 等组合键" }),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					if (params.ref !== undefined || params.selector !== undefined) await entry.interaction.focus(params);
					await entry.page.keyboard.press(params.key);
					await sleep(ACTION_SETTLE_MS);
					return text("已发送按键。用 browser_snapshot 确认结果。");
				},
			}),
			defineTool({
				name: "browser_scroll",
				label: "浏览器：滚动页面或区域",
				description:
					"可按 ref/selector 滚动指定区域；intoView=true 将目标带入视口。也支持旧的 direction/amount 整页滚动。",
				promptSnippet: "browser_scroll: 滚动指定区域或页面",
				parameters: Type.Object({
					...pageFields,
					...targetFields,
					direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
					amount: Type.Optional(Type.Number({ minimum: 1, maximum: 10000 })),
					deltaX: Type.Optional(Type.Number()),
					deltaY: Type.Optional(Type.Number()),
					intoView: Type.Optional(Type.Boolean()),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					const target = params.ref !== undefined || params.selector !== undefined;
					if (params.intoView) {
						if (!target) throw new Error("intoView 需要 ref 或 selector");
						await entry.interaction.scrollIntoView(params);
					} else {
						if (!params.direction && params.deltaX === undefined && params.deltaY === undefined)
							throw new Error("请指定 direction 或滚动 delta");
						const deltaX = params.deltaX ?? 0;
						const deltaY =
							params.deltaY ?? (params.direction === "up" ? -(params.amount ?? 600) : (params.amount ?? 600));
						if (
							!Number.isFinite(deltaX) ||
							!Number.isFinite(deltaY) ||
							Math.abs(deltaX) > 10000 ||
							Math.abs(deltaY) > 10000
						)
							throw new Error("单次滚动范围必须在 -10000 到 10000");
						if (target) await entry.interaction.scroll(params, { deltaX, deltaY });
						else {
							const viewport = entry.page.viewportSize() ?? DEFAULT_VIEWPORT;
							await entry.page.mouse.move(viewport.width / 2, viewport.height / 2);
							await entry.page.mouse.wheel(deltaX, deltaY);
						}
					}
					return text("已滚动。用 browser_snapshot 确认实际位置。");
				},
			}),
			defineTool({
				name: "browser_screenshot",
				label: "浏览器：截图",
				description: "截取本聊天页面的视口并返回图片；日常操作优先 browser_snapshot。",
				promptSnippet: "browser_screenshot: 截取页面",
				parameters: Type.Object(pageFields),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					const buffer = await entry.page.screenshot({ type: "png", caret: "hide" });
					return {
						content: [
							{ type: "text" as const, text: `当前页面截图：${entry.info.url}` },
							{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
						],
						details: { sessionId, pageId: entry.info.pageId },
					};
				},
			}),
			defineTool({
				name: "browser_wait",
				label: "浏览器：等待",
				description: "等待异步内容，上限5000ms；优先通过快照确认状态，避免盲目重复动作。",
				promptSnippet: "browser_wait: 短暂等待页面",
				parameters: Type.Object({ ms: Type.Number({ minimum: 1, maximum: 5000 }) }),
				execute: async (_id, params, signal) => {
					await sleep(Math.min(Math.max(Math.round(params.ms), 1), 5000));
					signal?.throwIfAborted();
					return text("等待结束。用 browser_snapshot 观察。");
				},
			}),
			defineTool({
				name: "browser_console",
				label: "浏览器：控制台消息",
				description: "读取本聊天页面的console和未捕获报错；action=clear清空证据。",
				promptSnippet: "browser_console: 查看页面JS报错",
				parameters: Type.Object({
					...pageFields,
					action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("clear")])),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					if (params.action === "clear") {
						entry.console.length = 0;
						return text("已清空。");
					}
					return text(entry.console.length ? entry.console.slice(-50).join("\n") : "（本页暂无console输出）");
				},
			}),
			defineTool({
				name: "browser_network",
				label: "浏览器：网络诊断",
				description:
					"只读查询请求、状态、耗时和失败。list 默认不读正文；detail 按requestId读取，正文需显式开启，已知秘密字段遮蔽且有大小上限。since 是新请求序号分页，旧请求的状态变化用detail或重新list查询。",
				promptSnippet: "browser_network: 查看接口请求与响应证据",
				parameters: Type.Object({
					...pageFields,
					action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("detail")])),
					requestId: Type.Optional(Type.String()),
					since: Type.Optional(Type.Number({ minimum: 0 })),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
					url: Type.Optional(Type.String()),
					status: Type.Optional(Type.Number({ minimum: 100, maximum: 599 })),
					failed: Type.Optional(Type.Boolean()),
					includeRequestBody: Type.Optional(Type.Boolean()),
					includeResponseBody: Type.Optional(Type.Boolean()),
					maxBodyChars: Type.Optional(Type.Number({ minimum: 1, maximum: 32768 })),
				}),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					if (params.action === "detail") {
						if (!params.requestId) throw new Error("detail需要requestId；先list查找");
						return json(await entry.network.detail(params.requestId, params));
					}
					return json(entry.network.list(params));
				},
			}),
			defineTool({
				name: "browser_set_file_chooser",
				label: "浏览器：应答文件选择框",
				description: "页面等待选择文件时提供本机绝对路径；多选需页面允许。",
				promptSnippet: "browser_set_file_chooser: 应答文件选择",
				parameters: Type.Object({ ...pageFields, paths: Type.Array(Type.String(), { minItems: 1 }) }),
				execute: async (_id, params) => {
					const entry = await this.agentPage(sessionId, params.pageId);
					const pending = entry.pendingChooser;
					if (!pending) throw new Error("页面当前没有等待中的文件选择框");
					const paths = params.paths.map((path) => path.trim()).filter(Boolean);
					if (!paths.length || (!pending.multiple && paths.length > 1))
						throw new Error("文件路径为空或页面只允许单选");
					await pending.chooser.setFiles(paths);
					entry.pendingChooser = null;
					return text(`已提交 ${paths.length} 个文件。用browser_snapshot确认。`);
				},
			}),
			defineTool({
				name: "browser_tabs",
				label: "浏览器：管理标签页",
				description:
					"只列出本聊天拥有的页。new新开、select切换、close关闭；明确pageId可认领未归属的手动页，拒绝其他聊天的页。",
				promptSnippet: "browser_tabs: 管理本聊天标签页",
				parameters: Type.Object({
					action: Type.Union([
						Type.Literal("list"),
						Type.Literal("new"),
						Type.Literal("select"),
						Type.Literal("close"),
					]),
					pageId: Type.Optional(Type.String({ description: "select/close目标页id，支持唯一前缀" })),
					url: Type.Optional(Type.String()),
				}),
				execute: async (_id, params) => {
					if (params.action === "list") return json({ pages: this.listPages(sessionId) });
					if (params.action === "new") {
						const entry = await this.newPage(params.url ? normalizeAgentUrl(params.url) : undefined, sessionId);
						this.claimPage(entry, sessionId);
						return json({ page: this.listPages(sessionId).find((info) => info.pageId === entry.info.pageId) });
					}
					if (!params.pageId) throw new Error("select/close需要pageId；先list查找");
					const matches = [...this.pages.values()].filter((entry) => entry.info.pageId.startsWith(params.pageId!));
					if (matches.length !== 1) throw new Error("pageId不存在或前缀不唯一");
					const entry = await this.agentPage(sessionId, matches[0].info.pageId);
					if (params.action === "select") {
						await this.refreshPageMeta(entry);
						return json({ page: this.listPages(sessionId).find((info) => info.pageId === entry.info.pageId) });
					}
					await entry.page.close();
					return text("已关闭页面。");
				},
			}),
		];
		return tools.map(bind);
	}
}

function normalizeAgentUrl(raw: string): string {
	const url = raw.trim();
	if (!url) throw new Error("缺少 URL");
	const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
	const parsed = new URL(normalized);
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Agent 导航仅支持 HTTP/HTTPS");
	return normalized;
}

const SNAPSHOT_SCRIPT = `
	(() => {
		const refs = ${REF_SETUP};
		for (const [ref, element] of refs.map) if (!element.isConnected) refs.map.delete(ref);
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
				if (type === "file") return "file";
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
			const password = el instanceof HTMLInputElement && el.type === "password";
			const rawName = (el.getAttribute("aria-label") || el.getAttribute("placeholder")
				|| (!password && el instanceof HTMLElement ? el.value : "") || el.textContent || "")
				.trim().replace(/\\s+/g, " ").slice(0, 80);
			// 纯文本容器（p/li/td/th/heading）没字就不占行
			if (!rawName && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) continue;
			let extra = "";
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				if (el.value) extra = password ? " [已填写]" : \` 值="\${String(el.value).slice(0, 60)}"\`;
				if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)) {
					extra += el.checked ? " [已选]" : " [未选]";
				}
			}
			if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") extra += " [已禁用]";
			if (el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true") extra += " [只读]";
			lines.push(\`[ref=\${ref}] \${role}\${rawName ? \` "\${rawName}"\` : ""}\${extra}\`);
		}
		return { url: location.href, title: document.title, lines, nextRef: refs.next };
	})()
`;
