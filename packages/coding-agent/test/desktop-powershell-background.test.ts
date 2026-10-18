import { afterEach, describe, expect, it } from "vitest";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { terminateSessionProcesses } from "../src/core/tools/process-store.ts";
import { getDesktopProcess, killDesktopProcess, listDesktopProcesses } from "../src/modes/desktop/processes.ts";

const owner = "desktop-powershell-background";
afterEach(() => terminateSessionProcesses(owner));

describe("PowerShell background execution", () => {
	it.skipIf(process.platform !== "win32")(
		"yields a real owned process and allows independent output inspection and stop",
		async () => {
			const tool = createPowerShellToolDefinition(process.cwd());
			const result = await tool.execute(
				"background-command",
				{
					command: "Write-Output '后台 ready'; Start-Sleep -Seconds 30",
					yield_time_ms: 1000,
				},
				undefined,
				undefined,
				{
					cwd: process.cwd(),
					sessionManager: { getSessionId: () => owner, getSessionFile: () => undefined },
				} as never,
			);
			const tasks = listDesktopProcesses(owner);
			expect(tasks).toHaveLength(1);
			expect(result.structuredContent).toMatchObject({ session_id: tasks[0].id, status: "running" });
			expect(getDesktopProcess(owner, tasks[0].id).output).toContain("后台 ready");
			expect(await killDesktopProcess(owner, tasks[0].id)).toMatchObject({ status: "stopped" });
		},
	);
});
