import { describe, expect, it, vi } from "vitest";
import { MirrorFrameDelivery, type MirrorFrameSocket } from "../src/modes/desktop/mirror/frame-delivery.ts";
import type { MirrorFrameMessage } from "../src/modes/desktop/protocol.ts";

class SlowSocket implements MirrorFrameSocket {
	readonly OPEN = 1;
	readyState = 1;
	bufferedAmount = 0;
	readonly sent: MirrorFrameMessage[] = [];
	readonly callbacks: ((error?: Error) => void)[] = [];
	send(payload: string, callback: (error?: Error) => void): void {
		this.bufferedAmount += payload.length;
		this.sent.push(JSON.parse(payload) as MirrorFrameMessage);
		this.callbacks.push(callback);
	}
	complete(error?: Error): void {
		this.bufferedAmount = 0;
		this.callbacks.shift()?.(error);
	}
}
function frame(sequence: number, windowId = "123"): MirrorFrameMessage {
	return { type: "mirror.frame", windowId, data: `frame-${sequence}`, width: 906, height: 547 };
}

describe("mirror frame delivery", () => {
	it("keeps one in-flight frame and replaces stale pending frames under slow transport", () => {
		const delivery = new MirrorFrameDelivery();
		const socket = new SlowSocket();
		delivery.subscribe(socket, "123");
		for (let index = 1; index <= 100; index++) delivery.publish(frame(index));
		expect(socket.sent.map((message) => message.data)).toEqual(["frame-1"]);
		socket.complete();
		expect(socket.sent.map((message) => message.data)).toEqual(["frame-1", "frame-100"]);
		socket.complete();
		expect(socket.callbacks).toHaveLength(0);
	});

	it("does not serialize frames without a recipient and shares encoding across recipients", () => {
		const delivery = new MirrorFrameDelivery();
		const stringify = vi.spyOn(JSON, "stringify");
		try {
			delivery.publish(frame(1));
			expect(stringify).not.toHaveBeenCalled();
			delivery.subscribe(new SlowSocket(), "123");
			delivery.subscribe(new SlowSocket(), "123");
			delivery.publish(frame(2));
			expect(stringify).toHaveBeenCalledTimes(1);
		} finally {
			stringify.mockRestore();
		}
	});

	it("isolates slow clients and independent source windows", () => {
		const delivery = new MirrorFrameDelivery();
		const slow = new SlowSocket();
		const fast = new SlowSocket();
		delivery.subscribe(slow, "123");
		delivery.subscribe(slow, "456");
		delivery.subscribe(fast, "123");
		delivery.publish(frame(1));
		fast.complete();
		delivery.publish(frame(2));
		delivery.publish(frame(3, "456"));
		expect(fast.sent.map((message) => message.data)).toEqual(["frame-1", "frame-2"]);
		expect(slow.sent.map((message) => message.data)).toEqual(["frame-1", "frame-3"]);
	});

	it("does not flush old pending frames after detach, reattach or disconnect", () => {
		const delivery = new MirrorFrameDelivery();
		const socket = new SlowSocket();
		delivery.subscribe(socket, "123");
		delivery.publish(frame(1));
		delivery.publish(frame(2));
		delivery.unsubscribe(socket, "123");
		delivery.subscribe(socket, "123");
		delivery.publish(frame(3));
		socket.complete();
		expect(socket.sent.map((message) => message.data)).toEqual(["frame-1", "frame-3"]);
		delivery.publish(frame(4));
		delivery.disconnect(socket);
		socket.complete();
		expect(socket.sent.map((message) => message.data)).toEqual(["frame-1", "frame-3"]);
	});

	it("drops pending video after send errors without blocking a future frame", () => {
		const delivery = new MirrorFrameDelivery();
		const socket = new SlowSocket();
		delivery.subscribe(socket, "123");
		delivery.publish(frame(1));
		delivery.publish(frame(2));
		socket.complete(new Error("send failed"));
		delivery.publish(frame(3));
		expect(socket.sent.map((message) => message.data)).toEqual(["frame-1", "frame-3"]);
	});

	it("keeps control replies ahead of the replacement video frame", () => {
		const delivery = new MirrorFrameDelivery();
		const socket = new SlowSocket();
		delivery.subscribe(socket, "123");
		for (let index = 1; index <= 100; index++) delivery.publish(frame(index));
		socket.send(JSON.stringify({ type: "response", id: "input-ack", ok: true }), () => {});
		expect(socket.sent).toHaveLength(2);
		expect(socket.sent[1]).toMatchObject({ type: "response", id: "input-ack" });
		socket.complete();
		expect(socket.sent[2]).toMatchObject({ type: "mirror.frame", data: "frame-100" });
	});
});
