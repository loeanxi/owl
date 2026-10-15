import { describe, expect, it } from "vitest";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";

describe("desktop computer use permissions", () => {
	it("permits observation and release without permitting input or window mutations", () => {
		expect(isReadOnlyDesktopTool("computer_observe", {})).toBe(true);
		expect(isReadOnlyDesktopTool("computer_release", {})).toBe(true);
		expect(isReadOnlyDesktopTool("computer_screenshot", { target: "primary" })).toBe(true);
		expect(isReadOnlyDesktopTool("computer_windows", { action: "list" })).toBe(true);
		for (const action of ["focus", "restore", "invoke", "set_value", "click", "type", "key", "scroll"])
			expect(isReadOnlyDesktopTool("computer_act", { action })).toBe(false);
		for (const action of ["focus", "restore", undefined])
			expect(isReadOnlyDesktopTool("computer_windows", { action })).toBe(false);
		for (const tool of ["computer_click", "computer_type", "computer_key", "computer_scroll"])
			expect(isReadOnlyDesktopTool(tool, {})).toBe(false);
	});
});
