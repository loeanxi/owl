import type {
	DesktopClientRequestWithoutId,
	DesktopServerMessage,
	IabServerMessage,
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
export type QuestionHandler = (request: QuestionRequest) => void;
export type TermMessage = TermDataMessage | TermExitMessage;
export type TermMessageHandler = (message: TermMessage) => void;
export type IabMessageHandler = (message: IabServerMessage) => void;
export type SidebarOpenHandler = (message: SidebarOpenMessage) => void;
export type ViewerChangedHandler = (message: ViewerChangedMessage) => void;

type Pending = { resolve: (value: any) => void };

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
	private sidebarOpenHandlers = new Set<SidebarOpenHandler>();
	private viewerChangedHandlers = new Set<ViewerChangedHandler>();
	private statusHandlers = new Set<(connected: boolean) => void>();
	private url: string;
	private closedByUser = false;

	constructor(url = `ws://${location.host}/ws`) {
		this.url = url;
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
			const message = JSON.parse(String(event.data)) as DesktopServerMessage;
			if (message.type === "response") {
				const pending = this.pending.get(message.id);
				if (pending) {
					this.pending.delete(message.id);
					pending.resolve(message);
				}
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
			if (message.type === "sidebar.open") {
				for (const handler of this.sidebarOpenHandlers) handler(message);
				return;
			}
			if (message.type === "viewer.changed") {
				for (const handler of this.viewerChangedHandlers) handler(message);
			}
		};
		ws.onclose = () => {
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
			this.pending.set(id, { resolve });
			this.ws.send(JSON.stringify({ ...request, id }));
		});
	}

	respondPermission(requestId: string, approved: boolean): void {
		void this.request({ type: "permission.response", requestId, approved });
	}

	/** 应答 agent 的提问；cancelled=true 表示用户放弃整份问卷。 */
	respondQuestion(requestId: string, answers: QuestionAnswerPayload[], cancelled = false): void {
		void this.request({ type: "question.response", requestId, answers, ...(cancelled ? { cancelled: true } : {}) });
	}
}
