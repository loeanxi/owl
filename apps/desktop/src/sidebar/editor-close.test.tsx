import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { EditorDraftSummary } from "../bridge/protocol.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { EditorCloseDialog } from "./EditorCloseDialog.tsx";
import { EditorDraftRecovery } from "./EditorDraftRecovery.tsx";
import type { EditorGuard } from "./editor-close.ts";
import { editorWalKey } from "./editor-controller.ts";
import { listEditorLocalDrafts } from "./editor-local-drafts.ts";
import { SidebarStore } from "./store.ts";

let root: Root;
let container: HTMLElement;
let store: SidebarStore;
interface TestEditor {
	id: string;
	dirty: boolean;
	version: number;
	protected: boolean;
	guard: EditorGuard;
}
function editor(path = "file.ts"): TestEditor {
	store.openFileTab("editor", path, path);
	const model: TestEditor = { id: `editor:${path}`, dirty: true, version: 1, protected: false, guard: undefined! };
	model.guard = {
		isDirty: () => model.dirty,
		revision: () => model.version,
		isProtected: () => model.protected,
		save: vi.fn(async () => {
			model.dirty = false;
			store.setDirty(model.id, false);
			return true;
		}),
		preserveDraft: vi.fn(async () => {
			model.protected = true;
			return true;
		}),
		discard: vi.fn(async () => {
			model.dirty = false;
			store.setDirty(model.id, false);
			return true;
		}),
	};
	store.setDirty(model.id, true);
	store.registerEditor(model.id, model.guard);
	return model;
}

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	store = new SidebarStore("D:/project");
});
afterEach(async () => {
	store.editorClose.cancel();
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
async function render(): Promise<void> {
	await act(async () =>
		root.render(
			<div hidden>
				<EditorCloseDialog store={store} />
			</div>,
		),
	);
}

describe("editor closure keeps the unique working buffer", () => {
	it("shows a portal even when its workbench is hidden, and cancel retains the dirty tab", async () => {
		const model = editor();
		await render();
		let closing: Promise<boolean>;
		await act(async () => {
			closing = store.closeTab(model.id);
		});
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		expect(container.querySelector('[role="alertdialog"]')).toBeNull();
		await act(async () => store.editorClose.choose("cancel"));
		expect(await closing!).toBe(false);
		expect(store.getState().tabs.map((tab) => tab.id)).toContain(model.id);
	});

	it.each(["save", "preserve", "discard"] as const)(
		"closes only after %s succeeds and collapses duplicate same-tick clicks",
		async (choice) => {
			const model = editor();
			await render();
			const first = store.closeTab(model.id);
			const repeated = store.closeTab(model.id);
			expect(first).toBe(repeated);
			await act(async () => {});
			await act(async () => store.editorClose.choose(choice));
			expect(await first).toBe(true);
			expect(store.getState().tabs).toHaveLength(0);
			expect(
				choice === "preserve"
					? model.guard.preserveDraft
					: choice === "save"
						? model.guard.save
						: model.guard.discard,
			).toHaveBeenCalledOnce();
		},
	);

	it("keeps the editor open if saving or draft storage fails", async () => {
		const model = editor();
		model.guard.preserveDraft = vi.fn(async () => false);
		await render();
		const closing = store.closeTab(model.id);
		await act(async () => {});
		await act(async () => store.editorClose.choose("preserve"));
		expect(store.editorClose.getSnapshot()).toMatchObject({ error: "editor-not-ready", pending: false });
		expect(store.getState().tabs).toHaveLength(1);
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => store.editorClose.choose("cancel"));
		expect(await closing).toBe(false);
	});

	it("does not discard a buffer when the draft's conditional removal reports another window changed it", async () => {
		const model = editor();
		model.guard.discard = vi.fn(async () => false);
		await render();
		const closing = store.closeTab(model.id);
		await act(async () => {});
		await act(async () => store.editorClose.choose("discard"));
		expect(model.dirty).toBe(true);
		expect(store.getState().tabs).toHaveLength(1);
		await act(async () => store.editorClose.choose("cancel"));
		expect(await closing).toBe(false);
	});

	it("preserves drafts automatically before leaving a project", async () => {
		const first = editor("first.ts");
		const second = editor("second.ts");
		expect(store.hasUnprotectedEdits()).toBe(true);
		expect(await store.prepareToLeave()).toBe(true);
		expect(first.guard.preserveDraft).toHaveBeenCalledOnce();
		expect(second.guard.preserveDraft).toHaveBeenCalledOnce();
		expect(store.getState().tabs).toHaveLength(2);
		expect(store.hasUnprotectedEdits()).toBe(false);
	});

	it("does not leave if an earlier buffer changes while a later buffer is being preserved", async () => {
		const first = editor("first.ts");
		const second = editor("second.ts");
		const pending = Promise.withResolvers<boolean>();
		second.guard.preserveDraft = () => pending.promise;
		await render();
		let leaving: Promise<boolean>;
		await act(async () => {
			leaving = store.prepareToLeave();
		});
		first.version++;
		await act(async () => pending.resolve(true));
		expect(store.editorClose.getSnapshot()?.error).toBe("editor-changed");
		expect(store.getState().tabs).toHaveLength(2);
		await act(async () => store.editorClose.choose("cancel"));
		expect(await leaving!).toBe(false);
	});

	it("includes a newly opened dirty file in the final project-leave safety check", async () => {
		const first = editor();
		const pending = Promise.withResolvers<boolean>();
		first.guard.preserveDraft = () => pending.promise;
		await render();
		let leaving: Promise<boolean>;
		await act(async () => {
			leaving = store.prepareToLeave();
		});
		editor("new.ts");
		await act(async () => pending.resolve(true));
		expect(store.editorClose.getSnapshot()?.error).toBe("editor-changed");
		await act(async () => store.editorClose.choose("cancel"));
		expect(await leaving!).toBe(false);
	});

	it("guards close-others and close-all without clearing an unrelated dirty tab", async () => {
		const first = editor("first.ts");
		const second = editor("second.ts");
		await render();
		let closing: Promise<boolean>;
		await act(async () => {
			closing = store.closeOthers(first.id);
		});
		await act(async () => store.editorClose.choose("cancel"));
		expect(await closing!).toBe(false);
		expect(store.getState().dirty[second.id]).toBe(true);
		await act(async () => {
			closing = store.closeAll();
		});
		await act(async () => store.editorClose.choose("preserve"));
		expect(await closing!).toBe(true);
		expect(store.getState().tabs).toHaveLength(0);
	});

	it.each(["move", "rename", "delete"] as const)(
		"does not unmount a dirty editor for %s while preservation fails",
		async (operation) => {
			const model = editor("folder/file.ts");
			model.guard.preserveDraft = async () => false;
			await render();
			const leaf = store.getState().activePane;
			await act(async () => {
				if (operation === "move") store.moveTab(model.id, leaf, "right");
				else if (operation === "rename") store.remapPath("folder", "renamed");
				else store.dropPath("folder");
			});
			expect(store.getState().tabs[0]?.id).toBe(model.id);
			expect(store.editorClose.getSnapshot()?.error).toBe("editor-not-ready");
			await act(async () => store.editorClose.choose("cancel"));
		},
	);
});

describe("draft discovery follows account and workspace", () => {
	const draft: EditorDraftSummary = {
		cwd: "D:/project",
		path: "orphan.ts",
		updatedAt: 1,
		draftRevision: "draft-one",
		size: 12,
		baseRevision: "base-one",
	};
	it("finds a closed-tab draft and opens an editor without saving or deleting it", async () => {
		const request = vi.fn(async (_input: unknown) => ({ ok: true, result: { drafts: [draft] } }));
		const onOpen = vi.fn();
		await act(async () =>
			root.render(
				<EditorDraftRecovery
					client={{ request } as unknown as BridgeClient}
					cwd="D:/project"
					profile="D:/profile"
					connected
					store={store}
					onOpen={onOpen}
				/>,
			),
		);
		expect(request).toHaveBeenCalledWith({
			type: "editor.draft.list",
			cwd: "D:/project",
			expectedProfile: "D:/profile",
		});
		expect(container.textContent).toContain("orphan.ts");
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>("button")]
				.find((button) => button.textContent?.includes("orphan.ts"))!
				.click(),
		);
		expect(store.getState().tabs[0]).toMatchObject({ kind: "editor", path: "orphan.ts" });
		expect(onOpen).toHaveBeenCalledOnce();
		expect(request.mock.calls.every(([input]) => (input as { type: string }).type === "editor.draft.list")).toBe(
			true,
		);
	});

	it("does not expose a late draft listing from another account", async () => {
		const pending = Promise.withResolvers<{ ok: boolean; result: { drafts: EditorDraftSummary[] } }>();
		const request = vi
			.fn()
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ ok: true, result: { drafts: [] } });
		const client = { request } as unknown as BridgeClient;
		await act(async () =>
			root.render(
				<EditorDraftRecovery
					client={client}
					cwd="D:/project"
					profile="D:/old-profile"
					connected
					store={store}
					onOpen={() => {}}
				/>,
			),
		);
		await act(async () =>
			root.render(
				<EditorDraftRecovery
					client={client}
					cwd="D:/project"
					profile="D:/new-profile"
					connected
					store={store}
					onOpen={() => {}}
				/>,
			),
		);
		await act(async () => pending.resolve({ ok: true, result: { drafts: [draft] } }));
		expect(container.textContent).not.toContain("orphan.ts");
	});

	it("discovers an orphan local backup while offline, without calling the host", async () => {
		const key = `${editorWalKey("D:/profile", "D:/project", "orphan].ts")}.writer.one`;
		const record = JSON.stringify({
			content: "local only",
			baseContent: "base",
			baseRevision: "base-one",
			localRevision: 2,
			updatedAt: 2,
			editorId: "writer.one",
			token: "token-one",
		});
		const storage = new Map([[key, record]]);
		vi.stubGlobal("localStorage", {
			getItem: (name: string) => storage.get(name) ?? null,
			key: (index: number) => [...storage.keys()][index] ?? null,
			length: storage.size,
		});
		const request = vi.fn();
		await act(async () =>
			root.render(
				<EditorDraftRecovery
					client={{ request } as unknown as BridgeClient}
					cwd="D:/project"
					profile="D:/profile"
					connected={false}
					store={store}
					onOpen={() => {}}
				/>,
			),
		);
		expect(container.textContent).toContain("orphan].ts");
		expect(container.textContent).toContain("1 份本机备份");
		expect(request).not.toHaveBeenCalled();
		const open = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			button.textContent?.includes("orphan].ts"),
		)!;
		expect(open.disabled).toBe(false);
		await act(async () => open.click());
		expect(store.getState().tabs[0].path).toBe("orphan].ts");
	});

	it("lists writer-scoped local metadata without reading another profile or altering any backup", () => {
		const records = new Map<string, string>();
		for (const [profile, cwd, writer] of [
			["D:/profile", "D:/project", "writer.one"],
			["D:/profile", "D:/project", "writer-two"],
			["D:/other", "D:/project", "other-writer"],
			["D:/profile", "D:/another", "another-project"],
		])
			records.set(
				`${editorWalKey(profile, cwd, "a].ts")}.${writer}`,
				JSON.stringify({
					content: writer,
					baseContent: "base",
					baseRevision: null,
					localRevision: 1,
					updatedAt: 1,
					editorId: writer,
					token: writer,
				}),
			);
		const storage = {
			getItem: vi.fn((key: string) => records.get(key) ?? null),
			key: (index: number) => [...records.keys()][index] ?? null,
			length: records.size,
		};
		expect(listEditorLocalDrafts(storage, "D:/profile", "D:/project").map((draft) => draft.editorId)).toEqual([
			"writer.one",
			"writer-two",
		]);
		expect(storage.getItem.mock.calls).toHaveLength(2);
		expect(records.size).toBe(4);
	});
});
