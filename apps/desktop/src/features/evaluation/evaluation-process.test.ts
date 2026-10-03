import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationProcessStage } from "./evaluation-process.ts";

test("thinking-only responses show a thinking stage before answer text arrives", () => {
	assert.equal(evaluationProcessStage({ status: "running", output: "", thinking: "正在分析图形结构" }), "thinking");
	assert.equal(evaluationProcessStage({ status: "running", output: "<svg", thinking: "正在分析图形结构" }), "answering");
	assert.equal(evaluationProcessStage({ status: "running", output: " \n", thinking: " \n" }), "waiting");
});

test("the server checking phase is authoritative even while answer and thinking remain available", () => {
	assert.equal(evaluationProcessStage({ status: "running", generationPhase: "checking", output: "完整正文", thinking: "完整思考" }), "checking");
	assert.equal(evaluationProcessStage({ status: "running", generationPhase: "thinking", output: "", thinking: "" }), "thinking");
});

test("queued and terminal statuses do not become inferred generation phases", () => {
	assert.equal(evaluationProcessStage({ status: "queued", generationPhase: "waiting", output: "", thinking: "" }), "queued");
	assert.equal(evaluationProcessStage({ status: "completed", generationPhase: "checking", output: "正文", thinking: "思考" }), "completed");
	assert.equal(evaluationProcessStage({ status: "cancelled", output: "部分正文", thinking: "部分思考" }), "cancelled");
	assert.equal(evaluationProcessStage({ status: "failed", output: "", thinking: "已返回思考" }), "failed");
});
