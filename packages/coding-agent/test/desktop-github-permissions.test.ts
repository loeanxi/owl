import assert from "node:assert/strict";
import { test } from "vitest";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";

test("GitHub plan mode permits reads but rejects repository mutations", () => {
	for (const name of [
		"github_repo_info",
		"github_pr_view",
		"github_pr_diff",
		"github_run_logs",
		"github_issue_list",
	]) {
		assert.equal(isReadOnlyDesktopTool(name, {}), true, name);
	}
	for (const name of [
		"github_pr_create",
		"github_pr_merge",
		"github_pr_comment",
		"github_issue_close",
		"github_workflow_dispatch",
		"github_run_rerun",
		"github_release_create",
	]) {
		assert.equal(isReadOnlyDesktopTool(name, { confirm: false }), false, name);
	}
});
