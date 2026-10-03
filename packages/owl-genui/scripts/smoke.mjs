/**
 * node half 冒烟脚本：用 jiti 加载扩展入口，验证
 *  1. TS 扩展可被 jiti 加载（owl 扩展加载器的真实路径）；
 *  2. render_ui 工具注册成功；
 *  3. before_agent_start 钩子把 GenUI 章节写进 systemPromptOptions.sections；
 *  4. SKILL.md 同步到 <agentDir>/skills/owl-genui/。
 * 用法：node scripts/smoke.mjs（OWL_CODING_AGENT_DIR 未设时写入默认 agent dir）
 */
import { createJiti } from "jiti";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("../index.ts");

const registered = [];
const hooks = {};
const pi = {
	registerTool: (tool) => registered.push(tool.name),
	on: (event, handler) => {
		hooks[event] = handler;
	},
};
await mod.default(pi);

console.log("registered tools:", registered.join(", "));
console.log("hooks:", Object.keys(hooks).join(", "));

const options = { sections: {} };
hooks.before_agent_start({ systemPromptOptions: options }, {});
const section = options.sections.genui;
console.log("section injected:", typeof section === "string" && section.length > 500, `(${section?.length ?? 0} chars)`);
if (!section.includes("owl-ui") || section.includes("dsh-ui")) {
	console.error("FAIL: section text does not use the owl-ui fence");
	process.exit(1);
}

// 工具执行路径冒烟：好 spec 渲染成功 + 坏 spec 返回 invalid 协议
const created = [];
pi.registerTool = (tool) => created.push(tool);
await mod.default(pi);
const renderUi = created.find((tool) => tool.name === "render_ui");
const good = await renderUi.execute("smoke", { spec: { items: [{ type: "stat", label: "A", value: "1" }] } }, undefined, undefined, {});
console.log("render_ui good spec:", good.content[0].text.split("\n")[1], "| details.genuiSpec:", good.details.genuiSpec !== null);
const bad = await renderUi.execute("smoke", { spec: { items: [{ type: "stat", label: 42, value: "x" }] } }, undefined, undefined, {});
console.log("render_ui bad spec:", bad.content[0].text.split("\n")[1]);

// SKILL.md 同步（fire-and-forget 异步写入，稍等其落盘）
await new Promise((resolve) => setTimeout(resolve, 500));
const agentDir = process.env.OWL_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE, ".owl", "agent");
const skillPath = join(agentDir, "skills", "owl-genui", "SKILL.md");
console.log("SKILL.md synced:", existsSync(skillPath) && readFileSync(skillPath, "utf8").includes("owl-ui"), "->", skillPath);
