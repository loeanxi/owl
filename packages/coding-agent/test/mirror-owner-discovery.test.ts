import { describe, expect, it, vi } from "vitest";
import { MirrorHub } from "../src/modes/desktop/mirror-hub.ts";
import type { MirrorWindowInfo } from "../src/modes/desktop/protocol.ts";

const minimized: MirrorWindowInfo = {
	windowId: "123",
	title: "owl",
	process: "owl-desktop",
	hongguo: false,
	minimized: true,
	width: 353,
	height: 39,
};

describe("mirror owner discovery", () => {
	it("keeps a minimized Owl as the owner so its watcher can resume the source", async () => {
		const hub = new MirrorHub({ onFrame: () => {}, onWindowsChanged: () => {} });
		const list = vi.spyOn(hub, "listWindows").mockResolvedValue([minimized]);
		expect(await hub.findOwlParentHwnd()).toBe(123);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("prefers a visible host and reuses an already enumerated snapshot", async () => {
		const hub = new MirrorHub({ onFrame: () => {}, onWindowsChanged: () => {} });
		const list = vi.spyOn(hub, "listWindows");
		expect(await hub.findOwlParentHwnd([minimized, { ...minimized, windowId: "456", minimized: false }])).toBe(456);
		expect(list).not.toHaveBeenCalled();
	});

	it("does not choose a non-Owl window as the owner", async () => {
		const hub = new MirrorHub({ onFrame: () => {}, onWindowsChanged: () => {} });
		await expect(hub.findOwlParentHwnd([{ ...minimized, process: "Androws" }])).rejects.toThrow(
			"owl desktop window not found",
		);
	});

	it("does not restore a source that preparation never acquired", async () => {
		const hub = new MirrorHub({ onFrame: () => {}, onWindowsChanged: () => {} });
		const nativeCommand = vi.fn();
		Reflect.set(hub, "runWorkerLines", nativeCommand);
		await hub.unembedWindow("123");
		expect(nativeCommand).not.toHaveBeenCalled();
	});
});
