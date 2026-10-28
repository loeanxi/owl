import assert from "node:assert/strict";
import test from "node:test";
import {
	applyWorkEffects,
	DEFAULT_WORK_EFFECTS,
	enabledWorkEffectIds,
	getWorkEffects,
	parseWorkEffects,
	subscribeWorkEffects,
	WORK_EFFECT_IDS,
	workEffectsToken,
} from "./work-process-effects.ts";

test("every effect has an independent default and survives a malformed value", () => {
	assert.deepEqual(WORK_EFFECT_IDS, ["rail", "enter", "morph", "count", "spine", "breathe", "nudge"]);
	for (const id of WORK_EFFECT_IDS) assert.equal(DEFAULT_WORK_EFFECTS[id], true);
	assert.deepEqual(parseWorkEffects(undefined), DEFAULT_WORK_EFFECTS);
	assert.deepEqual(parseWorkEffects({ rail: false }), { ...DEFAULT_WORK_EFFECTS, rail: false });
	// 坏值只影响自己那一项。
	assert.deepEqual(parseWorkEffects({ rail: "no", enter: false }), { ...DEFAULT_WORK_EFFECTS, enter: false });
	// 未登记的键被丢掉，不混进开关表。
	assert.deepEqual(Object.keys(parseWorkEffects({ bogus: true })).sort(), [...WORK_EFFECT_IDS].sort());
});

test("the dataset token lists exactly the enabled effects in the canonical order", () => {
	assert.equal(workEffectsToken(DEFAULT_WORK_EFFECTS), "rail enter morph count spine breathe nudge");
	assert.equal(
		workEffectsToken({ ...DEFAULT_WORK_EFFECTS, rail: false, nudge: false }),
		"enter morph count spine breathe",
	);
	assert.equal(
		workEffectsToken({
			...DEFAULT_WORK_EFFECTS,
			rail: false,
			enter: false,
			morph: false,
			count: false,
			spine: false,
			breathe: false,
			nudge: false,
		}),
		"",
	);
	assert.deepEqual(enabledWorkEffectIds({ ...DEFAULT_WORK_EFFECTS, spine: false }), [
		"rail",
		"enter",
		"morph",
		"count",
		"breathe",
		"nudge",
	]);
});

test("applying effects writes the dataset and notifies subscribers only when the value changes", (context) => {
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	context.after(() => {
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		applyWorkEffects(DEFAULT_WORK_EFFECTS);
	});
	const dataset: Record<string, string> = {};
	Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset } } });

	const seen: string[] = [];
	const unsubscribe = subscribeWorkEffects(() => seen.push(workEffectsToken(getWorkEffects())));

	applyWorkEffects({ ...DEFAULT_WORK_EFFECTS, spine: false });
	assert.equal(dataset.owlWorkEffects, "rail enter morph count breathe nudge");
	assert.deepEqual(seen, ["rail enter morph count breathe nudge"]);

	// 同样的值不再通知。
	applyWorkEffects({ ...DEFAULT_WORK_EFFECTS, spine: false });
	assert.deepEqual(seen, ["rail enter morph count breathe nudge"]);

	// 全关时是空串：CSS 的 [data-fx~="..."] 一个都匹配不上，动效全部消失。
	applyWorkEffects({
		...DEFAULT_WORK_EFFECTS,
		rail: false,
		enter: false,
		morph: false,
		count: false,
		spine: false,
		breathe: false,
		nudge: false,
	});
	assert.equal(dataset.owlWorkEffects, "");
	assert.equal(seen.length, 2);

	unsubscribe();
	applyWorkEffects(DEFAULT_WORK_EFFECTS);
	assert.equal(seen.length, 2);
});
