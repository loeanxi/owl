import type {
	DesktopClientRequestWithoutId,
	DesktopServerMessage,
	DiffApprovalChangedMessage,
	IabServerMessage,
	MirrorServerMessage,
	MailAgentDraftMessage,
	MapResultsMessage,
	NewsOpenMessage,
	PermissionRequestMessage,
	QuestionAnswerPayload,
	QuestionRequestMessage,
	ServerEventMessage,
	SidebarOpenMessage,
	TermDataMessage,
	TermExitMessage,
	ViewerChangedMessage,
} from "./protocol.ts";

export type PermissionRequest = PermissionRequestMessage;
export type QuestionRequest = QuestionRequestMessage;
export type SessionEventHandler = (event: ServerEventMessage) => void;
export type PermissionHandler = (request: PermissionRequest) => void;
/** 自动化任务有变化（创建/开关/到点投递/删除）时的无参通知。 */
export type ScheduleChangedHandler = () => void;
export type QuestionHandler = (request: QuestionRequest) => void;
export type TermMessage = TermDataMessage | TermExitMessage;
export type TermMessageHandler = (message: TermMessage) => void;
export type IabMessageHandler = (message: IabServerMessage) => void;
export type MirrorMessageHandler = (message: MirrorServerMessage) => void;
export type SidebarOpenHandler = (message: SidebarOpenMessage) => void;
export type ViewerChangedHandler = (message: ViewerChangedMessage) => void;
export type NewsOpenHandler = (message: NewsOpenMessage) => void;
export type MailDraftHandler = (message: MailAgentDraftMessage) => void;
export type MapResultsHandler = (message: MapResultsMessage) => void;
export type DiffApprovalChangedHandler = (message: DiffApprovalChangedMessage) => void;

/** Malformed wire payloads must not interrupt the desktop message stream. */
function decodeServerMessage(data: unknown): DesktopServerMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(String(data));
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const message = value as Record<string, unknown>;
	if (typeof message.type !== "string") return undefined;
	if (message.type === "map.results") {
		if (
			typeof message.sessionId !== "string" ||
			!message.sessionId ||
			!message.update ||
			typeof message.update !== "object"
		)
			return undefined;
		const update = message.update as Record<string, unknown>;
		if (update.action !== "search" && update.action !== "nearby" && update.action !== "reverse") return undefined;
		if (!update.result || typeof update.result !== "object") return undefined;
		const result = update.result as Record<string, unknown>;
		if (!Array.isArray(result.data) || !Array.isArray(result.sources)) return undefined;
		if (update.center !== undefined) {
			if (!update.center || typeof update.center !== "object") return undefined;
			const center = update.center as Record<string, unknown>;
			if (
				typeof center.lat !== "number" ||
				!Number.isFinite(center.lat) ||
				Math.abs(center.lat) > 90 ||
				typeof center.lng !== "number" ||
				!Number.isFinite(center.lng) ||
				Math.abs(center.lng) > 180
			)
				return undefined;
		}
	}
	if (message.type === "mail.agent.draft") {
		if (typeof message.sessionId !== "string" || !message.sessionId || !message.draft || typeof message.draft !== "object") return undefined;
		const draft = message.draft as Record<string, unknown>;
		if (["accountId", "to", "subject", "body"].some((key) => typeof draft[key] !== "string")) return undefined;
		if (["id", "threadId", "cc", "bcc", "inReplyTo", "references"].some((key) => draft[key] !== undefined && typeof draft[key] !== "string")) return undefined;
	}
	return value as DesktopServerMessage;
}

type Pending = {
	resolve: (value: { ok: boolean; result?: unknown; error?: string }) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
};

/**
 * Typed WebSocket client for the owl desktop bridge.
 * Auto-reconnects; event/permission handlers survive reconnects.
 */
export class BridgeClient {
	private ws: WebSocket | undefined;
	private seq = 0;
	private pending = new Map<string, Pending>();
	private sessionHandlers = new Set<SessionEventHandler>();
	private permissionHandlers = new Set<PermissionHandler>();
	private questionHandlers = new Set<QuestionHandler>();
	private termHandlers = new Set<TermMessageHandler>();
	private iabHandlers = new Set<IabMessageHandler>();
	private mirrorHandlers = new Set<MirrorMessageHandler>();
	private sidebarOpenHandlers = new Set<SidebarOpenHandler>();
	private viewerChangedHandlers = new Set<ViewerChangedHandler>();
	private newsOpenHandlers = new Set<NewsOpenHandler>();
	private mailDraftHandlers = new Set<MailDraftHandler>();
	private mapResultsHandlers = new Set<MapResultsHandler>();
	private diffApprovalHandlers = new Set<DiffApprovalChangedHandler>();
	private scheduleChangedHandlers = new Set<() => void>();
	private statusHandlers = new Set<(connected: boolean) => void>();
	private url: string;
	private closedByUser = false;

