import assert from "node:assert/strict";
import test from "node:test";
import { fitPaneSize, sidebarWidthLimit, workbenchDock } from "./pane-sizing.ts";

test("restored wide panes preserve a 320px conversation in a 1280px desktop", () => {
	// 52px rail + 8px frame margin + 2px frame border leave 1218px for all panes.
	const available = 1218;
	const sidebar = Math.min(720, sidebarWidthLimit(available));
	const workspace = available - sidebar;
	const tools = fitPaneSize(950, 280, workspace, 320);
	assert.equal(workbenchDock("right", workspace), "right");
	assert.equal(workspace - tools, 320);
	assert.equal(sidebar, 618);
});

test("the actual parent width triggers stacking, including the 600px boundary", () => {
	assert.equal(workbenchDock("right", 600), "right");
	assert.equal(workbenchDock("right", 599), "bottom");
	assert.equal(workbenchDock("bottom", 1600), "bottom");
	const available = 738;
	assert.equal(sidebarWidthLimit(available), 200);
	assert.equal(workbenchDock("right", available - sidebarWidthLimit(available)), "bottom");
});

test("tools closing releases the extra sidebar reserve", () => {
	assert.equal(sidebarWidthLimit(1218, true), 618);
	assert.equal(sidebarWidthLimit(1218, false), 720);
});

test("a saved preference is usable again after the parent grows", () => {
	const preference = 950;
	assert.equal(fitPaneSize(preference, 280, 600, 320), 280);
	assert.equal(fitPaneSize(preference, 280, 1858, 320), preference);
});

test("stacked tools and a terminal both leave room for the composer", () => {
	const workspaceHeight = 514;
	const tools = fitPaneSize(500, 140, workspaceHeight, 320);
	const terminal = fitPaneSize(500, 140, workspaceHeight - tools, 180);
	assert.equal(workspaceHeight - tools - terminal, 180);
});

test("tiny, hidden, and invalid sizes never produce negative or infinite dimensions", () => {
	assert.equal(fitPaneSize(500, 140, 100, 180), 0);
	assert.equal(fitPaneSize(500, 140, 0, 180), 0);
	assert.equal(fitPaneSize(Number.POSITIVE_INFINITY, 280, 1000, 320), 280);
	assert.equal(fitPaneSize(500, 140, Number.NaN, 180), 0);
});
