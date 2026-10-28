import assert from "node:assert/strict";
import { test } from "node:test";
import {
	feedbackStoreKey,
	formatAnswerFeedback,
	loadFeedback,
	saveFeedback,
	toggleRating,
} from "./claude-answer-feedback.ts";

/** localStorage 的最小替身：够 load/save 用。 */
function stubStorage(): Map<string, string> {
	const store = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};
	return store;
}

test("ratings are stored per session", () => {
	stubStorage();
	saveFeedback("s1", { e1: { rating: "up" }, e2: { rating: "down", reason: "太笼统" } });
	assert.equal(feedbackStoreKey("s1"), "owl.feedback.s1");
	assert.deepEqual(loadFeedback("s1"), { e1: { rating: "up" }, e2: { rating: "down", reason: "太笼统" } });
	// 另一个会话是另一份，互不串。
	assert.deepEqual(loadFeedback("s2"), {});
});

test("a corrupt store reads as no ratings instead of throwing", () => {
	stubStorage();
	(globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem(
		"owl.feedback.s1",
		"{not json",
	);
	assert.deepEqual(loadFeedback("s1"), {});
	(globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem(
		"owl.feedback.s1",
		'[{"rating":"up"}]',
	);
	assert.deepEqual(loadFeedback("s1"), {});
});

test("ratings are exclusive and toggling the same one clears it", () => {
	assert.equal(toggleRating(undefined, "up"), "up");
	assert.equal(toggleRating("up", "down"), "down");
	assert.equal(toggleRating("up", "up"), undefined);
	assert.equal(toggleRating("down", "down"), undefined);
});

test("the feedback text names the verdict and keeps the user's words", () => {
	assert.equal(formatAnswerFeedback("down", "  方向不对  ", false), "上一条回答没帮上忙，原因是：\n方向不对");
	assert.equal(
		formatAnswerFeedback("up", "  正是我要的  ", true),
		"The previous answer helped. Here is what worked:\n正是我要的",
	);
	// 没写理由就没有要交给模型的话。
	assert.equal(formatAnswerFeedback("down", "   ", false), "");
});
