import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("mirror capture frame pool resizing", () => {
	it("captures every corner after growing and shrinking the same native capture session", () => {
		const output = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				fileURLToPath(new URL("./fixtures/mirror-capture-resize.ps1", import.meta.url)),
				"-WorkerPath",
				fileURLToPath(new URL("../src/modes/desktop/mirror/windows-capture.ps1", import.meta.url)),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 35_000 },
		);
		expect(output).toContain("capture-resize-ok");
	}, 40_000);
});
