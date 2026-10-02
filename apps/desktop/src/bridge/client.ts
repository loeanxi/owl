import type {
	DesktopClientRequestWithoutId,
	DesktopServerMessage,
	PermissionRequestMessage,
	ServerEventMessage,
} from "./protocol.ts";

export type PermissionRequest = PermissionRequestMessage;
export type SessionEventHandler = (event: ServerEventMessage) => void;
export type PermissionHandler = (request: PermissionRequest) => void;

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

	onStatus(handler: (connected: boolean) => void): () => void {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
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
}
