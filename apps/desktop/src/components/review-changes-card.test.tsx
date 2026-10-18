import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../bridge/client.ts";
import type { DesktopClientRequestWithoutId, DiffApprovalFileSummary } from "../bridge/protocol.ts";
import { getFileIconTheme, setFileIconTheme, type FileIconThemeId } from "../file-icons/file-icon-theme.ts";
import type { FileArtifact } from "../hooks/artifacts.ts";
import { getUiLanguageSetting, setUiLanguage, setUiLanguageSetting, t } from "../i18n/index.ts";
import { consumeEditorDiffFocus, peekEditorDiffFocus } from "../sidebar/editor-diff-focus.ts";
import { artifactActionText } from "./artifact-actions-copy.ts";
import { ReviewChangesCard, type ReviewChangesCardProps } from "./ReviewChangesCard.tsx";

let container: HTMLElement;
let root: Root;
let client: BridgeClient;
let props: ReviewChangesCardProps;
let records: DiffApprovalFileSummary[];
let calls: DesktopClientRequestWithoutId[];
let writeText: ReturnType<typeof vi.fn<(value: string) => Promise<void>>>;
let previousTheme: FileIconThemeId;
let previousLanguage: ReturnType<typeof getUiLanguageSetting>;

function filesAt(paths: string[]): FileArtifact[] {
	return paths.map((path, index) => ({
		path,
		title: path.split("/").at(-1)!,
		kind: "code",
		action: "edited",
		toolId: `operation-${index}`,
	}));
}

