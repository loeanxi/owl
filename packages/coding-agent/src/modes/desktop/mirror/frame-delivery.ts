import { FrameDelivery, type FrameSocket } from "../frame-delivery.ts";
import type { MirrorFrameMessage } from "../protocol.ts";

export type MirrorFrameSocket = FrameSocket;

/** Video may lose intermediate frames; control replies continue using the socket directly. */
export class MirrorFrameDelivery extends FrameDelivery<MirrorFrameMessage> {
	constructor() {
		super((message) => message.windowId);
	}
}
