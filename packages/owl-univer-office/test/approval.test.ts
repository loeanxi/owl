import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveQuestion, setQuestionChannel } from "@owl/owl-coding-agent";
import { confirmOfficeAction } from "../src/approval.ts";

test("desktop confirmation uses the connected question channel without extension UI", async () => {
	let requestId = "";
	setQuestionChannel({
		hasConnectedClients: () => true,
		broadcast: (request) => {
			if (request.type !== "question_request") return;
			requestId = request.requestId;
			resolveQuestion(requestId, { cancelled: false, answers: [{ index: 0, selectedLabels: ["确认合入"] }] });
		},
	});
	try {
		assert.equal(await confirmOfficeAction("session", "tool", "确认 Office 修改", "draft"), true);
		assert.equal(requestId, "session:office:tool");
		assert.equal(resolveQuestion(requestId, { cancelled: false, answers: [] }), false);
	} finally {
		setQuestionChannel(undefined);
	}
});

test("no UI, cancellation, free text and refusal cannot authorize an Office merge", async () => {
	setQuestionChannel(undefined);
	await assert.rejects(confirmOfficeAction("session", "tool", "确认 Office 修改", "draft"), /已连接的 Owl 界面/);
	assert.equal(
		await confirmOfficeAction("session", "tool", "确认 Office 修改", "draft", undefined, async () => false),
		false,
	);
	setQuestionChannel({
		hasConnectedClients: () => true,
		broadcast: (request) => {
			if (request.type !== "question_request") return;
			resolveQuestion(request.requestId, { cancelled: false, answers: [{ index: 0, customText: "yes" }] });
		},
	});
	try {
		assert.equal(await confirmOfficeAction("session", "text", "确认 Office 修改", "draft"), false);
	} finally {
		setQuestionChannel(undefined);
	}
	const controller = new AbortController();
	setQuestionChannel({ hasConnectedClients: () => true, broadcast: () => controller.abort() });
	try {
		assert.equal(
			await confirmOfficeAction("session", "abort", "确认 Office 修改", "draft", controller.signal),
			false,
		);
	} finally {
		setQuestionChannel(undefined);
	}
});
