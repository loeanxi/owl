/**
 * 分屏分隔条的行为测试：比例夹取、复位、只动目标分隔条。
 * UI 侧的分隔条（拖动提示 / 双击复位 / 方向键）都落在这几个 store 行为上。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clampSplitRatio, SidebarStore, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN, type SplitNode } from "./store.ts";

/** 造一个左右分屏：文件在左，文件变动被拖到右边切开。返回分隔条 id。 */
function splitStore(): { store: SidebarStore; splitId: string } {
	const store = new SidebarStore("D:/split-pane-fixture");
	store.openSingleton("files", "文件");
	const left = store.getState().activePane;
	store.openSingleton("changes", "文件变动");
	store.moveTab("changes", left, "right");
	const tree = store.getState().tree;
	assert.equal(tree.kind, "split");
	return { store, splitId: (tree as Extract<SplitNode, { kind: "split" }>).id };
}

/** 再切一层：文件变动那一侧上下分屏，得到嵌套的两条分隔条。 */
function nestedSplitStore(): { store: SidebarStore; outerId: string; innerId: string } {
	const store = new SidebarStore("D:/split-pane-nested-fixture");
	store.openSingleton("files", "文件");
	const left = store.getState().activePane;
	store.openSingleton("changes", "文件变动");
	store.moveTab("changes", left, "right");
	const outer = store.getState().tree as Extract<SplitNode, { kind: "split" }>;
	store.openSingleton("tasks", "任务管理");
	store.moveTab("tasks", outer.b.id, "down");
	const tree = store.getState().tree as Extract<SplitNode, { kind: "split" }>;
	const inner = tree.b as Extract<SplitNode, { kind: "split" }>;
	return { store, outerId: tree.id, innerId: inner.id };
}

function ratioOf(tree: SplitNode, splitId: string): number | undefined {
	if (tree.kind === "leaf") return undefined;
	if (tree.id === splitId) return tree.ratio;
	return ratioOf(tree.a, splitId) ?? ratioOf(tree.b, splitId);
}

test("分屏比例夹在 SPLIT_RATIO_MIN–SPLIT_RATIO_MAX 之间", () => {
	assert.equal(clampSplitRatio(0.5), 0.5);
	assert.equal(clampSplitRatio(0), SPLIT_RATIO_MIN);
	assert.equal(clampSplitRatio(1), SPLIT_RATIO_MAX);
	assert.equal(clampSplitRatio(-3), SPLIT_RATIO_MIN);
	assert.equal(clampSplitRatio(4), SPLIT_RATIO_MAX);
});

test("拖到边缘时比例被夹住，不会把一侧压没", () => {
	const { store, splitId } = splitStore();
	store.setRatio(splitId, 0, { persist: false });
	assert.equal(ratioOf(store.getState().tree, splitId), SPLIT_RATIO_MIN);
	store.setRatio(splitId, 1, { persist: false });
	assert.equal(ratioOf(store.getState().tree, splitId), SPLIT_RATIO_MAX);
});

test("双击分隔条复位到一半", () => {
	const { store, splitId } = splitStore();
	store.setRatio(splitId, 0.2, { persist: false });
	assert.equal(ratioOf(store.getState().tree, splitId), 0.2);
	store.setRatio(splitId, 0.5, { persist: true });
	assert.equal(ratioOf(store.getState().tree, splitId), 0.5);
});

test("调整一条分隔条不会动到别的分隔条", () => {
	const { store, outerId, innerId } = nestedSplitStore();
	store.setRatio(outerId, 0.3, { persist: false });
	assert.equal(ratioOf(store.getState().tree, outerId), 0.3);
	assert.equal(ratioOf(store.getState().tree, innerId), 0.5);
});
