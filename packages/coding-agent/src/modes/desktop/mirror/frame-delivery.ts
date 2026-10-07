import type { MirrorFrameMessage } from "../protocol.ts";

export interface MirrorFrameSocket {
	readonly OPEN: number;
	readonly readyState: number;
	send(payload: string, callback: (error?: Error) => void): void;
}

interface FramePacket {
	message: MirrorFrameMessage;
	payload?: string;
}

interface FrameSlot {
	subscribed: boolean;
	inFlight: boolean;
	pending?: FramePacket;
}

/** Video may lose intermediate frames; control replies continue using the socket directly. */
export class MirrorFrameDelivery {
	private readonly clients = new Map<MirrorFrameSocket, Map<string, FrameSlot>>();

	subscribe(client: MirrorFrameSocket, windowId: string): void {
		const windows = this.clients.get(client) ?? new Map<string, FrameSlot>();
		const slot = windows.get(windowId) ?? { subscribed: false, inFlight: false };
		slot.subscribed = true;
		windows.set(windowId, slot);
		this.clients.set(client, windows);
	}

	unsubscribe(client: MirrorFrameSocket, windowId: string): void {
		const windows = this.clients.get(client);
		const slot = windows?.get(windowId);
		if (!slot) return;
		slot.subscribed = false;
		slot.pending = undefined;
		// Keep the in-flight marker across a quick detach/reattach of the same source.
		if (!slot.inFlight) windows?.delete(windowId);
		if (windows?.size === 0) this.clients.delete(client);
	}

	disconnect(client: MirrorFrameSocket): void {
		this.clients.delete(client);
	}

	publish(message: MirrorFrameMessage): void {
		const packet: FramePacket = { message };
		for (const [client, windows] of this.clients) {
			if (client.readyState !== client.OPEN) {
				this.disconnect(client);
				continue;
			}
			const slot = windows.get(message.windowId);
			if (!slot?.subscribed) continue;
			if (slot.inFlight) slot.pending = packet;
			else this.send(client, message.windowId, slot, packet);
		}
	}

	private send(client: MirrorFrameSocket, windowId: string, slot: FrameSlot, packet: FramePacket): void {
		slot.inFlight = true;
		slot.pending = undefined;
		// One encoding is shared when several clients receive the same frame.
		packet.payload ??= JSON.stringify(packet.message);
		const finished = (error?: Error): void => {
			const windows = this.clients.get(client);
			if (windows?.get(windowId) !== slot) return;
			slot.inFlight = false;
			if (!slot.subscribed) {
				windows.delete(windowId);
				if (windows.size === 0) this.clients.delete(client);
				return;
			}
			if (client.readyState !== client.OPEN) {
				this.disconnect(client);
				return;
			}
			if (error) slot.pending = undefined;
			else if (slot.pending) this.send(client, windowId, slot, slot.pending);
		};
		try {
			client.send(packet.payload, finished);
		} catch (error) {
			finished(error instanceof Error ? error : new Error(String(error)));
		}
	}
}
