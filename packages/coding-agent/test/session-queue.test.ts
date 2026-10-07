import { describe, expect, it } from "vitest";
import { SessionQueueTracker } from "../src/core/session-queue.ts";

describe("SessionQueueTracker", () => {
	it("removes one queued line and promotes a follow-up into steering", () => {
		const events: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		const queue = new SessionQueueTracker({
			emit: (event) => {
				if (event.type === "queue_update") events.push({ steering: event.steering, followUp: event.followUp });
			},
		});
		queue.pushFollowUp("先看日志");
		queue.pushFollowUp("再写成表格");
		expect(queue.removeAt("followUp", 0)).toBe("先看日志");
		expect(queue.followUp).toEqual(["再写成表格"]);
		expect(queue.moveFollowUpToSteering(0)).toBe("再写成表格");
		expect(queue.steering).toEqual(["再写成表格"]);
		expect(queue.followUp).toEqual([]);
		expect(events.at(-1)).toEqual({ steering: ["再写成表格"], followUp: [] });
	});
});
