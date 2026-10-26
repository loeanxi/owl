import assert from "node:assert/strict";
import test from "node:test";
import type { DiffApprovalFileSummary } from "../bridge/protocol.ts";
import { summarizeReviewState } from "./review-state.ts";

function entry(path: string, status: DiffApprovalFileSummary["status"]): DiffApprovalFileSummary {
	return {
		id: `${path}-${status}`,
		path: `D:/owl/${path}`,
		displayPath: path,
		status,
		originalExisted: true,
		currentExists: true,
		added: 2,
		removed: 1,
		size: 10,
		baselineAt: "2026-10-26T00:00:00.000Z",
		resolvedAt: null,
	};
}

test("review state splits pending from decided changes", () => {
	const summary = summarizeReviewState([
		entry("src/a.ts", "pending"),
		entry("src/b.ts", "pending"),
		entry("src/c.ts", "reverted"),
		entry("src/d.ts", "kept"),
	]);
	assert.deepEqual(summary.pending, ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(summary.decided, ["src/c.ts（已撤销）", "src/d.ts（已保留）"]);
});

test("empty review list yields empty groups", () => {
	assert.deepEqual(summarizeReviewState([]), { pending: [], decided: [] });
});
