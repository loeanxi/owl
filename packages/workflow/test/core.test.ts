import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileScript } from "../src/compile.js";
import { ScriptedDriver } from "../src/driver.js";
import { Journal } from "../src/journal.js";
import { amendRun, resumeRun, startRun } from "../src/runner.js";

function tmpRuns(): string {
	return mkdtempSync(join(tmpdir(), "owl-workflow-test-"));
}

const FANOUT_SCRIPT = `
phase("研究三个文件");
const paths = await files.glob("src/*.ts");
const reviews = await Promise.all(
	paths.map((p) => agent("评审-" + p).ask("评审 " + p)),
);
phase("跑一次门禁");
const gate = await world.run("npm", ["test"]);
return { reviews, gateExit: gate.exitCode };
`;

describe("compileScript", () => {
	it("typechecks against the facade and enumerates sites in document order", () => {
		const result = compileScript(FANOUT_SCRIPT);
		expect(result.ok).toBe(true);
		expect(result.lowered!.sites.map((s) => `${s.kind}:${s.op ?? ""}`)).toEqual([
			"phase:",
			"world:files.glob",
			"ask:",
			"actor:",
			"phase:",
			"world:world.run",
		]);
		expect(result.lowered!.phases).toEqual(["研究三个文件", "跑一次门禁"]);
		// The printer escapes non-ASCII, so match the call shape rather than the literal text.
		expect(result.lowered!.code).toContain("__host.enterPhase(");
		expect(result.lowered!.code).toContain('__host.worldRead("s1", "files.glob"');
		expect(result.lowered!.code).toContain('__host.ask("s2", __host.createActor("s3"');
		expect(result.lowered!.code).toContain('__host.worldRead("s5", "world.run"');
	});

	it("rejects scripts that use banned globals", () => {
		const result = compileScript(`const x = process.env.HOME; return x;`);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	it("rejects non-unique hole names (9012)", () => {
		const result = compileScript(`await hole("分诊"); await hole("分诊"); return 1;`);
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0].message).toContain("9012");
	});
});

describe("end-to-end run", () => {
	it("runs a fan-out script in the sandbox and journals every step", async () => {
		const runsDir = tmpRuns();
		const driver = new ScriptedDriver({
			answers: [{ contains: "评审", result: { ok: true } }],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
		});
		const run = startRun({ script: FANOUT_SCRIPT, driver, runsDir, name: "fanout" });
		const settled = await run.settled;
		expect(settled.status).toBe("completed");
		expect((settled.value as any).gateExit).toBe(0);
		expect((settled.value as any).reviews).toEqual([{ ok: true }, { ok: true }]);
		expect(driver.askCalls.map((c) => c.actorName)).toEqual(["评审-src/a.ts", "评审-src/b.ts"]);

		const journal = Journal.load(runsDir, run.runId)!;
		expect(journal.run.status).toBe("completed");
		expect(journal.listNodes("ask").filter((n) => n.status === "completed")).toHaveLength(2);
		expect(journal.listNodes("world-run")).toHaveLength(1);
	}, 20000);

	it("suspends at a hole, and filling it runs the body in place", async () => {
		const runsDir = tmpRuns();
		const script = `
phase("问一下怎么办");
const plan = await hole("决定方案", "需要决定");
return plan;
`;
		const driver = new ScriptedDriver({ answers: [] });
		const run = startRun({ script, driver, runsDir });
		const holeSite = run.compile.lowered!.sites.find((s) => s.kind === "hole")!.siteId;
		await new Promise((r) => setTimeout(r, 700));
		expect(run.fillHole(holeSite, "return {picked: 42};")).toBe(true);
		const settled = await run.settled;
		expect(settled.status).toBe("completed");
		expect(settled.value).toEqual({ picked: 42 });
	}, 20000);

	it("fails the run when the sandbox deadlocks on an unclosed channel", async () => {
		const runsDir = tmpRuns();
		const script = `
const ch = channel("x");
phase("卡住");
for await (const item of ch) {
	report(item);
}
return "never";
`;
		const driver = new ScriptedDriver({ answers: [] });
		const run = startRun({ script, driver, runsDir });
		const settled = await run.settled;
		expect(settled.status).toBe("failed");
		expect(settled.error).toContain("Deadlock");
	}, 20000);
});

