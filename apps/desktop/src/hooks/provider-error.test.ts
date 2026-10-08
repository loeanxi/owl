import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEventMessage } from "../bridge/protocol.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { applyEvent, applyRetryEvent, formatProviderError, rebuild } from "./transcript.ts";

const balanceMessage = "网关内部错误：余额不足：预估 10 分，可用 4 分";

test("gateway balance rejection explains the request estimate instead of a temporary outage", () => {
	setUiLanguage("zh");
	for (const raw of [
		balanceMessage,
		`500 ${balanceMessage}`,
		`500: ${JSON.stringify({ error: { message: balanceMessage, code: "insufficient_balance" } })}`,
		JSON.stringify({ error: { message: balanceMessage, code: "insufficient_balance" } }),
	]) {
		const formatted = formatProviderError(raw);
		assert.match(formatted ?? "", /预估 10 分，可用 4 分/);
		assert.match(formatted ?? "", /单次请求|预留/);
		assert.doesNotMatch(formatted ?? "", /暂时不可用|稍后重试/);
	}
});

test("quota errors are distinct from short-lived rate limits, including code-only bodies", () => {
	setUiLanguage("zh");
	for (const raw of [
		'429: {"error":{"code":"insufficient_quota","message":"Quota exceeded"}}',
		'500: {"error":{"code":"insufficient_balance"}}',
	]) {
		assert.match(formatProviderError(raw) ?? "", /账户|计费/);
		assert.doesNotMatch(formatProviderError(raw) ?? "", /稍后|暂时不可用|限流/);
	}
	assert.match(formatProviderError('429: {"error":{"message":"Too many requests"}}') ?? "", /限流/);
	assert.match(formatProviderError('503: {"error":{"message":"Upstream overloaded"}}') ?? "", /暂时不可用/);
	assert.match(formatProviderError('401: {"error":{"message":"Invalid key"}}') ?? "", /密钥/);
	assert.equal(formatProviderError("Unrecognized provider error"), "Unrecognized provider error");
	assert.equal(formatProviderError(undefined), undefined);
});

test("balance guidance survives message events, history replay and retry banners", () => {
	setUiLanguage("zh");
	const message = { role: "assistant", content: [], stopReason: "error", errorMessage: balanceMessage };
	const wire = (event: Record<string, unknown>) =>
		({ type: "event", sessionId: "fixture", event }) as unknown as ServerEventMessage;
	let entries = applyEvent([], wire({ type: "message_start", message }));
	entries = applyEvent(entries, wire({ type: "message_end", message }));
	const live = entries[0];
	const replay = rebuild([message])[0];
	assert.ok(live?.kind === "assistant" && replay?.kind === "assistant");
	assert.match(live.error ?? "", /单次请求|预留/);
	assert.equal(replay.error, live.error);
	assert.equal(
		applyRetryEvent(null, wire({ type: "auto_retry_end", success: false, attempt: 1, finalError: balanceMessage }))
			?.reason,
		live.error,
	);
});

test("account guidance uses the selected interface language", () => {
	try {
		setUiLanguage("en");
		const formatted = formatProviderError(
			'500: {"error":{"message":"insufficient balance","code":"insufficient_balance"}}',
		);
		assert.match(formatted ?? "", /account|billing/i);
		assert.match(formatted ?? "", /request|reserve/i);
		assert.doesNotMatch(formatted ?? "", /temporarily unavailable|try again later/i);
	} finally {
		setUiLanguage("zh");
	}
});
