import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("complete Android VM surface", () => {
	it("uses the foreign VM child and expands its host without cropping its footer or right edge", () => {
		const output = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				fileURLToPath(new URL("./fixtures/mirror-vm-surface.ps1", import.meta.url)),
				"-WorkerPath",
				fileURLToPath(new URL("../src/modes/desktop/mirror/windows-capture.ps1", import.meta.url)),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 15_000 },
		);
		expect(output).toContain("vm-surface-ok");
	}, 20_000);
});
