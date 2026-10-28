import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileScript } from "../src/compile.js";
import { ScriptedDriver } from "../src/driver.js";
import { PiAgentDriver } from "../src/driver-node.js";
import { Journal } from "../src/journal.js";
import { amendRun, startRun } from "../src/runner.js";
import { extractJson, validateAgainstSchema } from "../src/validate.js";

function tmpRuns(): string {
	return mkdtempSync(join(tmpdir(), "owl-wf-prod-"));
}

const TYPED_SCRIPT = `
interface Verdict {
	/** Workspace-relative path the problem is in. */
	path: string;
	/** One sentence: what is wrong. */
	problem: string;
	/** How much it matters. */
	severity: "low" | "medium" | "high";
}
phase("评审");
const v = await agent("评审员").ask<Verdict>("评审 src/a.ts");
return v;
`;

describe("typed asks (ZCode wAn + submit seam)", () => {
	it("extracts the ask<T> contract: object schema with JSDoc descriptions and enum", () => {
		const result = compileScript(TYPED_SCRIPT);
		expect(result.ok).toBe(true);
		const askSite = result.lowered!.sites.find((s) => s.kind === "ask")!;
		const spec = result.lowered!.askSpecs[askSite.siteId];
		expect(spec.typed).toBe(true);
		const schema = spec.schema as any;
		expect(schema.type).toBe("object");
		expect(schema.properties.path.type).toBe("string");
		expect(schema.properties.path.description).toContain("Workspace-relative path");
		expect(schema.properties.severity.enum).toEqual(["low", "medium", "high"]);
		expect(spec.contract).toContain("OUTPUT CONTRACT");
		// The contract is compile-time only: the input hash stays over the author's ask text.
		expect(result.lowered!.code).not.toContain("OUTPUT CONTRACT");
	});

	it("rejects an unsupported ask<T> type with a 9012 diagnostic", () => {
		const result = compileScript(`
phase("问");
const x = await agent("a").ask<Map<string, number>>("hi");
return 1;
`);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.some((d) => d.message.includes("unsupported ask<T>"))).toBe(true);
	});

	it("repairs an invalid reply against the same session, then settles with the parsed object", async () => {
		const runsDir = tmpRuns();
		const driver = new ScriptedDriver({
			answers: [
				{ contains: "评审 src/a.ts", result: "我觉得有问题的样子但不是 JSON" },
				{
					contains: "failed schema validation",
					result: '{"path":"src/a.ts","problem":"off-by-one","severity":"high"}',
					sessionId: "sess-1",
				},
			],
		});
		const events: any[] = [];
		const run = startRun({ script: TYPED_SCRIPT, driver, runsDir, onEvent: (e) => events.push(e) });
		const settled = await run.settled;
		expect(settled.status).toBe("completed");
		expect(settled.value).toEqual({ path: "src/a.ts", problem: "off-by-one", severity: "high" });
		expect(events.filter((e) => e.type === "node-repairing").length).toBe(1);
		// Both rounds hit the same actor session (repair continues the conversation).
		expect(driver.askCalls[0].actorKey).toBe(driver.askCalls[1].actorKey);
		const journal = Journal.load(runsDir, run.runId)!;
		expect(journal.listNodes("ask")[0].result).toEqual({ path: "src/a.ts", problem: "off-by-one", severity: "high" });
	}, 20000);

	it("fails the node as ValidationFailed when the repair budget is exhausted", async () => {
		const runsDir = tmpRuns();
		const driver = new ScriptedDriver({
			answers: [
				{ contains: "评审", result: "仍然不是 JSON" },
				{ contains: "failed schema validation", result: "还是不是 JSON" },
			],
		});
		const events: any[] = [];
		const run = startRun({ script: TYPED_SCRIPT, driver, runsDir, onEvent: (e) => events.push(e) });
		const settled = await run.settled;
		expect(settled.status).toBe("failed");
		const journal = Journal.load(runsDir, run.runId)!;
		expect(journal.run.failure?.message).toContain("repair budget");
		expect(events.filter((e) => e.type === "node-repairing").length).toBe(3);
	}, 20000);
});

