import { expect, it } from "vitest";
import { interruptDesktopControl, subscribeDesktopControlInterruption } from "../src/core/desktop-control-channel.ts";

it("delivers user takeover to each session and unsubscribes a disposed session", () => {
	const received: string[] = [];
	const first = subscribeDesktopControlInterruption((event) => received.push(`first:${event.windowId}`));
	const second = subscribeDesktopControlInterruption((event) => received.push(`second:${event.windowId}`));
	try {
		interruptDesktopControl({ reason: "user-projection-input", windowId: "12" });
		first();
		interruptDesktopControl({ reason: "user-projection-input", windowId: "13" });
		expect(received).toEqual(["first:12", "second:12", "second:13"]);
	} finally {
		first();
		second();
	}
});
