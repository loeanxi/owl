import { describe, expect, it } from "vitest";
import { createEmbedReducer, type EmbedAction, type EmbedState } from "../src/modes/desktop/mirror/embed-state.ts";

function run(state: EmbedState, ...actions: EmbedAction[]): { state: EmbedState; effects: ReturnType<ReturnType<typeof createEmbedReducer>["effectsOf"]> } {
	const reducer = createEmbedReducer();
	let current = state;
	let effects: ReturnType<ReturnType<typeof createEmbedReducer>["effectsOf"]> = [];
	for (const action of actions) {
		const result = reducer(current, action);
		current = result.state;
		effects = result.effects;
	}
	return { state: current, effects };
}

const restored: EmbedState = { phase: "restored" };

describe("嵌入状态机", () => {
	it("restored + embed → 发出 embed 效果，进入 embedded 可见", () => {
		const { state, effects } = run(restored, { type: "embed", mode: "sidebar" });
		expect(state).toEqual({ phase: "embedded", mode: "sidebar", visible: true });
		expect(effects).toEqual([{ kind: "embed", mode: "sidebar" }]);
	});

	it("同模式重复 embed → 无效果", () => {
		const { effects } = run({ phase: "embedded", mode: "sidebar", visible: true }, { type: "embed", mode: "sidebar" });
		expect(effects).toEqual([]);
	});

	it("embedded 中切模式 → 发出 relayout", () => {
		const { state, effects } = run(
			{ phase: "embedded", mode: "sidebar", visible: true },
			{ type: "setMode", mode: "expand" },
		);
		expect(state.mode).toBe("expand");
		expect(effects).toEqual([{ kind: "relayout", mode: "expand" }]);
	});

	it("隐藏 → 只发一次 hide；再隐藏无效果；显示 → show 并回到可见", () => {
		const reducer = createEmbedReducer();
		let state: EmbedState = { phase: "embedded", mode: "sidebar", visible: true };
		let result = reducer(state, { type: "setVisible", visible: false });
		state = result.state;
		expect(state.visible).toBe(false);
		expect(result.effects).toEqual([{ kind: "hide" }]);
		result = reducer(state, { type: "setVisible", visible: false });
		expect(result.effects).toEqual([]);
		result = reducer(state, { type: "setVisible", visible: true });
		state = result.state;
		expect(state.visible).toBe(true);
		expect(result.effects).toEqual([{ kind: "show" }]);
	});

	it("隐藏中切模式：只更新状态不发效果（show 时一并生效）", () => {
		const reducer = createEmbedReducer();
		let state: EmbedState = { phase: "embedded", mode: "sidebar", visible: true };
		state = reducer(state, { type: "setVisible", visible: false }).state;
		const result = reducer(state, { type: "setMode", mode: "float" });
		expect(result.state).toEqual({ phase: "embedded", mode: "float", visible: false });
		expect(result.effects).toEqual([]);
	});

	it("float 拖放新矩形：可见时 relayout，隐藏时只记状态", () => {
		const reducer = createEmbedReducer();
		const visible = { phase: "embedded", mode: "float", visible: true } as EmbedState;
		const rect = { x: 40, y: 60, width: 300, height: 500 };
		const r1 = reducer(visible, { type: "setFloatRect", rect });
		expect(r1.effects).toEqual([{ kind: "relayout", mode: "float" }]);
		expect(r1.state.floatRect).toEqual(rect);

		const hidden = { phase: "embedded", mode: "float", visible: false } as EmbedState;
		const r2 = reducer(hidden, { type: "setFloatRect", rect });
		expect(r2.effects).toEqual([]);
	});

	it("embedded + restore → 发出 restore 效果回到 restored", () => {
		const { state, effects } = run(
			{ phase: "embedded", mode: "sidebar", visible: true },
			{ type: "restore" },
		);
		expect(state.phase).toBe("restored");
		expect(effects).toEqual([{ kind: "restore" }]);
	});

	it("restored + restore / setVisible → 无效果", () => {
		const r1 = run(restored, { type: "restore" });
		expect(r1.effects).toEqual([]);
		const r2 = run(restored, { type: "setVisible", visible: false });
		expect(r2.effects).toEqual([]);
	});

	it("窗口消失 → 直接回 restored，无还原效果（窗口已不存在）", () => {
		const { state, effects } = run(
			{ phase: "embedded", mode: "float", visible: true },
			{ type: "windowGone" },
		);
		expect(state.phase).toBe("restored");
		expect(effects).toEqual([]);
	});
});
