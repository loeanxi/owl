import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("mirror DWM capture coordinates", () => {
	it("matches capture dimensions and preserves input positions at 100%, 150%, and 200% scaling", () => {
		const output = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				fileURLToPath(new URL("./fixtures/mirror-capture-geometry.ps1", import.meta.url)),
				"-WorkerPath",
				fileURLToPath(new URL("../src/modes/desktop/mirror/windows-capture.ps1", import.meta.url)),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 10_000 },
		);
		expect(output).toContain("capture-geometry-ok");
	}, 15_000);
});
