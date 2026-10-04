import assert from "node:assert/strict";
import test from "node:test";
import {
	getUiLanguage,
	getUiLanguageSetting,
	parseUiLanguageSetting,
	resolveSystemLanguage,
	setUiLanguageSetting,
	subscribeUiLanguage,
} from "./index.ts";

function stubNavigatorLanguage(value: string | undefined): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
	Object.defineProperty(globalThis.navigator, "language", { value, configurable: true });
	return () => {
		if (descriptor) Object.defineProperty(globalThis.navigator, "language", descriptor);
	};
}

test("parseUiLanguageSetting accepts system/zh/en and falls back to explicit zh", () => {
	assert.equal(parseUiLanguageSetting("system"), "system");
	assert.equal(parseUiLanguageSetting("zh"), "zh");
	assert.equal(parseUiLanguageSetting("en"), "en");
	for (const bad of [undefined, null, false, "auto", "ZH", 42, ["zh"]]) {
		assert.equal(parseUiLanguageSetting(bad), "zh");
	}
});

test("resolveSystemLanguage follows zh locales and falls back to en", () => {
	const restore = stubNavigatorLanguage("zh-CN");
	try {
		assert.equal(resolveSystemLanguage(), "zh");
	} finally {
		restore();
	}
	const restoreEn = stubNavigatorLanguage("en-US");
	try {
		assert.equal(resolveSystemLanguage(), "en");
	} finally {
		restoreEn();
	}
	const restoreDe = stubNavigatorLanguage("de-DE");
	try {
		assert.equal(resolveSystemLanguage(), "en");
	} finally {
		restoreDe();
	}
	const restoreNone = stubNavigatorLanguage(undefined);
	try {
		assert.equal(resolveSystemLanguage(), "en");
	} finally {
		restoreNone();
	}
});

test("setUiLanguageSetting applies system resolution and keeps the raw setting", () => {
	const restore = stubNavigatorLanguage("zh-CN");
	try {
		setUiLanguageSetting("system");
		assert.equal(getUiLanguageSetting(), "system");
		assert.equal(getUiLanguage(), "zh");

		setUiLanguageSetting("en");
		assert.equal(getUiLanguageSetting(), "en");
		assert.equal(getUiLanguage(), "en");
	} finally {
		restore();
		setUiLanguageSetting("zh");
	}
});

test("setUiLanguageSetting notifies on setting-only change and skips identical repeats", () => {
	const restore = stubNavigatorLanguage("zh-CN");
	let notifications = 0;
	const unsubscribe = subscribeUiLanguage(() => {
		notifications += 1;
	});
	try {
		setUiLanguageSetting("zh");
		assert.equal(notifications, 0, "重复设置同一值是空操作");

		// system 解析结果同为 zh：实际语言没变，但 ✓ 位置要从「系统默认」移走，必须通知
		setUiLanguageSetting("system");
		assert.equal(getUiLanguageSetting(), "system");
		assert.equal(getUiLanguage(), "zh");
		assert.equal(notifications, 1);

		setUiLanguageSetting("zh");
		assert.equal(getUiLanguageSetting(), "zh");
		assert.equal(getUiLanguage(), "zh");
		assert.equal(notifications, 2);

		setUiLanguageSetting("en");
		assert.equal(getUiLanguage(), "en");
		assert.equal(notifications, 3);
	} finally {
		unsubscribe();
		restore();
		setUiLanguageSetting("zh");
	}
});