	constructor(url?: string) {
		const host = (globalThis as { location?: { host: string } }).location?.host;
		if (!url && !host) throw new Error("A bridge URL is required outside the desktop browser.");
		this.url = url ?? `ws://${host}/ws`;
	}

	connect(): void {
		if (this.ws && (this.ws.readyState === this.ws.CONNECTING || this.ws.readyState === this.ws.OPEN)) {
			return;
		}
		this.closedByUser = false;
		const ws = new WebSocket(this.url);
		this.ws = ws;
		ws.onopen = () => {
			for (const handler of this.statusHandlers) handler(true);
		};
		ws.onmessage = (event) => {
			const message = decodeServerMessage(event.data);
			if (!message) return;
			if (message.type === "mail.agent.draft") {
				for (const handler of this.mailDraftHandlers) handler(message);
				return;
			}
			if (message.type === "map.results") {
				for (const handler of this.mapResultsHandlers) handler(message);
				return;
			}
			if (message.type === "response") {
				const pending = this.pending.get(message.id);
				if (pending) {
					this.pending.delete(message.id);
					if (pending.timer) clearTimeout(pending.timer);
					pending.resolve(message);
				}
				return;
			}
			if (message.type === "news.open") {
				for (const handler of this.newsOpenHandlers) handler(message);
				return;
			}
			if (message.type === "event") {
				for (const handler of this.sessionHandlers) handler(message);
				return;
			}
			if (message.type === "permission_request") {
				for (const handler of this.permissionHandlers) handler(message);
				return;
			}
			if (message.type === "question_request") {
				for (const handler of this.questionHandlers) handler(message);
				return;
			}
			if (message.type === "term.data" || message.type === "term.exit") {
				for (const handler of this.termHandlers) handler(message);
				return;
			}
			if (message.type === "iab.frame" || message.type === "iab.pages" || message.type === "iab.filechooser") {
				for (const handler of this.iabHandlers) handler(message);
				return;
			}
			if (message.type === "mirror.frame" || message.type === "mirror.windows") {
				for (const handler of this.mirrorHandlers) handler(message);
				return;
			}
			if (message.type === "sidebar.open") {
				for (const handler of this.sidebarOpenHandlers) handler(message);
				return;
			}
			if (message.type === "viewer.changed") {
				for (const handler of this.viewerChangedHandlers) handler(message);
				return;
			}
			if (message.type === "schedule.changed") {
				for (const handler of this.scheduleChangedHandlers) handler();
				return;
			}
			if (message.type === "diffApproval.changed") {
				for (const handler of this.diffApprovalHandlers) handler(message);
			}
		};
		ws.onclose = () => {
			for (const pending of this.pending.values()) {
				if (pending.timer) clearTimeout(pending.timer);
				pending.reject(new Error("bridge disconnected"));
			}
			this.pending.clear();
			for (const handler of this.statusHandlers) handler(false);
			if (!this.closedByUser) {
				setTimeout(() => this.connect(), 1500);
			}
		};
	}

	disconnect(): void {
		this.closedByUser = true;
		this.ws?.close();
	}

	onSessionEvent(handler: SessionEventHandler): () => void {
		this.sessionHandlers.add(handler);
		return () => this.sessionHandlers.delete(handler);
	}

	onPermissionRequest(handler: PermissionHandler): () => void {
		this.permissionHandlers.add(handler);
		return () => this.permissionHandlers.delete(handler);
	}

	onQuestionRequest(handler: QuestionHandler): () => void {
		this.questionHandlers.add(handler);
		return () => this.questionHandlers.delete(handler);
	}

	/** 终端输出/退出（每个 TerminalTab 按 termId 过滤自己的流）。 */
	onTermMessage(handler: TermMessageHandler): () => void {
		this.termHandlers.add(handler);
		return () => this.termHandlers.delete(handler);
	}

	/** 内嵌浏览器帧流/页面清单（BrowserTab 按 pageId 过滤；App 监听 agent 触发的开页）。 */
	onIabMessage(handler: IabMessageHandler): () => void {
		this.iabHandlers.add(handler);
		return () => this.iabHandlers.delete(handler);
	}

	/** 窗口镜像帧流/清单（MirrorTab 按 windowId 过滤）。 */
	onMirrorMessage(handler: MirrorMessageHandler): () => void {
		this.mirrorHandlers.add(handler);
		return () => this.mirrorHandlers.delete(handler);
	}

	/** sidebar_open 工具广播：模型请求在侧边工作台打开文件（App 决定开哪种 viewer）。 */
	onSidebarMessage(handler: SidebarOpenHandler): () => void {
		this.sidebarOpenHandlers.add(handler);
		return () => this.sidebarOpenHandlers.delete(handler);
	}

