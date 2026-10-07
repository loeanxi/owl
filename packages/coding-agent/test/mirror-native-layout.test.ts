import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("native mirror stage layout", () => {
	it("resizes the app content to each stage without clipping or following a stale origin", () => {
		const output = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				fileURLToPath(new URL("./fixtures/mirror-native-layout.ps1", import.meta.url)),
				"-WorkerPath",
				fileURLToPath(new URL("../src/modes/desktop/mirror/windows-capture.ps1", import.meta.url)),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 15_000 },
		);
		expect(output).toContain("native-layout-ok");
	}, 20_000);
});
