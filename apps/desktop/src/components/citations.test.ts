import assert from "node:assert/strict";
import { test } from "node:test";
import type { Citation } from "../hooks/transcript.ts";
import {
	buildCitationSources,
	insertCitationMarkers,
	renderSourcesPanel,
	replaceCitationMarkers,
} from "./citations.ts";

const webCitation: Citation = {
	title: "Example Domain",
	url: "https://example.com/page",
	source: "url_citation",
	startIndex: 5,
	endIndex: 12,
};

const docCitation: Citation = {
	title: "handbook.md",
	snippet: "quoted passage",
	startIndex: 40,
	endIndex: 54,
	source: "char_location",
};

test("the same source is listed once and shares one number", () => {
	const sources = buildCitationSources([webCitation, { ...webCitation }]);
	assert.equal(sources.length, 1);
	assert.equal(sources[0]!.index, 1);
});

test("different sources get their own numbers", () => {
	const sources = buildCitationSources([webCitation, docCitation]);
	assert.deepEqual(
		sources.map((source) => source.index),
		[1, 2],
	);
	assert.equal(sources[1]!.citation.title, "handbook.md");
});

test("no citations means no sources", () => {
	assert.deepEqual(buildCitationSources(undefined), []);
	assert.deepEqual(buildCitationSources([]), []);
});

test("a url citation anchors its marker right after the cited span", () => {
	const sources = buildCitationSources([webCitation]);
	const marked = insertCitationMarkers("Hello world, cited here.", sources);
	// 角标落在被引片段之后（endIndex = 12，即逗号之后）。
	assert.ok(marked.startsWith("Hello world,"));
	assert.ok(marked.includes("\uE000cite1\uE001"));
	assert.ok(marked.indexOf("\uE000cite1\uE001") > 10);
});

test("a document citation has no text anchor, so its marker lands at the end", () => {
	const sources = buildCitationSources([docCitation]);
	const marked = insertCitationMarkers("A paragraph without a text anchor.", sources);
	// Anthropic 的 char_location 偏移是源文档里的位置，不能当正文偏移用。
	assert.ok(marked.endsWith("\uE000cite1\uE001"));
});

test("the marker becomes a superscript that links to the source", () => {
	const sources = buildCitationSources([webCitation]);
	const html = replaceCitationMarkers(insertCitationMarkers("Hello world.", sources), sources);
	assert.ok(html.includes('<sup class="owl-answer-cite"'));
	assert.ok(html.includes('href="https://example.com/page"'));
	assert.ok(html.includes(">1</a>"));
});

test("a source without a url renders as a plain number", () => {
	const sources = buildCitationSources([docCitation]);
	const html = replaceCitationMarkers(insertCitationMarkers("text", sources), sources);
	assert.ok(html.includes('<sup class="owl-answer-cite"'));
	assert.ok(!html.includes("<a href"));
});

test("the sources panel lists every source once", () => {
	const sources = buildCitationSources([webCitation, docCitation]);
	const html = renderSourcesPanel(sources);
	assert.ok(html.includes('data-answer-sources=""'));
	assert.ok(html.includes("Example Domain"));
	assert.ok(html.includes("handbook.md"));
	assert.ok(html.includes("https://example.com/page"));
	assert.equal((html.match(/class="owl-answer-source"/g) ?? []).length, 2);
});

test("no sources means no panel", () => {
	assert.equal(renderSourcesPanel([]), "");
});
