import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCard } from "../hooks/transcript.ts";
import { claudeLinkPreviews } from "./claude-link-previews.ts";

function card(name: string, outputText: string): ToolCard {
	return { id: "c1", name, args: "{}", summary: "", status: "ok", output: { text: outputText, totalLines: 1 } };
}

// 夹具取自真实会话的 web_search 输出（Owl-history 2026-10-07，格式原样）。
const REAL_OUTPUT = `Vite 7 的要点如下。

**Sources:**
1. Latest AI Model Releases — October 2026
   https://aireleasetracker.com/latest

2. Introducing Mistral Large 4 | Mistral
   https://mistral.ai/news/mistral-large-4/`;

test("parses the real Sources section into previews", () => {
	const previews = claudeLinkPreviews(card("web_search", REAL_OUTPUT));
	assert.equal(previews.length, 2);
	assert.equal(previews[0]!.title, "Latest AI Model Releases — October 2026");
	assert.equal(previews[0]!.url, "https://aireleasetracker.com/latest");
	assert.equal(previews[0]!.domain, "aireleasetracker.com");
	assert.equal(previews[1]!.domain, "mistral.ai");
});

test("non-web-search tools and sourceless text stay raw", () => {
	assert.deepEqual(claudeLinkPreviews(card("read", REAL_OUTPUT)), []);
	assert.deepEqual(claudeLinkPreviews(card("web_search", "没有来源的一段话。")), []);
	assert.deepEqual(claudeLinkPreviews(card("web_search", "")), []);
});
