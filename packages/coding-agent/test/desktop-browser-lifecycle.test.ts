import { describe, expect, it, vi } from "vitest";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";

const launch = vi.hoisted(() => {
	let resolveBrowser: (browser: { close: () => Promise<void> }) => void = () => {};
	let notifyStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	const result = new Promise<{ close: () => Promise<void> }>((resolve) => {
		resolveBrowser = resolve;
	});
	return {
		started,
		resolveBrowser,
		start: () => {
			notifyStarted();
			return result;
		},
	};
});

vi.mock("playwright-core", () => ({
	default: { chromium: { launch: launch.start }, selectors: { register: async () => {} } },
}));

describe("desktop browser shutdown", () => {
	it("closes a late browser launch and rejects pending or future opens", async () => {
		const hub = new BrowserHub({
			onPagesChanged: () => {},
			onFrame: () => {},
			onFileChooser: () => {},
			onDiagnostic: () => {},
		});
		const opening = hub.open({});
		const rejected = expect(opening).rejects.toThrow("已关闭");
		await launch.started;
		const disposing = hub.dispose();
		const close = vi.fn(async () => {});
		launch.resolveBrowser({ close });
		await Promise.all([rejected, disposing]);
		expect(close).toHaveBeenCalledOnce();
		expect(hub.listPages()).toEqual([]);
		await expect(hub.open({})).rejects.toThrow("已关闭");
	});
});