describe("actor session continuity", () => {
	it("resumes the same --session-id across asks of one actor; persona only at creation", async () => {
		const cwd = tmpRuns();
		const fake = join(cwd, "fake-owl.mjs");
		writeFileSync(
			fake,
			[
				`const id = process.argv[process.argv.indexOf("--session-id") + 1];`,
				`console.log(JSON.stringify({ type: "session", id }));`,
				`const persona = process.argv.includes("--append-system-prompt");`,
				`console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: persona ? "created" : "resumed" }] }] }));`,
			].join("\n"),
			"utf8",
		);
		const spawns: string[][] = [];
		const driver = new PiAgentDriver({
			cwd,
			owlCommand: process.execPath,
			owlArgsPrefix: [fake],
			onSpawn: (a) => spawns.push(a),
		});
		await driver.executeAsk({ actorKey: "s0#1", actorName: "评审员", persona: "你是评审员", instructions: "第一问" });
		await driver.executeAsk({ actorKey: "s0#1", instructions: "第二问" });
		await driver.executeAsk({ actorKey: "s1#1", actorName: "写手", instructions: "另一 actor" });
		const ids = spawns.map((a) => a[a.indexOf("--session-id") + 1]);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[2]).not.toBe(ids[0]);
		expect(spawns[0].join(" ")).toContain("--append-system-prompt");
		expect(spawns[1].join(" ")).not.toContain("--append-system-prompt");
	}, 20000);
});

describe("live amend (ZCode: stop + supersede in one call)", () => {
	it("amends a still-running run: predecessor superseded, revision completes", async () => {
		const runsDir = tmpRuns();
		const hanging = startRun({
			script: `phase("等决定"); await hole("决定"); return 1;`,
			driver: new ScriptedDriver({ answers: [] }),
			runsDir,
		});
		await new Promise((r) => setTimeout(r, 700));
		const revised = await amendRun({
			runId: hanging.runId,
			newScript: `phase("直接返回");\nreturn { ok: true };`,
			driver: new ScriptedDriver({ answers: [] }),
			runsDir,
		});
		const settled = await revised.settled;
		expect(settled.status).toBe("completed");
		const prior = Journal.load(runsDir, hanging.runId)!;
		expect(prior.run.status).toBe("cancelled");
		expect(prior.run.stopReason).toBe("superseded");
		expect(prior.run.supersededBy).toBe(revised.runId);
	}, 20000);

	it("carries the predecessor's agent session into the revision's live asks", async () => {
		const runsDir = tmpRuns();
		const script = `
phase("评审");
const v = await agent("评审员").ask("评审 src/a.ts");
return v;
`;
		const driver = new ScriptedDriver({
			answers: [{ contains: "评审 src/a.ts", result: "ok", sessionId: "sess-abc" }],
		});
		const run = startRun({ script, driver, runsDir });
		await run.settled;

		const amendedDriver = new ScriptedDriver({ answers: [{ contains: "v2", result: "ok2" }] });
		const amendedScript = script.replace('ask("评审 src/a.ts")', 'ask("评审 src/a.ts v2")');
		const revised = await amendRun({ runId: run.runId, newScript: amendedScript, driver: amendedDriver, runsDir });
		const settled = await revised.settled;
		expect(settled.status).toBe("completed");
		expect(amendedDriver.askCalls[0].resumeSessionId).toBe("sess-abc");
	}, 30000);
});

describe("extractJson / validateAgainstSchema", () => {
	it("extracts JSON from prose and fenced blocks", () => {
		expect(extractJson('结论如下:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(extractJson('答案是 {"a": {"b": 2}} 如上')).toEqual({ a: { b: 2 } });
		expect(extractJson("no json here")).toBeUndefined();
	});

	it("validates required props, types and enums", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" }, n: { type: "number" }, s: { type: "string", enum: ["low", "high"] } },
			required: ["a", "n", "s"],
		};
		expect(validateAgainstSchema(schema, { a: "x", n: 1, s: "low" })).toEqual([]);
		expect(validateAgainstSchema(schema, { a: "x", n: 1 })).toEqual(["$.s: missing required property"]);
		expect(validateAgainstSchema(schema, { a: "x", n: "1", s: "low" })).toEqual(["$.n: expected number, got string"]);
		expect(validateAgainstSchema(schema, { a: "x", n: 1, s: "mid" })).toEqual([
			'$.s: "mid" is not one of ["low","high"]',
		]);
	});
});
