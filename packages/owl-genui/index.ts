/**
 * owl-genui 扩展入口（node half）。
 *
 * 从 dsh-genui 的 cordis 插件移植为 owl 扩展（ExtensionAPI）。做三件事：
 *  1. before_agent_start 注入 GenUI 系统提示章节（围栏语法 + 类型白名单 +
 *     行为规则），等价 dsh 的 ctx.systemPrompt.section()；
 *  2. 注册 render_ui 工具（第二条 GenUI 出口，渲染为工具行卡片）；
 *  3. 把 SKILL.md 同步到 <agentDir>/skills/owl-genui/（owl 的技能是文件发现
 *     式：模型按 description 匹配后用 read 工具读取全文，等价 dsh 的
 *     bundledSkillProvider）。
 *
 * 会话没有本插件时模型不会输出围栏，一切照旧——纯增量。
 * @module owl-genui
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@owl/owl-coding-agent";
import { createRenderUiTool } from "./src/plugin/tool.ts";
import { GENUI_SECTION_TEXT } from "./src/plugin/section.ts";

/** 本包根目录（index.ts 位于包根）。 */
function packageRoot(): string {
	return dirname(fileURLToPath(new URL(import.meta.url)));
}

/**
 * 把包内 SKILL.md 同步到技能目录（内容变化才写）。同步失败只打日志——技能
 * 缺位时系统提示章节仍覆盖核心契约，渲染不受影响。
 */
async function syncSkill(): Promise<void> {
	try {
		const source = join(packageRoot(), "SKILL.md");
		const raw = await readFile(source, "utf8");
		const target = join(getAgentDir(), "skills", "owl-genui", "SKILL.md");
		const existing = await readFile(target, "utf8").catch(() => null);
		if (existing !== raw) {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, raw, "utf8");
		}
	} catch (error) {
		console.warn("[owl-genui] SKILL.md sync failed:", error instanceof Error ? error.message : error);
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool(createRenderUiTool());

	pi.on("before_agent_start", (event) => {
		// 段名须匹配 /^[a-z][a-z0-9_-]*$/；作为 STRUCTURED_OUTPUT 类章节拼进
		// 系统提示词（buildSystemPromptSections 的 sections 表）。
		event.systemPromptOptions.sections.genui = GENUI_SECTION_TEXT;
	});

	void syncSkill();
}
