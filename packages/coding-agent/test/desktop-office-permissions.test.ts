import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";

test("Office plan mode permits inspection but rejects document and output mutations", () => {
	for (const name of ["univer_status", "univer_inspect", "univer_api", "univer_lint"]) {
		assert.equal(isReadOnlyDesktopTool(name, {}), true, name);
	}
	for (const name of [
		"univer_new",
		"univer_unit",
		"univer_import",
		"univer_execute",
		"univer_worktree",
		"univer_export",
		"univer_screenshot",
		"univer_print_pdf",
		"univer_compile_svg",
	]) {
		assert.equal(isReadOnlyDesktopTool(name, { action: "merge", readOnly: true }), false, name);
	}
});
