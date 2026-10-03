import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";

const browser = vi.hoisted(() => {
	const pointer = { x: 0, y: 0 };
	const events: Array<{ action: "down" | "up"; x: number; y: number; button: string }> = [];
	let viewport = { width: 1280, height: 860 };
	const page = {
		on: vi.fn(),
		off: vi.fn(),
		url: () => "about:blank",
		title: async () => "",
		setViewportSize: async (size: { width: number; height: number }) => {
			viewport = size;
		},
		viewportSize: () => viewport,
		screenshot: async () => Buffer.from("frame"),
		mouse: {
			move: async (x: number, y: number) => {
				pointer.x = x;
				pointer.y = y;
			},
			down: async ({ button }: { button: string }) => {
				events.push({ action: "down", ...pointer, button });
			},
			up: async ({ button }: { button: string }) => {
				events.push({ action: "up", ...pointer, button });
			},
		},
	};
	const cdp = { on: vi.fn(), send: async () => ({}), detach: async () => {} };
	const context = { newPage: async () => page, newCDPSession: async () => cdp };
	return {
		pointer,
		events,
		launch: async () => ({
			contexts: () => [context],
			newContext: async () => context,
			on: vi.fn(),
			close: async () => {},
		}),
	};
});

vi.mock("playwright-core", () => ({
	default: { chromium: { launch: browser.launch }, selectors: { register: async () => {} } },
}));

describe("desktop browser pointer input", () => {
	let hub: BrowserHub;
	let pageId: string;

	beforeEach(async () => {
		browser.pointer.x = 0;
		browser.pointer.y = 0;
		browser.events.length = 0;
		hub = new BrowserHub({
			onPagesChanged: () => {},
			onFrame: () => {},
			onFileChooser: () => {},
			onDiagnostic: () => {},
		});
		pageId = (await hub.open({})).pageId;
	});

	afterEach(async () => {
		await hub.dispose();
	});

	it("presses at the supplied coordinates without requiring an earlier move", async () => {
		await hub.input(pageId, { kind: "mouse", action: "down", x: 90, y: 85, button: "right" });

		expect(browser.events).toEqual([{ action: "down", x: 90, y: 85, button: "right" }]);
	});

	it("uses the new coordinates for the first click after a viewport change", async () => {
		await hub.setViewport(pageId, 390, 844);
		await hub.input(pageId, { kind: "mouse", action: "move", x: 90, y: 85 });
		await hub.setViewport(pageId, 844, 390);
		await hub.input(pageId, { kind: "mouse", action: "down", x: 290, y: 85 });
		await hub.input(pageId, { kind: "mouse", action: "up", x: 290, y: 85 });

		expect(browser.events).toEqual([
			{ action: "down", x: 290, y: 85, button: "left" },
			{ action: "up", x: 290, y: 85, button: "left" },
		]);
	});

	it("releases at the supplied drag endpoint without requiring an intervening move", async () => {
		await hub.input(pageId, { kind: "mouse", action: "move", x: 90, y: 85 });
		await hub.input(pageId, { kind: "mouse", action: "down", x: 90, y: 85, button: "middle" });
		await hub.input(pageId, { kind: "mouse", action: "up", x: 240, y: 185, button: "middle" });

		expect(browser.events).toEqual([
			{ action: "down", x: 90, y: 85, button: "middle" },
			{ action: "up", x: 240, y: 185, button: "middle" },
		]);
	});
});
