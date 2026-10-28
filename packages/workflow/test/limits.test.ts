import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ScriptedDriver } from "../src/driver.js";
import { Journal } from "../src/journal.js";
import { startRun } from "../src/runner.js";

describe("agent call limit (ZCode Yii=1000 guard)", () => {
	it("fails the run when live dispatches exceed max_ask_calls", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "owl-wf-cap-"));
		const driver = new ScriptedDriver({ answers: [{ contains: "任务", result: "ok" }] });
		const script = `
phase("循环派活");
let last = "";
for (let i = 0; i < 10; i += 1) {
	last = String(await agent("工人-" + i).ask("任务 " + i + ", 上一轮: " + last));
}
return last;
`;
		const run = startRun({ script, driver, runsDir, maxAskCalls: 3, maxConcurrency: 1 });
		const settled = await run.settled;
		expect(settled.status).toBe("failed");
		const journal = Journal.load(runsDir, run.runId)!;
		expect(journal.run.failure?.message).toContain("agent call limit exceeded");
		expect(journal.run.failure?.code).toBe("AskCallLimitExceeded");
		// The replayed-forever cap: only 3 live dispatches happened.
		expect(driver.askCalls.length).toBe(3);
	}, 30000);
});