	onStatus(handler: (connected: boolean) => void): () => void {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
	}

	onViewersChanged(handler: ViewerChangedHandler): () => void {
		this.viewerChangedHandlers.add(handler);
		return () => this.viewerChangedHandlers.delete(handler);
	}

	onNewsOpen(handler: NewsOpenHandler): () => void {
		this.newsOpenHandlers.add(handler);
		return () => this.newsOpenHandlers.delete(handler);
	}

	/** 改动审批清单变化（owl-diff-approval 插件落库/处理后的服务端推送）。 */
	onDiffApprovalChanged(handler: DiffApprovalChangedHandler): () => void {
		this.diffApprovalHandlers.add(handler);
		return () => this.diffApprovalHandlers.delete(handler);
	}

	/** 自动化任务有变化（创建/开关/到点投递/删除）时的服务端推送。 */
	onScheduleChanged(handler: ScheduleChangedHandler): () => void {
		this.scheduleChangedHandlers.add(handler);
		return () => this.scheduleChangedHandlers.delete(handler);
	}

	onMailDraft(handler: MailDraftHandler): () => void {
		this.mailDraftHandlers.add(handler);
		return () => this.mailDraftHandlers.delete(handler);
	}

	onMapResults(handler: MapResultsHandler): () => void {
		this.mapResultsHandlers.add(handler);
		return () => this.mapResultsHandlers.delete(handler);
	}

	request<T = unknown>(request: DesktopClientRequestWithoutId & { id?: string }): Promise<{
		ok: boolean;
		result?: T;
		error?: string;
	}> {
		const id = request.id ?? `req-${++this.seq}`;
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
				reject(new Error("bridge not connected"));
				return;
			}
			const pending: Pending = {
				resolve: (value) => resolve({ ...value, result: value.result as T }),
				reject,
			};
			if (request.type === "news.request") {
				const timeout = request.request.action === "evaluate" ? 30 * 60_000 : 5 * 60_000;
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error("news request timed out"));
				}, timeout);
			}
			if (request.type === "mail.request" || request.type === "mail.agent.start") {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error("邮箱请求超时，请重试"));
				}, 120_000);
			}
			// 分支是快操作：旧桥不认识 session.fork 也不回包，不设超时 UI 就永远没反应
			if (request.type === "session.fork") {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error('分支请求超时：桥可能是旧版本，请重启应用后重试'));
				}, 15_000);
			}
			// 导出同理：旧桥不认识 session.exportLog 也不回包，不设超时菜单点了就没任何反馈
			if (request.type === "session.exportLog") {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error('导出请求超时：桥可能是旧版本，请重启应用后重试'));
				}, 30_000);
			}
			if (request.type === "evaluation.request") {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error("Model evaluation request timed out"));
				}, 60_000);
			}
			// 改动审批都是快查询/快操作：不设超时的话，桥假死（已连不回包）会让
			// 审查面板永远停在「读取中」
			if (request.type.startsWith("diffApproval.")) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error("Review request timed out"));
				}, 15_000);
			}
			// 其余门控 UI 的快请求统一兜底：session.prompt 的应答是立即 ack（真正的
			// 回答走事件流），session.resume 要回放整份转录所以放宽到 30s。桥假死时
			// 没有这层超时，composer 的 submitting / 会话切换会永久卡住。
			const fallbackTimeout =
				request.type === "session.resume" ? 30_000
				: ["session.create", "session.prompt", "session.stats", "session.running", "session.turns", "models.list"].includes(request.type)
					? 15_000
					: undefined;
			if (fallbackTimeout !== undefined) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error("请求超时，请重试（桥可能无响应）"));
				}, fallbackTimeout);
			}
			this.pending.set(id, pending);
			this.ws.send(JSON.stringify({ ...request, id }));
		});
	}

	respondPermission(requestId: string, approved: boolean): Promise<{ ok: boolean; error?: string }> {
		// 先挂 no-op catch 标记拒绝已处理（断线时 ResearchPage 这类不观察结果的
		// 调用点不会冒 unhandled rejection），再返回原 promise 给需要做失败恢复
		// （回滚出队）的调用方
		const pending = this.request({ type: "permission.response", requestId, approved });
		pending.catch(() => {});
		return pending;
	}

	/** 应答 agent 的提问；cancelled=true 表示用户放弃整份问卷。失败恢复同 respondPermission。 */
	respondQuestion(requestId: string, answers: QuestionAnswerPayload[], cancelled = false): Promise<{ ok: boolean; error?: string }> {
		const pending = this.request({ type: "question.response", requestId, answers, ...(cancelled ? { cancelled: true } : {}) });
		pending.catch(() => {});
		return pending;
	}
}
