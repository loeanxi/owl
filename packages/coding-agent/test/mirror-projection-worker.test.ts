import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("projection worker lifecycle", () => {
	it("delivers queued gestures, releases on stop, and restores after losing its owner", () => {
		const output = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				fileURLToPath(new URL("./fixtures/mirror-projection-worker.ps1", import.meta.url)),
				"-WorkerPath",
				fileURLToPath(new URL("../src/modes/desktop/mirror/windows-capture.ps1", import.meta.url)),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 25_000 },
		);
		expect(output).toContain("projection-worker-ok");
	}, 30_000);
});
