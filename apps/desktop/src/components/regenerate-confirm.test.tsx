import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage, t } from "../i18n/index.ts";
import { RegenerateConfirmDialog } from "./RegenerateConfirmDialog.tsx";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = dom.document.getElementById("root")!; root = createRoot(container);
	setUiLanguage("zh");
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

function render(preview: string, onConfirm: () => void, onClose: () => void): Promise<void> {
	return act(async () => root.render(<RegenerateConfirmDialog preview={preview} onConfirm={onConfirm} onClose={onClose} />)) as unknown as Promise<void>;
}
const button = (label: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;

describe("RegenerateConfirmDialog", () => {
	it("previews the turn to be regenerated and only fires on explicit confirm", async () => {
		const onConfirm = vi.fn(); const onClose = vi.fn();
		await render("帮我把导出改成 CSV\n第二行不应出现在预览", onConfirm, onClose);
		expect(container.querySelector('[role="alertdialog"]')?.getAttribute("aria-label")).toBe(t("regenerate.confirmTitle"));
		expect(container.textContent).toContain("帮我把导出改成 CSV");
		expect(container.textContent).not.toContain("第二行不应出现在预览");
		expect(container.textContent).toContain(t("regenerate.confirmHint"));
		await act(async () => button(t("common.cancel")).click());
		expect(onClose).toHaveBeenCalledOnce();
		expect(onConfirm).not.toHaveBeenCalled();
		await act(async () => button(t("regenerate.confirmOk")).click());
		expect(onConfirm).toHaveBeenCalledOnce();
		expect(onClose).not.toHaveBeenCalledTimes(2);
	});

	it("closes on Escape without confirming", async () => {
		const onConfirm = vi.fn(); const onClose = vi.fn();
		await render("推进", onConfirm, onClose);
		await act(async () => {
			const event = new window.Event("keydown", { bubbles: true });
			Object.defineProperties(event, { key: { value: "Escape" } });
			window.dispatchEvent(event);
		});
		expect(onClose).toHaveBeenCalledOnce();
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
