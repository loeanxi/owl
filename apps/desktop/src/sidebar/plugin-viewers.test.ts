import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewerChangedHandler } from "../bridge/client.ts";
import type { ViewerListResult, WorkspaceViewerInfo } from "../bridge/protocol.ts";
import { viewerKindForPath } from "./config.ts";
import { attachPluginViewers } from "./plugin-viewers.ts";
import { fileViewerForPath } from "./registry.ts";
import type { SidebarState, SidebarTab } from "./store.ts";

function fixture() {
	const changed = new Set<ViewerChangedHandler>();
	const status = new Set<(connected: boolean) => void>();
	const requests: Array<(result: { ok: boolean; result?: ViewerListResult }) => void> = [];
	const tabs: SidebarTab[] = [];
	const closed: string[] = [];
	const client = {
		request<T>(): Promise<{ ok: boolean; result?: T }> {
			return new Promise((resolve) => requests.push((result) => resolve({ ok: result.ok, result: result.result as T })));
		},
		onViewersChanged: (handler: ViewerChangedHandler) => { changed.add(handler); return () => changed.delete(handler); },
		onStatus: (handler: (connected: boolean) => void) => { status.add(handler); return () => status.delete(handler); },
	};
	const store = { getState: () => ({ tabs } as SidebarState), closeTab: (id: string) => { closed.push(id); } };
	return {
		client, store, requests, tabs, closed,
		changed: (viewers: WorkspaceViewerInfo[]) => { for (const handler of changed) handler({ type: "viewer.changed", viewers }); },
		connect: () => { for (const handler of status) handler(true); },
	};
}

const office: WorkspaceViewerInfo = { id: "univer-office", title: "Office", extensions: ["univer", "xlsx", "docx", "pptx"] };

test("plugin viewers take precedence over system opening and unload removes their open tabs", async () => {
	const f = fixture();
	assert.equal(viewerKindForPath("report.xlsx"), undefined);
	const dispose = attachPluginViewers(f.client, f.store, () => null, () => null);
	try {
		f.requests[0]({ ok: true, result: { viewers: [office] } });
		await Promise.resolve();
		for (const extension of office.extensions) assert.equal(viewerKindForPath(`report.${extension.toUpperCase()}`), "plugin-viewer:univer-office");
		assert.equal(fileViewerForPath("report.univer")?.workspaceViewerId, "univer-office");
		assert.equal(viewerKindForPath("report.pdf"), undefined);
		assert.equal(viewerKindForPath("report.xlsx", { disabledTabs: [], disabledViewers: ["plugin-viewer:univer-office"], injectOpenTool: false }), undefined);
		f.tabs.push({ id: "plugin-viewer:univer-office:report.univer", kind: "plugin-viewer:univer-office", title: "report.univer", path: "report.univer" });
		f.changed([]);
		assert.deepEqual(f.closed, ["plugin-viewer:univer-office:report.univer"]);
		assert.equal(viewerKindForPath("report.xlsx"), undefined);
		assert.equal(fileViewerForPath("report.univer"), undefined);
	} finally { dispose(); }
});

test("a stale discovery response cannot overwrite a newer plugin event or survive disposal", async () => {
	const f = fixture();
	const dispose = attachPluginViewers(f.client, f.store, () => null, () => null);
	f.changed([office]);
	f.requests[0]({ ok: true, result: { viewers: [] } });
	await Promise.resolve();
	assert.equal(viewerKindForPath("report.xlsx"), "plugin-viewer:univer-office");
	f.connect();
	assert.equal(f.requests.length, 2);
	dispose();
	f.requests[1]({ ok: true, result: { viewers: [office] } });
	await Promise.resolve();
	assert.equal(viewerKindForPath("report.xlsx"), undefined);
});
