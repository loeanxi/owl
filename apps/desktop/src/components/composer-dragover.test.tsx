import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({ listenForOsFileDrop: async () => () => {}, readLocalImage: async () => undefined }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Props = React.ComponentProps<typeof Composer>;
let root: Root;
let container: HTMLElement;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll("\\", "\\\\") });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	dom.window.getSelection = () => null;
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!; root = createRoot(container);
	props = { client: { request: () => Promise.resolve({ ok: true, result: { receipts: [] } }) } as unknown as BridgeClient, connected: true, disabled: false, running: false, hideEnvironment: true, hideMascot: true, onSend: vi.fn(() => false), onAbort: vi.fn(), providers: [], model: "fixture/model", onModel: vi.fn(), thinkingLevel: "high", onThinkingLevel: vi.fn(), approvalMode: "confirm", onApprovalMode: vi.fn(), workspaceDir: "D:/project", queueProfile: "profile-a", queueSessionId: "session-a", projects: [], onSwitchProject: vi.fn(), commands: [], searchFiles: async () => [], draftRequest: undefined };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(): Promise<void> { await act(async () => root.render(<Composer {...props} />)); }

function dragEvent(type: "dragover" | "dragleave", dataTransfer?: object, relatedTarget: unknown = null): Event {
	const event = new window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, relatedTarget: { value: relatedTarget } });
	return event;
}
const surface = (): HTMLElement => container.querySelector<HTMLElement>(".owl-composer-surface")!;
const inputBox = (): HTMLElement => container.querySelector<HTMLElement>(".owl-composer-input")!;
const hint = (): HTMLElement | null => container.querySelector<HTMLElement>(".owl-composer-drop-hint");

describe("composer drag-over affordance", () => {
	it("counts hovered files and highlights the input surface, then clears on leave", async () => {
		await render();
		expect(hint()).toBeNull();
		expect(inputBox().hasAttribute("data-drag-over")).toBe(false);
		await act(async () => {
			surface().dispatchEvent(dragEvent("dragover", { types: ["Files"], items: { length: 3 }, files: [], getData: () => "" }));
		});
		expect(hint()?.getAttribute("role")).toBe("status");
		expect(hint()?.textContent).toBe(t("composer.dropOverCount", { n: 3 }));
		expect(inputBox().getAttribute("data-drag-over")).toBe("true");
		await act(async () => {
			surface().dispatchEvent(dragEvent("dragleave", undefined, document.body));
		});
		expect(hint()).toBeNull();
		expect(inputBox().hasAttribute("data-drag-over")).toBe(false);
	});

	it("falls back to a count-free hint when the count is unavailable and ignores non-file drags", async () => {
		await render();
		await act(async () => {
			surface().dispatchEvent(dragEvent("dragover", { types: ["Files"], items: { length: 0 }, files: [], getData: () => "" }));
		});
		expect(hint()?.textContent).toBe(t("composer.dropOverGeneric"));
		await act(async () => {
			surface().dispatchEvent(dragEvent("dragleave", undefined, document.body));
			surface().dispatchEvent(dragEvent("dragover", { types: ["text/plain"], items: { length: 1 }, files: [], getData: () => "" }));
		});
		expect(hint()).toBeNull();
	});
});