function track(files: readonly FileArtifact[]): void {
	records = files.map((file) => ({
		id: file.toolId,
		path: `${props.cwd}/${file.path}`,
		displayPath: file.path,
		status: "pending",
		originalExisted: true,
		currentExists: true,
		added: 3,
		removed: 1,
		size: 42,
		baselineAt: "2026-10-19T01:00:00.000Z",
		resolvedAt: null,
		toolCallId: file.toolId,
		sessionId: props.sessionId,
		scope: "operation",
	}));
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	previousTheme = getFileIconTheme();
	previousLanguage = getUiLanguageSetting();
	setUiLanguage("zh");
	setFileIconTheme("minimal");
	consumeEditorDiffFocus();
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	client = new BridgeClient("ws://review-card.test");
	calls = [];
	writeText = vi.fn(async (_value: string): Promise<void> => undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	props = {
		files: filesAt(["src/package.json", "src/biome.json"]),
		cwd: "D:/project",
		sessionId: "session-card",
		client,
		onOpenFile: vi.fn(),
		onOpenReview: vi.fn(),
	};
	track(props.files);
	vi.spyOn(client, "request").mockImplementation(
		async <T,>(request: DesktopClientRequestWithoutId & { id?: string }) => {
			calls.push(request);
			let result: unknown;
			if (request.type === "diffApproval.list") result = { files: records };
			else if (request.type === "diffApproval.diff")
				result = {
					diff: "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old-value\n+new-value\n",
					truncated: false,
				};
			else if (request.type === "diffApproval.preview")
				result = {
					token: "card-preview",
					mode: "operations",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					files: request.entryIds.map((id) => ({
						path: `${props.cwd}/${id}.json`,
						displayPath: `${id}.json`,
						entryIds: [id],
						canRevert: true,
						diff: "",
						truncated: false,
						currentExists: true,
						targetExists: true,
					})),
				};
			else if (request.type === "fs.stat") result = { isFile: true };
			else if (request.type === "open.external") result = undefined;
			else throw new Error(`Unexpected card request: ${request.type}`);
			return { ok: true, result: result as T };
		},
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	setFileIconTheme(previousTheme);
	setUiLanguageSetting(previousLanguage);
	consumeEditorDiffFocus();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function button(label: string, scope: Element = container): HTMLButtonElement {
	const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
		(element) => element.textContent?.trim() === label,
	);
	if (!result) throw new Error(`Missing button: ${label}\n${scope.textContent}`);
	return result;
}

async function click(target: HTMLButtonElement): Promise<void> {
	await act(async () => target.click());
}

async function render(files = props.files): Promise<void> {
	props = { ...props, files };
	track(files);
	await act(async () => root.render(<ReviewChangesCard {...props} />));
	const toggle = container.querySelector<HTMLButtonElement>(".owl-changes-toggle")!;
	if (toggle.getAttribute("aria-expanded") === "false") await click(toggle);
}

describe("review changes card presentation and actions", () => {
	it("follows live icon theme choices without replacing the user's preference", async () => {
		await render();
		const icon = container.querySelector(".owl-changes-type")!;
		expect(icon.querySelector("svg")).not.toBeNull();
		await act(async () => setFileIconTheme("none"));
		expect(icon.children).toHaveLength(0);
		expect(getFileIconTheme()).toBe("none");
		await act(async () => setFileIconTheme("material"));
		expect(icon.querySelector<HTMLImageElement>("img.owl-file-icon-img")?.getAttribute("src")).toContain(
			"file-icons/material/",
		);
		expect(getFileIconTheme()).toBe("material");
		await act(async () => setFileIconTheme("seti"));
		expect(icon.querySelector(".owl-file-icon-seti")).not.toBeNull();
		expect(icon.querySelector(".owl-file-icon-seti")?.textContent).not.toBe("");
		expect(icon.querySelector(".owl-file-icon-img")).toBeNull();
		expect(getFileIconTheme()).toBe("seti");
		await act(async () => setFileIconTheme("minimal"));
		expect(icon.querySelector("svg")).not.toBeNull();
		expect(icon.querySelector(".owl-file-icon-seti")).toBeNull();
		expect(getFileIconTheme()).toBe("minimal");
		expect(calls.every((request) => request.type === "diffApproval.list")).toBe(true);
	});

	it("shows a shared directory once while keeping each file directly accessible", async () => {
		await render();
		expect(container.textContent?.match(/src/g)).toHaveLength(1);
		expect([...container.querySelectorAll(".owl-changes-name")].map((item) => item.textContent)).toEqual([
			"package.json",
			"biome.json",
		]);
		await click(container.querySelector<HTMLButtonElement>(".owl-changes-file")!);
		expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith("src/package.json");
		expect(peekEditorDiffFocus()).toBe("src/package.json");
	});

	it("retains per-file locations when files belong to different directories", async () => {
		await render(filesAt(["src/components/Card.tsx", "src/hooks/use-card.ts"]));
		const rows = container.querySelectorAll(".owl-changes-item");
		expect(rows[0].textContent).toContain("src/components");
		expect(rows[1].textContent).toContain("src/hooks");
	});

	it("keeps inline review, scoped undo preview and workspace review available", async () => {
		await render();
		const firstRow = container.querySelector(".owl-changes-item")!;
		await click(button(t("chat.reviewCta"), firstRow));
		expect(calls.filter((request) => request.type === "diffApproval.diff")).toEqual([
			{ type: "diffApproval.diff", cwd: "D:/project", entryId: "operation-0" },
		]);
		expect(firstRow.textContent).toContain("new-value");
		await click(button("仅撤销本轮改动"));
		expect(calls.find((request) => request.type === "diffApproval.preview")).toMatchObject({
			entryIds: ["operation-0", "operation-1"],
			mode: "operations",
		});
		expect(button("确认撤销可处理文件")).toBeDefined();
		expect(calls.some((request) => request.type === "diffApproval.resolve")).toBe(false);
		await click(button(t("chat.reviewInWorkbench")));
		expect(props.onOpenReview).toHaveBeenCalledExactlyOnceWith("src/package.json");
	});

	it("uses acknowledged file actions in the row menu and returns focus on Escape", async () => {
		await render();
		const trigger = container.querySelector<HTMLButtonElement>(".owl-changes-act.is-more")!;
		await click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		let menu = container.querySelector<HTMLElement>('[role="menu"]')!;
		await click(button(artifactActionText("copy"), menu));
		expect(writeText).toHaveBeenCalledExactlyOnceWith("D:\\project\\src\\package.json");
		expect(menu.querySelector('[role="status"]')?.textContent).toBe(artifactActionText("copied"));
		await click(button(artifactActionText("reveal"), menu));
		expect(calls.find((request) => request.type === "open.external")).toMatchObject({
			type: "open.external",
			action: "reveal",
			cwd: "D:/project",
			target: "src/package.json",
		});
		expect(menu.querySelector('[role="status"]')?.textContent).toBe(artifactActionText("revealed"));
		expect(props.onOpenFile).not.toHaveBeenCalled();
		await click(button("预览撤销范围", menu));
		expect(calls.find((request) => request.type === "diffApproval.preview")).toMatchObject({
			entryIds: ["operation-0"],
			mode: "operations",
		});
		expect(calls.some((request) => request.type === "diffApproval.resolve")).toBe(false);
		if (trigger.getAttribute("aria-expanded") === "false") await click(trigger);
		menu = container.querySelector<HTMLElement>('[role="menu"]')!;
		const focus = vi.spyOn(trigger, "focus");
		const escape = new window.Event("keydown", { bubbles: true });
		Object.assign(escape, { key: "Escape" });
		await act(async () => menu.querySelector("button")!.dispatchEvent(escape));
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(focus).toHaveBeenCalledOnce();
	});

	it("closes an open menu when its focused action blurs to the same trigger before clicking it", async () => {
		await render();
		const trigger = container.querySelector<HTMLButtonElement>(".owl-changes-act.is-more")!;
		await click(trigger);
		const action = container.querySelector<HTMLButtonElement>('[role="menu"] button')!;
		const focusout = new window.Event("focusout", { bubbles: true });
		Object.assign(focusout, { relatedTarget: trigger });
		await act(async () => action.dispatchEvent(focusout));
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		await click(trigger);
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await click(trigger);
		expect(container.querySelector('[role="menu"] button')).not.toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
	});
});
