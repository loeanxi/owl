/**
 * 桌面桥事件扇出：按连接订阅会话，高频 text/thinking delta 只发给订阅方；
 * 同一会话连续 delta 在短窗内合并，降低 WebSocket 与 JSON.stringify 压力。
 */

import type { WebSocket } from "ws";
import type { DesktopServerMessage, ServerEventMessage } from "./protocol.ts";

const DEFAULT_DELTA_COALESCE_MS = 24;

type EventSubscription = "all" | Set<string>;

export type EventFanoutSend = (ws: WebSocket, payload: string) => void;

export class DesktopEventFanout {
	private readonly subscriptions = new WeakMap<WebSocket, EventSubscription>();
	private readonly deltaBuffers = new Map<
		string,
		{ message: ServerEventMessage; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly coalesceMs: number;
	private readonly send: EventFanoutSend;
	private readonly clients: () => Iterable<WebSocket>;

	constructor(options: { clients: () => Iterable<WebSocket>; send: EventFanoutSend; coalesceMs?: number }) {
		this.clients = options.clients;
		this.send = options.send;
		this.coalesceMs =
			typeof options.coalesceMs === "number" && Number.isFinite(options.coalesceMs) && options.coalesceMs >= 0
				? options.coalesceMs
				: DEFAULT_DELTA_COALESCE_MS;
	}

	/** 未订阅视为 all（旧 UI / 未发 events.subscribe 时兼容）。 */
	subscribe(ws: WebSocket, sessionIds: readonly string[] | "all"): void {
		if (sessionIds === "all") {
			this.subscriptions.set(ws, "all");
			return;
		}
		this.subscriptions.set(ws, new Set(sessionIds.filter((id) => typeof id === "string" && id.length > 0)));
	}

	disconnect(ws: WebSocket): void {
		this.subscriptions.delete(ws);
	}

	/** 广播非 session event 消息（权限、IAB 清单等）。 */
	broadcast(message: DesktopServerMessage): void {
		if (message.type === "event") {
			this.publishEvent(message);
			return;
		}
		const payload = JSON.stringify(message);
		for (const client of this.clients()) {
			if (client.readyState === client.OPEN) this.send(client, payload);
		}
	}

	publishEvent(message: ServerEventMessage): void {
		const updateType = assistantUpdateType(message);
		if ((updateType === "text_delta" || updateType === "thinking_delta") && this.coalesceMs > 0) {
			this.bufferDelta(message, updateType);
			return;
		}
		this.flushSessionDeltas(message.sessionId);
		this.deliver(message);
	}

	flushAll(): void {
		for (const sessionId of [...this.deltaBuffers.keys()]) this.flushSessionDeltas(sessionId);
	}

	private bufferDelta(message: ServerEventMessage, updateType: "text_delta" | "thinking_delta"): void {
		const key = `${message.sessionId}:${updateType}:${contentIndexOf(message)}`;
		const existing = this.deltaBuffers.get(key);
		if (existing) {
			existing.message = mergeDeltaMessages(existing.message, message);
			return;
		}
		const timer = setTimeout(() => {
			const buffered = this.deltaBuffers.get(key);
			if (!buffered) return;
			this.deltaBuffers.delete(key);
			this.deliver(buffered.message);
		}, this.coalesceMs);
		this.deltaBuffers.set(key, { message, timer });
	}

	private flushSessionDeltas(sessionId: string): void {
		for (const [key, buffered] of this.deltaBuffers) {
			if (!key.startsWith(`${sessionId}:`)) continue;
			clearTimeout(buffered.timer);
			this.deltaBuffers.delete(key);
			this.deliver(buffered.message);
		}
	}

	private deliver(message: ServerEventMessage): void {
		const payload = JSON.stringify(message);
		for (const client of this.clients()) {
			if (client.readyState !== client.OPEN) continue;
			if (!this.shouldDeliver(client, message)) continue;
			this.send(client, payload);
		}
	}

	private shouldDeliver(client: WebSocket, message: ServerEventMessage): boolean {
		const sub = this.subscriptions.get(client) ?? "all";
		if (sub === "all" || sub.has(message.sessionId)) return true;
		// 未订阅会话仍收生命周期与工具步进，供侧栏绿点 / noteStep；过滤高频正文 delta。
		const updateType = assistantUpdateType(message);
		return updateType !== "text_delta" && updateType !== "thinking_delta";
	}
}

function assistantUpdateType(message: ServerEventMessage): string | undefined {
	const event = message.event as { type?: string; assistantMessageEvent?: { type?: string } } | undefined;
	if (event?.type !== "message_update") return undefined;
	return event.assistantMessageEvent?.type;
}

function contentIndexOf(message: ServerEventMessage): number {
	const event = message.event as { assistantMessageEvent?: { contentIndex?: number } } | undefined;
	const index = event?.assistantMessageEvent?.contentIndex;
	return typeof index === "number" && Number.isFinite(index) ? index : 0;
}

function mergeDeltaMessages(previous: ServerEventMessage, next: ServerEventMessage): ServerEventMessage {
	const prevEvent = previous.event as {
		type: string;
		assistantMessageEvent?: { type?: string; delta?: string; contentIndex?: number; [key: string]: unknown };
		[key: string]: unknown;
	};
	const nextEvent = next.event as {
		type: string;
		assistantMessageEvent?: { type?: string; delta?: string; contentIndex?: number; [key: string]: unknown };
		[key: string]: unknown;
	};
	const prevDelta = prevEvent.assistantMessageEvent;
	const nextDelta = nextEvent.assistantMessageEvent;
	if (!prevDelta || !nextDelta) return next;
	return {
		...next,
		event: {
			...nextEvent,
			assistantMessageEvent: {
				...nextDelta,
				delta: `${typeof prevDelta.delta === "string" ? prevDelta.delta : ""}${typeof nextDelta.delta === "string" ? nextDelta.delta : ""}`,
			},
		},
	};
}
