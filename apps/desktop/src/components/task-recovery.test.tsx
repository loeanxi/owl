import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n/index.ts";
import { TaskRecoveryNotice, type TaskRecoveryNoticeProps } from "./TaskRecoveryNotice.tsx";

let container: HTMLElement;
let root: Root;
let props: TaskRecoveryNoticeProps;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	props = { recovery: { id: "failure-one", reason: "network offline", completedTools: 2, uncertainTools: 1 }, onContinue: vi.fn(async () => true) };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<TaskRecoveryNoticeProps> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<TaskRecoveryNotice {...props} />));
}

function button(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
	if (!found) throw new Error(`Missing button: ${label}`);
	return found;
}

describe("TaskRecoveryNotice", () => {
	it("shows saved progress and uncertain operations, and opens configuration directly", async () => {
		const onOpenSettings = vi.fn();
		await render({ onOpenSettings });
		expect(container.textContent).toContain(t("recovery.kept", { n: 2 }));
		expect(container.textContent).toContain(t("recovery.uncertain", { n: 1 }));
		expect(container.textContent).toContain("network offline");
		await act(async () => button(t("recovery.settings")).click());
		expect(onOpenSettings).toHaveBeenCalledOnce();
	});

	it("keeps continuation available after a failed attempt", async () => {
		const onContinue = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await render({ onContinue });
		await act(async () => button(t("recovery.continue")).click());
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(t("recovery.failed"));
		expect(button(t("recovery.continue")).disabled).toBe(false);
		await act(async () => button(t("recovery.continue")).click());
		expect(onContinue).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("blocks duplicate same-tick clicks while acknowledgement is pending", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onContinue = vi.fn(() => pending.promise);
		await render({ onContinue });
		await act(async () => {
			const resume = button(t("recovery.continue"));
			resume.click();
			resume.click();
		});
		expect(onContinue).toHaveBeenCalledOnce();
		expect(button(t("recovery.continuing")).disabled).toBe(true);
		await act(async () => pending.resolve(true));
		expect(button(t("recovery.continue")).disabled).toBe(false);
	});

	it("offers alternative models and passes only the explicitly selected choice", async () => {
		const onContinue = vi.fn(async () => true);
		await render({ onContinue, model: "provider/current", providers: [{ id: "provider", name: "Provider", models: [{ id: "current", name: "Current" }, { id: "alternative", name: "Alternative" }] }] });
		await act(async () => button(t("recovery.chooseModel")).click());
		const select = container.querySelector<HTMLSelectElement>("select")!;
		expect(select.querySelector('option[value="provider/current"]')).toBeNull();
		expect(button(t("recovery.switchContinue")).disabled).toBe(true);
		await act(async () => {
			// linkedom does not implement the browser's select.value setter.
			Object.defineProperty(select, "value", { configurable: true, value: "provider/alternative" });
			select.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		expect(button(t("recovery.switchContinue")).disabled).toBe(false);
		await act(async () => button(t("recovery.switchContinue")).click());
		expect(onContinue).toHaveBeenCalledExactlyOnceWith("provider/alternative");
	});

	it("clears a previous recovery error when a different failure replaces the card", async () => {
		await render({ onContinue: async () => { throw new Error("bridge offline"); } });
		await act(async () => button(t("recovery.continue")).click());
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("bridge offline");
		await render({ recovery: { id: "failure-two", reason: "new failure", completedTools: 0, uncertainTools: 0 } });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		await render({ recovery: undefined });
		expect(container.children).toHaveLength(0);
	});
});
