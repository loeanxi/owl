/**
 * 帧流投递：按 (连接, 来源) 记账，只保留最新一帧。
 *
 * 浏览器 WebSocket 没有向服务端反压的机制：界面卡住时，桥的发送缓冲会无限涨。
 * 这里给每个 (连接, 来源) 一个在途槽——在途时新帧只覆盖 pending 槽，不排队，
 * 于是缓冲有界，视图又总能追上最新状态。代价是中间帧可能丢，这正是视频流该有的
 * 取舍。
 */

export interface FrameSocket {
	readonly OPEN: number;
	readonly readyState: number;
	send(payload: string, callback: (error?: Error) => void): void;
}

interface FrameSlot<TMessage> {
	subscribed: boolean;
	inFlight: boolean;
	pending?: FramePacket<TMessage>;
}

interface FramePacket<TMessage> {
	message: TMessage;
	payload?: string;
}

export class FrameDelivery<TMessage> {
	private readonly clients = new Map<FrameSocket, Map<string, FrameSlot<TMessage>>>();
	private readonly sourceOf: (message: TMessage) => string;

	constructor(sourceOf: (message: TMessage) => string) {
		this.sourceOf = sourceOf;
	}

	subscribe(client: FrameSocket, source: string): void {
		const sources = this.clients.get(client) ?? new Map<string, FrameSlot<TMessage>>();
		const slot = sources.get(source) ?? { subscribed: false, inFlight: false };
		slot.subscribed = true;
		sources.set(source, slot);
		this.clients.set(client, sources);
	}

	unsubscribe(client: FrameSocket, source: string): void {
		const sources = this.clients.get(client);
		const slot = sources?.get(source);
		if (!slot) return;
		slot.subscribed = false;
		slot.pending = undefined;
		// Keep the in-flight marker across a quick detach/reattach of the same source.
		if (!slot.inFlight) sources?.delete(source);
		if (sources?.size === 0) this.clients.delete(client);
	}

	disconnect(client: FrameSocket): void {
		this.clients.delete(client);
	}

	publish(message: TMessage): void {
		const packet: FramePacket<TMessage> = { message };
		for (const [client, sources] of this.clients) {
			if (client.readyState !== client.OPEN) {
				this.disconnect(client);
				continue;
			}
			const slot = sources.get(this.sourceOf(message));
			if (!slot?.subscribed) continue;
			if (slot.inFlight) slot.pending = packet;
			else this.send(client, this.sourceOf(message), slot, packet);
		}
	}

	private send(client: FrameSocket, source: string, slot: FrameSlot<TMessage>, packet: FramePacket<TMessage>): void {
		slot.inFlight = true;
		slot.pending = undefined;
		// One encoding is shared when several clients receive the same frame.
		packet.payload ??= JSON.stringify(packet.message);
		const finished = (error?: Error): void => {
			const sources = this.clients.get(client);
			if (sources?.get(source) !== slot) return;
			slot.inFlight = false;
			if (!slot.subscribed) {
				sources.delete(source);
				if (sources.size === 0) this.clients.delete(client);
				return;
			}
			if (client.readyState !== client.OPEN) {
				this.disconnect(client);
				return;
			}
			if (error) slot.pending = undefined;
			else if (slot.pending) this.send(client, source, slot, slot.pending);
		};
		try {
			client.send(packet.payload, finished);
		} catch (error) {
			finished(error instanceof Error ? error : new Error(String(error)));
		}
	}
}
