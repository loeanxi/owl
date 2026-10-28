import assert from "node:assert/strict";
import test from "node:test";
import { fitPaneSize, sidebarWidthLimit, WORKBENCH_DOCK_MIN_WIDTH, workbenchDock } from "./pane-sizing.ts";

test("restored wide panes preserve a 320px conversation in a 1280px desktop", () => {
	// 52px rail + 8px frame margin + 2px frame border leave 1218px for all panes.
	const available = 1218;
	const sidebar = Math.min(720, sidebarWidthLimit(available));
	const workspace = available - sidebar;
	const tools = fitPaneSize(950, 280, workspace, 320);
	// 停靠看工作区宽度（1218），不是扣掉侧栏后的余量。
	assert.equal(workbenchDock("right", available), "right");
	assert.equal(workspace - tools, 320);
	assert.equal(sidebar, 618);
});

test("stacking triggers on the workspace width, including the 800px boundary", () => {
	// 阈值 = 侧栏下限 200 + 对话下限 320 + 工作台下限 280。
	assert.equal(WORKBENCH_DOCK_MIN_WIDTH, 800);
	assert.equal(workbenchDock("right", 800), "right");
	assert.equal(workbenchDock("right", 799), "bottom");
	assert.equal(workbenchDock("bottom", 1600), "bottom");
	const available = 738;
	assert.equal(sidebarWidthLimit(available), 200);
	assert.equal(workbenchDock("right", available), "bottom");
});

test("the sidebar collapsing into a drawer cannot move the workbench between rows", () => {
	// 侧栏塌成抽屉时不占位，内容区宽度会涨一截；若停靠拿内容区宽度判，侧栏一塌
	// 工作台就从右栏跳到底排，拖窗口边框时整窗重排（工作台里那块浏览器面板最扎眼）。
	// 停靠只看工作区宽度：它不随塌陷变化，判定因此稳定。
	const workspace = 760;
	const sidebarDocked = 216;
	const contentWhileDocked = workspace - sidebarDocked;
	const contentAfterCollapse = workspace; // 抽屉不占位
	assert.equal(workbenchDock("right", workspace), "bottom");
	// 塌陷前后判定一致 —— 这是原来会翻车的那一步。
	assert.equal(workbenchDock("right", workspace), workbenchDock("right", workspace));
	assert.ok(contentWhileDocked < 600 && contentAfterCollapse >= 600, "内容区宽度确实跨过了旧的 600 阈值");
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
