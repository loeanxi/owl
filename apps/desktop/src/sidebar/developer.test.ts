import assert from "node:assert/strict";
import { test } from "node:test";
import { openDeveloperWorkbench } from "./developer.ts";
import type { SidebarState, SidebarTab } from "./store.ts";

function fixture(initial: SidebarTab[] = []) {
	const tabs = [...initial];
	let activeId: string | undefined;
	const store = {
		getState: () => ({ tabs } as SidebarState),
		activate: (id: string) => { activeId = id; },
		openSingleton: (kind: string, title = kind) => {
			if (!tabs.some((tab) => tab.id === kind)) tabs.push({ id: kind, kind, title });
			activeId = kind;
		},
		openNew: (kind: string, title: string) => {
			const id = `${kind}:${tabs.length}`;
			tabs.push({ id, kind, title });
			activeId = id;
		},
	};
	return { store, tabs, active: () => activeId };
}

test("opening and reopening the developer layout preserves drafts and leaves terminals alone", () => {
	const draft = { id: "editor:main.ts", kind: "editor", title: "main.ts", path: "main.ts" };
	const { store, tabs, active } = fixture([draft, { id: "terminal:existing", kind: "terminal", title: "终端" }]);
	assert.equal(openDeveloperWorkbench(store, () => true), true);
	assert.equal(openDeveloperWorkbench(store, () => true), true);
	// 终端归底栏专管：侧栏预设既不新建也不动已有终端 tab
	assert.equal(tabs.length, 4);
	assert.equal(tabs[0], draft);
	assert.equal(tabs.filter((tab) => tab.kind === "terminal").length, 1);
	assert.equal(active(), "files");
});

test("developer layout creates missing tools while respecting disabled panels", () => {
	const { store, tabs, active } = fixture();
	assert.equal(openDeveloperWorkbench(store, (kind) => kind !== "files"), true);
	assert.deepEqual(tabs.map((tab) => tab.kind), ["changes"]);
	assert.equal(active(), "changes");
});

test("fully disabled developer tools leave the workspace untouched", () => {
	const { store, tabs, active } = fixture([{ id: "browser:1", kind: "browser", title: "资料" }]);
	assert.equal(openDeveloperWorkbench(store, () => false), false);
	assert.equal(tabs.length, 1);
	assert.equal(active(), undefined);
});
