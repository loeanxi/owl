import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filterChangelog, parseChangelog } from "./changelog.ts";

const SAMPLE = `# Owl 更新日志

<!--
## 2099-01-01
### 新增
- 注释里的示例不算
-->

## 2026-10-11

### 修复

- \`desktop\` 修好按钮

## 2026-10-12

### 新增

- \`desktop\` 新增分区
- 跨包改动

### 未知类别

- 被丢弃

### 维护

- \`repo\` 加钩子
`;

test("parses days, kinds and optional scopes, newest day first", () => {
	assert.deepEqual(parseChangelog(SAMPLE), [
		{
			date: "2026-10-12",
			entries: [
				{ kind: "新增", scope: "desktop", text: "新增分区" },
				{ kind: "新增", text: "跨包改动" },
				{ kind: "维护", scope: "repo", text: "加钩子" },
			],
		},
		{ date: "2026-10-11", entries: [{ kind: "修复", scope: "desktop", text: "修好按钮" }] },
	]);
});

test("filters by kind and by query across text and scope, dropping empty days", () => {
	const days = parseChangelog(SAMPLE);
	assert.deepEqual(
		filterChangelog(days, { kind: "修复" }).map((day) => day.date),
		["2026-10-11"],
	);
	assert.deepEqual(
		filterChangelog(days, { query: "REPO" }).flatMap((day) => day.entries.map((entry) => entry.text)),
		["加钩子"],
	);
	assert.equal(filterChangelog(days, { kind: "移除" }).length, 0);
});

test("repository CHANGELOG.md parses into dated entries", () => {
	const markdown = readFileSync(new URL("../../../../../CHANGELOG.md", import.meta.url), "utf8");
	const days = parseChangelog(markdown);
	assert.ok(days.length > 0);
	for (const day of days) assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
});
