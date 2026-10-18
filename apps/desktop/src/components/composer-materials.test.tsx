import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer, type ComposerImage } from "./Composer.tsx";
import { ComposerMaterials, type ComposerMaterialImage } from "./ComposerMaterials.tsx";

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
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	// Linkedom models the dialog calls; browser fixtures cover the native top layer.
	Object.defineProperty(dom.window.HTMLElement.prototype, "open", { configurable: true, get() { return this.hasAttribute("open"); } });
	dom.window.HTMLElement.prototype.showModal = function (): void { this.setAttribute("open", ""); };
	dom.window.HTMLElement.prototype.close = function (): void { this.removeAttribute("open"); };
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

afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function render(patch: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...patch };
	await act(async () => root.render(<Composer {...props} />));
}

const editor = (): HTMLElement => container.querySelector<HTMLElement>('[role="textbox"]')!;
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

	it("places compact image thumbnails and file cards above the input while preserving image preview and removal", async () => {
		await render();
		const tray = container.querySelector<HTMLElement>(".owl-composer-materials")!;
		const input = container.querySelector<HTMLElement>(".owl-composer-input")!;
		expect(input.contains(tray)).toBe(false);
		expect(tray.nextElementSibling).toBe(input);
		for (const card of tray.querySelectorAll(".owl-composer-material")) {
			if (card.getAttribute("data-kind") === "image") {
				expect(card.querySelector(".owl-composer-material-preview img")).not.toBeNull();
				expect(card.querySelector(".owl-composer-material-copy, .owl-composer-material-name, .owl-composer-material-path")).toBeNull();
			} else {
				expect(card.querySelector(".owl-composer-material-copy .owl-composer-material-name")).not.toBeNull();
				expect(card.querySelector(".owl-composer-material-path")).not.toBeNull();
			}
			expect(card.querySelector(".owl-composer-material-remove")).not.toBeNull();
		}
		const preview = tray.querySelector<HTMLButtonElement>(".owl-composer-material-preview")!;
		await act(async () => preview.click());
		expect(document.querySelector("dialog img")?.getAttribute("src")).toBe("data:image/png;base64,sample-image-0");
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click());
		expect(document.querySelector("dialog")).toBeNull();
		const remove = tray.querySelector<HTMLButtonElement>('[aria-label="移除图片 1"]')!;
		await act(async () => remove.click());
		await send();
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("核对全部材料", images.slice(1), files, undefined);
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

	it("attaches a pasted non-image file by its local path", async () => {
		await render({ draftRequest: undefined });
		const file = { name: "notes.md", type: "text/markdown", path: "D:/project/notes.md" };
		const paste = new window.Event("paste", { bubbles: true, cancelable: true });
		Object.assign(paste, { clipboardData: { items: [{ kind: "file", getAsFile: () => file }], getData: () => "" } });
		await act(async () => editor().dispatchEvent(paste));
		expect(paste.defaultPrevented).toBe(true);
		expect(container.textContent).toContain("notes.md");
	});

	it("does not offer the previous mention results while the next search is pending", async () => {
		vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 });
		const pending = Promise.withResolvers<{ path: string; isDir: boolean }[]>();
		await render({
			draftRequest: undefined,
			searchFiles: async (_cwd, query) => query === "old" ? [{ path: "D:/project/old.ts", isDir: false }] : pending.promise,
		});
		const box = editor();
		const typeAt = async (text: string): Promise<void> => {
			await act(async () => {
				box.textContent = text;
				const node = box.firstChild!;
				window.getSelection = () => ({
					rangeCount: 1,
					isCollapsed: true,
					getRangeAt: () => ({ endContainer: node, endOffset: node.textContent?.length ?? 0 }),
				}) as unknown as Selection;
				box.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
		};
		await typeAt("@old");
		expect(container.querySelector(".owl-mention-menu")?.textContent).toContain("old.ts");
		await typeAt("@new");
		expect(container.querySelector(".owl-mention-menu")?.textContent).not.toContain("old.ts");
		const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(enter, { key: "Enter", isComposing: false, keyCode: 13 });
		await act(async () => box.dispatchEvent(enter));
		expect(container.querySelector("[data-mention-path]")).toBeNull();
		await act(async () => pending.resolve([{ path: "D:/project/new.ts", isDir: false }]));
		expect(container.querySelector(".owl-mention-menu")?.textContent).toContain("new.ts");
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

describe("Composer material arrivals", () => {
	const sample = (id: string, name?: string): ComposerMaterialImage => ({ id, name, mimeType: "image/png", data: `data-${id}` });
	const file = (key: string) => ({ key, basename: `${key}.md`, path: `D:/project/${key}.md` });
	const preview = vi.fn();
	const removeImage = vi.fn();
	const removeFile = vi.fn();
	async function show(materialImages: ComposerMaterialImage[], materialFiles: ReturnType<typeof file>[], owner = "first"): Promise<void> {
		await act(async () => root.render(<ComposerMaterials key={owner} images={materialImages} files={materialFiles} onPreview={preview} onRemoveImage={removeImage} onRemoveFile={removeFile} />));
	}

	it("shows images without visible names or format text and retains localized preview and removal actions", async () => {
		const named = sample("first", "草图.png");
		const unnamed = sample("second");
		await show([named, unnamed], [file("notes")]);
		for (const card of container.querySelectorAll('[data-kind="image"]')) {
			expect(card.querySelector(".owl-composer-material-preview img")).not.toBeNull();
			expect(card.querySelector(".owl-composer-material-copy, .owl-composer-material-name, .owl-composer-material-path")).toBeNull();
			expect(card.querySelector(".owl-composer-material-remove")).not.toBeNull();
		}
		expect(container.textContent).not.toContain("草图.png");
		expect(container.textContent).not.toContain("PNG");
		expect([...container.querySelectorAll(".owl-composer-material-name")].map((name) => name.textContent)).toEqual(["notes.md"]);
		expect(container.querySelector('[data-kind="file"] .owl-composer-material-path')?.textContent).toBe("D:/project/notes.md");
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="预览图片 1"]')!.click());
		expect(preview).toHaveBeenCalledWith(named);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除图片 2"]')!.click());
		expect(removeImage).toHaveBeenCalledWith("second");
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除文件 D:/project/notes.md"]')!.click());
		expect(removeFile).toHaveBeenCalledWith("D:/project/notes.md");
		await act(async () => setUiLanguage("en"));
		await show([unnamed], []);
		expect(container.querySelector(".owl-composer-material-copy, .owl-composer-material-name, .owl-composer-material-path")).toBeNull();
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Preview image 1"]')?.title).toBeTruthy();
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove image 1"]')?.title).toBeTruthy();
	});

	it("animates only newly added visible materials and never replays on collapse or owner restoration", async () => {
		vi.useFakeTimers();
		const initial = [sample("one"), sample("two"), sample("three"), sample("four")];
		await show(initial, []);
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
		await act(async () => materialToggle().click());
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
		await show(initial, [file("new")]);
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(1);
		expect(container.querySelector('[data-arriving="true"]')?.getAttribute("data-kind")).toBe("file");
		await act(async () => vi.advanceTimersByTime(500));
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
		await act(async () => materialToggle().click());
		await act(async () => materialToggle().click());
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
		await show(initial, [file("new")], "restored-owner");
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
	});

	it("does not replay a new hidden image when it is later revealed", async () => {
		vi.useFakeTimers();
		const initial = [sample("one"), sample("two"), sample("three")];
		await show(initial, []);
		await show([...initial, sample("hidden")], []);
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
		await act(async () => materialToggle().click());
		expect(container.querySelectorAll(".owl-composer-material")).toHaveLength(4);
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
	});

	it("does not replay an arriving image after quickly collapsing and expanding", async () => {
		vi.useFakeTimers();
		const initial = [sample("one"), sample("two"), sample("three"), sample("four")];
		await show(initial, []);
		await act(async () => materialToggle().click());
		await show([...initial, sample("new")], []);
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(1);
		await act(async () => materialToggle().click());
		await act(async () => materialToggle().click());
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
	});

	it("gives newly attached images the same finite arrival as files", async () => {
		vi.useFakeTimers();
		await show([], []);
		await show([sample("image")], [file("document")]);
		expect([...container.querySelectorAll('[data-arriving="true"]')].map((card) => card.getAttribute("data-kind"))).toEqual(["image", "file"]);
		await act(async () => vi.advanceTimersByTime(500));
		expect(container.querySelectorAll('[data-arriving="true"]')).toHaveLength(0);
	});
});
