import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { FileArtifact } from "../hooks/artifacts.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { ArtifactActions, type ArtifactActionsProps } from "./ArtifactActions.tsx";
import { Artifacts } from "./Artifacts.tsx";
import { artifactActionText as text } from "./artifact-actions-copy.ts";

type Response = { ok: boolean; result?: { isFile: boolean }; error?: string };
let container: HTMLElement;
let root: Root;
let props: ArtifactActionsProps;
let request = vi.fn(async (_value: unknown): Promise<Response> => ({ ok: true, result: { isFile: true } }));
let writeText = vi.fn(async (_value: string): Promise<void> => undefined);

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	request = vi.fn(async (_value: unknown): Promise<Response> => ({ ok: true, result: { isFile: true } }));
	writeText = vi.fn(async (_value: string): Promise<void> => undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	props = { path: "reports/报告 #1.md", title: "报告 #1.md", client: { request } as unknown as BridgeClient, cwd: "D:/owl", onOpenFile: vi.fn() };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<ArtifactActionsProps> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ArtifactActions {...props} />));
}

function button(label: string): HTMLButtonElement {
	const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

describe("artifact actions", () => {
	it("checks file metadata before opening without reading the file body", async () => {
		await render();
		await act(async () => button(text("open")).click());
		expect(request).toHaveBeenCalledExactlyOnceWith({ type: "fs.stat", cwd: "D:/owl", path: "reports/报告 #1.md" });
		expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith("reports/报告 #1.md");
		expect(container.querySelector('[role="status"]')?.textContent).toBe(text("opened"));
	});

	it("keeps the original file-title button and adds all shortcuts to real artifact cards", async () => {
		const artifact: FileArtifact = { path: props.path, title: props.title!, kind: "document", action: "written", toolId: "write-1" };
		await act(async () => root.render(<Artifacts artifacts={[artifact]} client={props.client} cwd={props.cwd} onOpenFile={props.onOpenFile!} />));
		const title = container.querySelector<HTMLButtonElement>(".owl-artifact-file")!;
		expect(title.getAttribute("aria-label")).toBe(t("artifacts.openAria", { name: artifact.title }));
		expect(button(text("reveal"))).toBeDefined();
		expect(button(text("copy"))).toBeDefined();
		await act(async () => title.click());
		expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith(artifact.path);
	});

	it("reports a deleted file and retries the metadata check before opening", async () => {
		request.mockResolvedValueOnce({ ok: false, error: "fs-error: ENOENT, file no longer exists" });
		await render();
		await act(async () => button(text("open")).click());
		expect(props.onOpenFile).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("ENOENT");
		await act(async () => button(text("retry")).click());
		expect(request).toHaveBeenCalledTimes(2);
		expect(props.onOpenFile).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("does not open a directory or swallow an asynchronous viewer failure", async () => {
		request.mockResolvedValueOnce({ ok: true, result: { isFile: false } });
		await render({ onOpenFile: vi.fn(async () => { throw new Error("viewer permission denied"); }) });
		await act(async () => button(text("open")).click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(text("notFile"));
		await act(async () => button(text("retry")).click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("viewer permission denied");
	});

	it("waits for the reveal acknowledgement and preserves bridge failures for retry", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await act(async () => {
			button(text("reveal")).click();
			button(text("reveal")).click();
		});
		expect(request).toHaveBeenCalledExactlyOnceWith({ type: "open.external", action: "reveal", cwd: "D:/owl", target: props.path });
		expect(button(text("revealing")).disabled).toBe(true);
		expect(container.querySelector('[role="status"]')).toBeNull();
		await act(async () => pending.resolve({ ok: false, error: "EACCES: permission denied" }));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("permission denied");
		await act(async () => button(text("retry")).click());
		expect(container.querySelector('[role="status"]')?.textContent).toBe(text("revealed"));
		expect(props.onOpenFile).not.toHaveBeenCalled();
	});

	it("copies the absolute path only after the clipboard accepts it, and retries a rejection", async () => {
		writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
		await render();
		await act(async () => button(text("copy")).click());
		expect(writeText).toHaveBeenCalledExactlyOnceWith("D:\\owl\\reports\\报告 #1.md");
		expect(container.querySelector('[role="status"]')).toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Clipboard permission denied");
		await act(async () => button(text("retry")).click());
		expect(writeText).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="status"]')?.textContent).toBe(text("copied"));
		expect(request).not.toHaveBeenCalled();
	});

	it("handles an unavailable clipboard without claiming success", async () => {
		vi.stubGlobal("navigator", {});
		await render();
		await act(async () => button(text("copy")).click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(text("clipboardUnavailable"));
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	it("does not propagate quick action clicks to a containing file row", async () => {
		const onRowClick = vi.fn();
		await act(async () => root.render(<div onClick={onRowClick}><ArtifactActions {...props} /></div>));
		await act(async () => button(text("copy")).click());
		expect(writeText).toHaveBeenCalledOnce();
		expect(onRowClick).not.toHaveBeenCalled();
		expect(props.onOpenFile).not.toHaveBeenCalled();
	});

	it("rejects an escaping path before bridge, clipboard or viewer access", async () => {
		await render({ path: "../outside.md" });
		expect(container.textContent).toContain(text("invalidPath"));
		expect([...container.querySelectorAll<HTMLButtonElement>("button")].every((item) => item.disabled)).toBe(true);
		expect(request).not.toHaveBeenCalled();
		expect(writeText).not.toHaveBeenCalled();
		expect(props.onOpenFile).not.toHaveBeenCalled();
	});

	it("keeps existing open support when connection or project metadata is absent", async () => {
		await render({ client: undefined, cwd: undefined });
		expect(button(text("reveal")).disabled).toBe(true);
		expect(button(text("copy")).disabled).toBe(true);
		await act(async () => button(text("open")).click());
		expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith(props.path);
		expect(request).not.toHaveBeenCalled();
	});

	it("does not open an old file or show an old response after changing projects", async () => {
		const old = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(old.promise);
		await render();
		await act(async () => button(text("open")).click());
		await render({ cwd: "D:/another-project" });
		await act(async () => button(text("copy")).click());
		expect(writeText).toHaveBeenCalledExactlyOnceWith("D:\\another-project\\reports\\报告 #1.md");
		await act(async () => old.resolve({ ok: true, result: { isFile: true } }));
		expect(props.onOpenFile).not.toHaveBeenCalled();
		expect(container.querySelector('[role="status"]')?.textContent).toBe(text("copied"));
	});

	it("does not show stale failures when the bridge or file changes", async () => {
		const old = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(old.promise);
		await render();
		await act(async () => button(text("reveal")).click());
		await render({ path: "new.md", client: { request: vi.fn(async () => ({ ok: true })) } as unknown as BridgeClient });
		await act(async () => old.reject(new Error("old bridge disconnected")));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(button(text("reveal")).disabled).toBe(false);
	});

	it("does not open a file after its originating card is unmounted", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await act(async () => button(text("open")).click());
		await act(async () => root.render(null));
		await act(async () => pending.resolve({ ok: true, result: { isFile: true } }));
		expect(props.onOpenFile).not.toHaveBeenCalled();
		expect(container.children).toHaveLength(0);
	});

	it("can still copy a known absolute path when the bridge is disconnected", async () => {
		await render({ client: undefined });
		expect(button(text("reveal")).disabled).toBe(true);
		await act(async () => button(text("copy")).click());
		expect(writeText).toHaveBeenCalledExactlyOnceWith("D:\\owl\\reports\\报告 #1.md");
		expect(request).not.toHaveBeenCalled();
	});

	it("updates action and success copy when the interface language changes", async () => {
		await render();
		await act(async () => button(text("copy")).click());
		await act(async () => setUiLanguage("en"));
		expect(container.textContent).toContain("Open containing folder");
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Absolute path copied.");
	});
});
