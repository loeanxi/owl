import assert from "node:assert/strict";
import test from "node:test";
import { en } from "./en.ts";
import { zh } from "./zh.ts";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("zh/en dictionaries have identical key sets", () => {
	assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test("zh/en values use the same {placeholders}", () => {
	const mismatched: string[] = [];
	for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
		if (placeholders(zh[key]).join() !== placeholders(en[key]).join()) mismatched.push(key);
	}
	assert.deepEqual(mismatched, []);
});

test("no dictionary value is empty", () => {
	const empty = [...Object.entries(zh), ...Object.entries(en)].filter(([, v]) => !v.trim()).map(([k]) => k);
	assert.deepEqual(empty, []);
});
