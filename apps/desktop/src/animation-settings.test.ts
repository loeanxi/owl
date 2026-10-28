import assert from "node:assert/strict";
import test from "node:test";
import { ambientGain, createAmbientStars } from "./ambient-background.ts";
import {
	ANIMATION_MIRROR_KEY,
	applyOwlAnimation,
	DEFAULT_OWL_ANIMATION,
	getOwlAnimation,
	isGlassPreset,
	parseOwlAnimation,
	readAnimationMirror,
	subscribeOwlAnimation,
} from "./animation-settings.ts";

test("isGlassPreset: 背景动画只支持毛玻璃系预设，其余主题一律不显示", () => {
	assert.equal(isGlassPreset("liquid-glass"), true);
	assert.equal(isGlassPreset("frost"), true);
	for (const id of [
		"",
		undefined,
		"owl-green",
		"codex",
		"claude",
		"ink",
		"ink-hc",
		"high-contrast",
		"polar-night",
		"abyss",
		"quiet-light",
		"some-unknown-theme",
	]) {
		assert.equal(isGlassPreset(id), false, String(id));
	}
});

test("parseOwlAnimation: 旧版本存下的 ambientStyle 等多余字段被忽略，不影响其它设置", () => {
	const parsed = parseOwlAnimation({ ambientStyle: "edge", ambientIntensity: 70 });
	assert.equal(parsed.ambientIntensity, 70);
	assert.equal("ambientStyle" in parsed, false);
});

const storageOf = (items: Record<string, string>): Pick<Storage, "getItem"> => ({
	getItem: (key) => items[key] ?? null,
});

test("parseOwlAnimation: 缺省/垃圾输入回退到默认值", () => {
	assert.deepEqual(parseOwlAnimation(undefined), { ...DEFAULT_OWL_ANIMATION });
	assert.deepEqual(parseOwlAnimation("oops"), { ...DEFAULT_OWL_ANIMATION });
	assert.deepEqual(parseOwlAnimation([1, 2]), { ...DEFAULT_OWL_ANIMATION });
});

test("parseOwlAnimation: 逐字段回退，不因一个坏字段丢掉其它设置", () => {
	const parsed = parseOwlAnimation({
		startupEnabled: false,
		ambientIntensity: "abc",
		fps: 99,
		startupSpeed: "turbo",
		ambientMeteors: "yes",
	});
	assert.equal(parsed.startupEnabled, false);
	assert.equal(parsed.ambientIntensity, DEFAULT_OWL_ANIMATION.ambientIntensity);
	assert.equal(parsed.fps, DEFAULT_OWL_ANIMATION.fps);
	assert.equal(parsed.startupSpeed, "normal");
	assert.equal(parsed.ambientMeteors, DEFAULT_OWL_ANIMATION.ambientMeteors);
});

test("parseOwlAnimation: 强度夹到 10–100 并取整，fps 只接受 15/20/30", () => {
	assert.equal(parseOwlAnimation({ ambientIntensity: 5 }).ambientIntensity, 10);
	assert.equal(parseOwlAnimation({ ambientIntensity: 500 }).ambientIntensity, 100);
	assert.equal(parseOwlAnimation({ ambientIntensity: 33.6 }).ambientIntensity, 34);
	assert.equal(parseOwlAnimation({ fps: 30 }).fps, 30);
	assert.equal(parseOwlAnimation({ fps: 15 }).fps, 15);
	assert.equal(parseOwlAnimation({ fps: 60 }).fps, DEFAULT_OWL_ANIMATION.fps);
});

test("readAnimationMirror: 读镜像、兼容旧开关、损坏 JSON 回退默认", () => {
	assert.equal(
		readAnimationMirror(storageOf({ [ANIMATION_MIRROR_KEY]: JSON.stringify({ ambientEnabled: false }) }))
			.ambientEnabled,
		false,
	);
	assert.equal(readAnimationMirror(storageOf({ "owl.startupSplash": "off" })).startupEnabled, false);
	// 有镜像时旧开关不再起作用
	assert.equal(
		readAnimationMirror(storageOf({ [ANIMATION_MIRROR_KEY]: "{}", "owl.startupSplash": "off" })).startupEnabled,
		true,
	);
	assert.deepEqual(readAnimationMirror(storageOf({ [ANIMATION_MIRROR_KEY]: "{broken" })), {
		...DEFAULT_OWL_ANIMATION,
	});
});

test("applyOwlAnimation: 通知订阅者；相同值幂等不重复通知；退订后不再通知", () => {
	applyOwlAnimation(DEFAULT_OWL_ANIMATION);
	let calls = 0;
	const unsubscribe = subscribeOwlAnimation(() => {
		calls += 1;
	});
	const before = getOwlAnimation();

	applyOwlAnimation({ ...before, ambientIntensity: 80 });
	assert.equal(calls, 1);
	assert.equal(getOwlAnimation().ambientIntensity, 80);

	const same = getOwlAnimation();
	applyOwlAnimation({ ...same });
	assert.equal(calls, 1);
	assert.equal(getOwlAnimation(), same, "无变化时引用保持稳定");

	unsubscribe();
	applyOwlAnimation({ ...same, ambientIntensity: 20 });
	assert.equal(calls, 1);
	applyOwlAnimation(DEFAULT_OWL_ANIMATION);
});

test("ambientGain: 随强度单调递增并夹在 0.3–1.3", () => {
	assert.ok(ambientGain(100) > ambientGain(50));
	assert.ok(ambientGain(50) > ambientGain(10));
	assert.equal(ambientGain(0), ambientGain(10));
	assert.ok(Math.abs(ambientGain(100) - 1.3) < 1e-9);
});

test("createAmbientStars: 确定性、数量正确、坐标在 0–1 内", () => {
	const a = createAmbientStars(110, 7);
	const b = createAmbientStars(110, 7);
	assert.equal(a.length, 110);
	assert.deepEqual(a, b);
	assert.ok(a.every((s) => s.x >= 0 && s.x < 1 && s.y >= 0 && s.y < 1 && s.size > 0));
	assert.notDeepEqual(a, createAmbientStars(110, 8));
});
