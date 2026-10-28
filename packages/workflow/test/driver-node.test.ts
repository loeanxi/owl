import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NodeWorldDriver, PiAgentDriver } from "../src/driver-node.js";

function tmpWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "owl-wf-driver-"));
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\nconst needle = here();\n");
	writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "c.ts"), "const needle = elsewhere();\n");
	return dir;
}

describe("NodeWorldDriver", () => {
	it("globs, reads and greps the workspace", async () => {
		const cwd = tmpWorkspace();
		try {
			const driver = new NodeWorldDriver(cwd);
			expect(await driver.execute("files.glob", ["**/*.ts"])).toEqual(["a.ts", "b.ts", "src/c.ts"]);
			expect(await driver.execute("files.glob", ["src/*.ts"])).toEqual(["src/c.ts"]);
			expect(await driver.execute("files.read", ["b.ts"])).toContain("export const b = 2;");
			const matches = (await driver.execute("files.grep", ["needle"])) as Array<{ path: string; line: number }>;
			expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(["a.ts:2", "src/c.ts:1"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reads git status/log from a real repository", async () => {
		const cwd = tmpWorkspace();
		try {
			execFileSync("git", ["init"], { cwd });
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd });
			const driver = new NodeWorldDriver(cwd);
			const status = (await driver.execute("git.status", [])) as { clean: boolean; branch?: string };
			expect(status.clean).toBe(true);
			const log = (await driver.execute("git.log", [5])) as Array<{ subject: string }>;
			expect(log[0].subject).toBe("init");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("runs a real command and returns nonzero exits as values", async () => {
		const cwd = tmpWorkspace();
		try {
			const driver = new NodeWorldDriver(cwd);
			const ok = (await driver.execute("world.run", ["node", ["-e", "console.log(1+1)"]])) as {
				exitCode: number;
				stdout: string;
			};
			expect(ok).toMatchObject({ exitCode: 0, stdout: "2\n" });
			const fail = (await driver.execute("world.run", ["node", ["-e", "process.exit(3)"]])) as { exitCode: number };
			expect(fail.exitCode).toBe(3);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("PiAgentDriver", () => {
	it("parses the owl json event stream: counts write tools, keeps the last assistant text", async () => {
		const cwd = tmpWorkspace();
		try {
			// A stand-in "owl" emitting the same NDJSON event shapes the real CLI does.
			const fake = join(cwd, "fake-owl.mjs");
			writeFileSync(
				fake,
				[
					`const events = [`,
					`  {type:"toolcall_start", toolName:"read"},`,
					`  {type:"toolcall_start", toolName:"edit"},`,
					`  {type:"toolcall_start", toolName:"bash"},`,
					`  {type:"agent_end", messages:[`,
					`    {role:"assistant", content:[{type:"text",text:"first draft"}]},`,
					`    {role:"assistant", content:[{type:"text",text:"final answer"}]},`,
					`  ]},`,
					`];`,
					`for (const e of events) console.log(JSON.stringify(e));`,
				].join("\n"),
				"utf8",
			);
			const spawned: string[][] = [];
			const driver = new PiAgentDriver({
				cwd,
				owlCommand: process.execPath,
				owlArgsPrefix: [fake],
				onSpawn: (a) => spawned.push(a),
			});
			const outcome = await driver.executeAsk({ actorKey: "s0#1", instructions: "评审这个文件" });
			expect(outcome.stats?.worldToolCalls).toBe(2); // edit + bash, not read
			expect(outcome.result).toBe("final answer");
			// The child argv shape: runtime + entry + mode flags + persona-less prompt.
			expect(spawned[0][spawned[0].length - 1]).toBe("评审这个文件");
			expect(spawned[0]).toContain("--mode");
			expect(spawned[0]).toContain("--session-id");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("carries the persona on --append-system-prompt", async () => {
		const cwd = tmpWorkspace();
		try {
			const fake = join(cwd, "fake-owl-persona.mjs");
			writeFileSync(
				fake,
				`console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"ok"}]}]}));\n`,
				"utf8",
			);
			const driver = new PiAgentDriver({ cwd, owlCommand: process.execPath, owlArgsPrefix: [fake] });
			const outcome = await driver.executeAsk({ actorKey: "s0#1", instructions: "hi", persona: "你是严格的评审员" });
			expect(outcome.result).toBe("ok");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
