// Real smoke: one workflow run with NodeWorldDriver (true glob) + PiAgentDriver
// (one true owl LLM ask). Run: node scripts/smoke-real.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { startRun } = await import(pathToFileURL(join(pkgRoot, "dist/runner.js")).href);
const { NodeWorldDriver, PiAgentDriver } = await import(pathToFileURL(join(pkgRoot, "dist/driver-node.js")).href);

const cwd = mkdtempSync(join(tmpdir(), "owl-wf-smoke-"));
writeFileSync(join(cwd, "hello.txt"), "hello owl\n");
const runsDir = join(cwd, ".owl-workflow-runs");

const script = `
interface Answer {
	/** 一句话结论。 */
	answer: string;
	/** 1-10 的把握分。 */
	confidence: number;
}
phase("盘点目录");
const txtFiles = await files.glob("*.txt");
phase("问模型一个 typed 问题");
const judge = agent("小助手", { system: "回答保持一句话。" });
const first = await judge.ask<Answer>("用一句话说明:工作流引擎里 journal 的作用是什么?");
const second = await judge.ask<Answer>("再用一句话说明:它为什么能让 amend 变便宜?");
return { txtFiles, first, second };
`;

const driver = {
	world: new NodeWorldDriver(cwd),
	agent: new PiAgentDriver({
		cwd,
		owlCommand: process.execPath,
		owlArgsPrefix: [join(pkgRoot, "../coding-agent/dist/bundle/cli.js")],
		timeoutMs: 180_000,
		model: "zai-coding-cn/glm-5.3-flash",
		env: { OWL_CODING_AGENT_DIR: "D:/owl/owl-re-v1/data/owl" },
	}),
	async executeAsk(req) {
		return this.agent.executeAsk(req);
	},
	async executeWorldRead(op, args) {
		return this.world.execute(op, args);
	},
};

const run = startRun({ script, driver, runsDir, name: "smoke-real", maxConcurrency: 2 });
const events = [];
run.compile;
const settled = await run.settled;
console.log("settled:", JSON.stringify(settled, null, 2));