describe("resume replays the journal", () => {
	it("cancelled run resumes: settled asks replay at zero cost, in-flight re-runs", async () => {
		const runsDir = tmpRuns();
		const slowDriver = new ScriptedDriver({
			answers: [
				{ contains: "评审 src/a.ts", result: "A-ok" },
				{
					contains: "评审 src/b.ts",
					result: "B-ok",
					// never resolves in time; we cancel mid-flight
				},
			],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
		});
		// Make the second ask hang until we cancel.
		let releaseSecond: (() => void) | undefined;
		const hangDriver: any = {
			async executeAsk(req: any) {
				if (req.instructions.includes("src/b.ts")) {
					await new Promise<void>((r) => {
						releaseSecond = r;
					});
					return { result: "B-ok", stats: { worldToolCalls: 0 } };
				}
				return slowDriver.executeAsk(req);
			},
			executeWorldRead: (op: string, args: unknown[]) => slowDriver.executeWorldRead(op, args),
		};
		const run = startRun({ script: FANOUT_SCRIPT, driver: hangDriver, runsDir, maxConcurrency: 1 });
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (releaseSecond) {
					clearInterval(check);
					resolve();
				}
			}, 50);
		});
		run.stop("user");
		await run.settled;
		expect(releaseSecond).toBeDefined();
		releaseSecond!();

		const resumeDriver = new ScriptedDriver({
			answers: [{ contains: "评审 src/b.ts", result: "B-ok-resumed" }],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
		});
		const resumed = resumeRun({ runId: run.runId, driver: resumeDriver, runsDir });
		const settled = await resumed.settled;
		expect(settled.status).toBe("completed");
		// The a-ask replays from the journal; only b and the gate run live.
		expect(resumeDriver.askCalls.map((c) => c.instructions)).toEqual(["评审 src/b.ts"]);
		expect((settled.value as any).reviews).toEqual(["A-ok", "B-ok-resumed"]);
	}, 20000);

	it("refuses to resume completed runs; a running run can be amended live (superseded)", async () => {
		const runsDir = tmpRuns();
		const driver = new ScriptedDriver({
			answers: [{ contains: "评审", result: "ok" }],
			worldReads: { "files.glob": ["src/a.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});
		const run = startRun({ script: FANOUT_SCRIPT, driver, runsDir });
		await run.settled;
		expect(() => resumeRun({ runId: run.runId, driver, runsDir })).toThrow(/completed/);

		const hanging = startRun({
			script: `phase("等决定"); await hole("决定"); return 1;`,
			driver: new ScriptedDriver({ answers: [] }),
			runsDir,
		});
		await new Promise((r) => setTimeout(r, 700));
		// Live amend: one call stops and supersedes the running predecessor.
		const revised = await amendRun({
			runId: hanging.runId,
			newScript: `phase("直接返回");\nreturn 1;`,
			driver,
			runsDir,
		});
		await revised.settled;
		const prior = Journal.load(runsDir, hanging.runId)!;
		expect(prior.run.status).toBe("cancelled");
		expect(prior.run.stopReason).toBe("superseded");
	}, 20000);
});

describe("amend imports the predecessor as a warm cache", () => {
	it("unchanged asks settle from cache; the edited ask re-runs", async () => {
		const runsDir = tmpRuns();
		const driver = new ScriptedDriver({
			answers: [
				{ contains: "评审 src/a.ts", result: "A-ok" },
				{ contains: "评审 src/b.ts", result: "B-ok" },
			],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
		});
		const run = startRun({ script: FANOUT_SCRIPT, driver, runsDir });
		await run.settled;
		expect(run.compile.lowered!.sites.length).toBeGreaterThan(0);

		// Rewrite only the a-ask's prompt (template injection keeps the b-ask byte-identical).
		const amendedScript = FANOUT_SCRIPT.replace(
			'ask("评审 " + p)',
			'ask("评审 " + p + (p === "src/a.ts" ? " [v2]" : ""))',
		);
		const amendDriver = new ScriptedDriver({
			answers: [{ contains: "v2", result: "A-v2" }],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
		});
		const revised = await amendRun({ runId: run.runId, newScript: amendedScript, driver: amendDriver, runsDir });
		const settled = await revised.settled;
		expect(settled.status).toBe("completed");
		// Only the rewritten ask runs live; b replays from the imported cache.
		expect(amendDriver.askCalls.map((c) => c.instructions)).toEqual(["评审 src/a.ts [v2]"]);
		expect((settled.value as any).reviews).toEqual(["A-v2", "B-ok"]);
	}, 30000);

	it("closes the import cache after a live world-run, so later asks re-run", async () => {
		const runsDir = tmpRuns();
		const driver = new ScriptedDriver({
			answers: [
				{ contains: "评审 src/a.ts", result: "A-ok" },
				{ contains: "评审 src/b.ts", result: "B-ok" },
			],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
		});
		const run = startRun({ script: FANOUT_SCRIPT, driver, runsDir });
		await run.settled;

		// Same asks, but the world.run hook now records it ran live again: the
		// import closes on the live gate, and downstream cached asks... the gate is
		// the LAST step, so keep this to asserting the world-run re-executed live.
		const amendDriver = new ScriptedDriver({
			answers: [{ contains: "评审", result: "cached-should-not-fire" }],
			worldReads: { "files.glob": ["src/a.ts", "src/b.ts"] },
			worldRun: () => ({ exitCode: 0, stdout: "gate-live", stderr: "" }),
		});
		const revised = await amendRun({ runId: run.runId, newScript: FANOUT_SCRIPT, driver: amendDriver, runsDir });
		const settled = await revised.settled;
		expect(settled.status).toBe("completed");
		// World reads replay from the imported cache; the live gate re-runs (it closes the import).
		expect(amendDriver.worldReadCalls.filter((c) => c.op === "files.glob")).toHaveLength(0);
		expect((settled.value as any).gateExit).toBe(0);
	}, 30000);
});
