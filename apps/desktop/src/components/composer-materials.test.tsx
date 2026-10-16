import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer, type ComposerImage } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({ listenForOsFileDrop: async () => () => {}, readLocalImage: async () => undefined }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null }));

type Props = React.ComponentProps<typeof Composer>;
const images: ComposerImage[] = Array.from({ length: 4 }, (_, index) => ({ type: "image", mimeType: "image/png", data: `sample-image-${index}` }));
const files = ["D:/project/first.ts", "D:/project/second.ts", "D:/project/third.ts", "D:/project/last-reference.md"];
let container: HTMLElement;
let root: Root;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll("\\", "\\\\") });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	dom.window.getSelection = () => null;
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	props = {
		client: { request: async () => ({ ok: true, result: { isFile: true, isDirectory: false } }) } as unknown as BridgeClient,
		connected: true, disabled: false, running: false, hideEnvironment: true, hideMascot: true,
		onSend: vi.fn(() => false), onAbort: vi.fn(), providers: [], model: "fixture/model", onModel: vi.fn(),
		thinkingLevel: "high", onThinkingLevel: vi.fn(), approvalMode: "confirm", onApprovalMode: vi.fn(),
		workspaceDir: "D:/project", projects: [], onSwitchProject: vi.fn(), commands: [], searchFiles: async () => [],
		draftRequest: { id: 1, text: "核对全部材料", images, attachedPaths: files, replace: true },
	};
});

afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function render(patch: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...patch };
	await act(async () => root.render(<Composer {...props} />));
}

function materialToggle(): HTMLButtonElement {
	return container.querySelector<HTMLButtonElement>(".owl-composer-materials button[aria-expanded]")!;
}

async function send(): Promise<void> {
	const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.send")}"]`)!;
	await act(async () => button.click());
}

describe("Composer compact materials", () => {
	it("submits every image and file even when most material previews are collapsed", async () => {
		await render();
		expect(materialToggle().getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelectorAll(".owl-composer-materials img")).toHaveLength(2);
		expect(container.querySelector(".owl-composer-materials")?.textContent).toContain("first.ts");
		await send();
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("核对全部材料", images, files, undefined);
	});

	it("removes only the chosen file after expanding hidden references and preserves the rest of the draft", async () => {
		await render();
		await act(async () => materialToggle().click());
		expect(materialToggle().getAttribute("aria-expanded")).toBe("true");
		const remove = [...container.querySelectorAll<HTMLButtonElement>(".owl-composer-materials button")].find((button) => button.getAttribute("aria-label")?.includes("last-reference.md"));
		expect(remove).toBeDefined();
		expect(remove?.getAttribute("tabindex")).not.toBe("-1");
		await act(async () => remove!.click());
		await act(async () => materialToggle().click());
		await send();
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("核对全部材料", images, files.slice(0, -1), undefined);
		expect(container.querySelector('[role="textbox"]')?.textContent).toBe("核对全部材料");
	});

	it("keeps inline file mentions in the editor and counts each reference only once", async () => {
		await render({ draftRequest: { id: 2, text: "检查对应文件", attachedPaths: [files[0]], replace: true } });
		const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
		await act(async () => {
			const chip = document.createElement("span");
			chip.className = "owl-mention-chip";
			chip.dataset.mentionPath = files[0];
			chip.textContent = "first.ts";
			editor.appendChild(chip);
			editor.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(editor.querySelector(".owl-mention-chip")).not.toBeNull();
		expect(container.querySelector(".owl-composer-materials")).toBeNull();
		await send();
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("检查对应文件", undefined, [files[0]], undefined);
	});
});
