import { invoke } from "@tauri-apps/api/core";
import { parseHTML } from "linkedom";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStartupWindow } from "./startup-window.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let root: Root;
let completeAppearance: () => void;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

function Startup({ prepared = false }: { prepared?: boolean }) {
	completeAppearance = useStartupWindow();
	useEffect(() => {
		if (prepared) completeAppearance();
	}, [prepared]);
	return <main>Owl</main>;
}

async function nextFrame(): Promise<void> {
	await act(async () => {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(0);
	});
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
	frames.clear();
	frameId = 0;
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
	root = createRoot(dom.document.getElementById("root")!);
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("reveals only after appearance is prepared and the updated shell has a paint opportunity", async () => {
	await act(async () => root.render(<Startup />));
	expect(invoke).not.toHaveBeenCalled();
	await act(async () => completeAppearance());
	expect(invoke).not.toHaveBeenCalled();
	await nextFrame();
	expect(invoke).not.toHaveBeenCalled();
	await nextFrame();
	expect(invoke).toHaveBeenCalledExactlyOnceWith("main_window_ready");
	await vi.advanceTimersByTimeAsync(5000);
	expect(invoke).toHaveBeenCalledTimes(1);
});

it("reveals when a hidden WebView suppresses animation frames", async () => {
	await act(async () => root.render(<Startup prepared />));
	await vi.advanceTimersByTimeAsync(100);
	expect(invoke).toHaveBeenCalledExactlyOnceWith("main_window_ready");
	expect(frames.size).toBe(0);
});

it("does not stay hidden when the bridge never connects or returns startup settings", async () => {
	await act(async () => root.render(<Startup />));
	await act(async () => vi.advanceTimersByTimeAsync(4000));
	await nextFrame();
	await nextFrame();
	expect(invoke).toHaveBeenCalledExactlyOnceWith("main_window_ready");
});

it("survives StrictMode effect replay without duplicate reveal or a canceled permanent wait", async () => {
	await act(async () =>
		root.render(
			<StrictMode>
				<Startup prepared />
			</StrictMode>,
		),
	);
	await nextFrame();
	await nextFrame();
	await vi.advanceTimersByTimeAsync(5000);
	expect(invoke).toHaveBeenCalledExactlyOnceWith("main_window_ready");
});

it("cancels the pending reveal when the application unmounts", async () => {
	await act(async () => root.render(<Startup prepared />));
	await act(async () => root.render(null));
	await nextFrame();
	await vi.advanceTimersByTimeAsync(5000);
	expect(invoke).not.toHaveBeenCalled();
});

it("leaves browser mode without native calls or startup timers", async () => {
	delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
	await act(async () => root.render(<Startup prepared />));
	await nextFrame();
	await vi.advanceTimersByTimeAsync(5000);
	expect(invoke).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
