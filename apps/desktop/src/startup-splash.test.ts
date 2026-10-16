import assert from "node:assert/strict";
import test from "node:test";
import {
	SPLASH_DURATION,
	SPLASH_FADE_START,
	createMeteors,
	createStars,
	eyeOpenness,
	eyeRedness,
	playStartupSplash,
	span,
} from "./startup-splash.ts";

test("星空确定性生成：同一 seed 每次启动一致", () => {
	assert.deepEqual(createStars(50), createStars(50));
	assert.equal(createStars(80).length, 80);
});

test("流星雨：数量多、按开始时间排序、都在淡出前出现", () => {
	const meteors = createMeteors();
	assert.ok(meteors.length >= 40);
	for (let i = 1; i < meteors.length; i++) assert.ok(meteors[i - 1].start <= meteors[i].start);
	assert.ok(meteors.every((m) => m.start < SPLASH_FADE_START));
});

test("时间线单调：淡出在总时长之前开始", () => {
	assert.ok(SPLASH_FADE_START < SPLASH_DURATION);
	assert.equal(span(-1, 0, 1), 0);
	assert.equal(span(2, 0, 1), 1);
	assert.equal(span(0.5, 0, 1), 0.5);
});

test("眼睛：闭着 → 微睁一线 → 完全睁开", () => {
	assert.ok(eyeOpenness(0) < 1e-9);
	assert.ok(eyeOpenness(1.3) < 1e-9); // 眼窝浮现时仍是闭着的
	const peek = eyeOpenness(1.55); // 睁开前的停顿：只露一线
	assert.ok(peek > 0.1 && peek < 0.35);
	assert.ok(Math.abs(eyeOpenness(2.2) - 1) < 0.05);
	assert.ok(Math.abs(eyeOpenness(3.5) - 1) < 0.05);
});

test("眼睛：睁开后才变红，红化程度单调递增到 1", () => {
	assert.equal(eyeRedness(0), 0);
	assert.equal(eyeRedness(2.0), 0); // 刚睁开时仍是绿色
	assert.ok(eyeRedness(2.4) > 0 && eyeRedness(2.4) < 1);
	assert.ok(eyeRedness(2.4) < eyeRedness(2.5));
	assert.equal(eyeRedness(3.5), 1);
});

test("无 Canvas/rAF 环境（node）下直接返回空操作，不抛错", () => {
	const handle = playStartupSplash();
	assert.doesNotThrow(() => handle.dismiss());
});
