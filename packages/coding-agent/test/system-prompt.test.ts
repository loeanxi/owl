import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt, buildSystemPromptSections } from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
	requiresMetadataTracking: false,
};

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<tools>\n(none)\n");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("prompt structure", () => {
		test("keeps the default and custom prompt prefixes exact", () => {
			const defaultPrompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] });
			const customPrompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				cwd: "/tmp",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(defaultPrompt.startsWith("你是 Owl Si，Owl 桌面端的超级智能助手。")).toBe(true);
			expect(defaultPrompt).toContain(
				"- 使用用户所用的语言回复（中文提问 → 中文回答），工具调用之间的过程说明也一样。",
			);
			expect(defaultPrompt).toContain("在同一轮里一次发出多个工具调用");
			expect(customPrompt.startsWith("You are Exact.\n\n<cwd>")).toBe(true);
		});

		test("preserves an exact forced prompt without sections", () => {
			expect(buildSystemPrompt({ forceSystemPrompt: "exact", cwd: "/tmp" })).toBe("exact");
		});

		test("instructs short factual public progress and keeps authorized tool work moving after updates", () => {
			const prompt = buildSystemPrompt({
				cwd: "/tmp",
				selectedTools: ["read", "edit", "bash"],
				contextFiles: [],
				skills: [],
			});
			expect(prompt).toContain("在同一条助手回复里先用公开文本给 1–2 句简短的可见说明，再发出工具调用");
			expect(prompt).toContain("确认重要发现、调整方案、遇到阻塞或完成验证时");
			expect(prompt).toContain("已确认的结果和下一步");
			expect(prompt).toContain("行动、证据和进展");
			expect(prompt).toContain("不暴露内部推理");
			expect(prompt).toContain("不编造成功、百分比或剩余时间");
			expect(prompt).toContain("没有新事实时不要重复");
			expect(prompt).toContain("发出说明后继续执行已授权的工具操作");
			expect(prompt).toContain("不要停下来等待用户再次催促");
			expect(prompt).toContain("thinking 中的计划不算公开说明");
			expect(prompt).toContain("只输出 JSON、只输出代码");
			expect(prompt).toContain("优先满足用户指定的格式");
			expect(prompt).toContain("不要为了说明额外结束一轮");
			expect(prompt).toContain("默认最终回答控制在 10 行以内");
			expect(prompt).toContain("这不限制执行中的必要进展说明");
		});

		test("does not inject default progress rules into custom or exact forced prompts", () => {
			const customPrompt = "Custom instructions.\n\nKeep this wording verbatim.";
			const sections = buildSystemPromptSections({
				customPrompt,
				cwd: "/tmp",
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
			});
			expect(sections.preamble).toBe(customPrompt);
			expect(buildSystemPrompt({ customPrompt, cwd: "/tmp", contextFiles: [], skills: [] })).not.toContain(
				"过程说明不是最终回答",
			);
			const forced = "  Exact forced prompt.\n\nDo not append anything.  ";
			expect(
				buildSystemPrompt({
					forceSystemPrompt: forced,
					customPrompt,
					appendSystemPrompt: "ignored addendum",
					contextFiles: [{ path: "/tmp/AGENTS.md", content: "ignored project context" }],
					selectedTools: ["read"],
					toolSnippets: { read: "ignored tool snippet" },
					cwd: "/tmp",
				}),
			).toBe(forced);
		});

		test("maps appended instructions and project context to stable sections", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				appendSystemPrompt: "Additional instructions.",
				contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }],
				selectedTools: [],
				skills: [],
				cwd: "/tmp",
			});

			expect(prompt).toContain("<addendum>\nAdditional instructions.\n</addendum>");
			expect(prompt).toContain(
				'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/tmp/AGENTS.md">',
			);
			expect(prompt).toContain("<cwd>\n/tmp\n</cwd>");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("sends content and file search to grep and find when those tools are available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find", "ls", "bash"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Search file contents with the grep tool");
			expect(prompt).toContain("find files by name with the find tool");
			expect(prompt).toContain("list a directory with the ls tool");
			expect(prompt).toContain("Use bash only for commands that must execute");
			expect(prompt).not.toContain("Use bash for file operations like ls, rg, find");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test("keeps a large skill catalog compact when skill discovery is available", () => {
			const skills = Array.from({ length: 60 }, (_, index) => ({
				...testSkill,
				name: `workflow-${index}`,
				description: "Detailed instructions only needed after discovery. ".repeat(20),
				filePath: `/skills/workflow-${index}/SKILL.md`,
			}));
			const prompt = buildSystemPrompt({
				customPrompt: "Assistant",
				cwd: "/tmp",
				selectedTools: ["read", "skill_search"],
				skills,
			});
			expect(prompt.length).toBeLessThan(4096);
			expect(prompt).toContain("skill_search");
			expect(prompt).toContain("workflow-59");
			expect(prompt).not.toContain("Detailed instructions only needed after discovery.");
			expect(prompt).not.toContain("/skills/workflow-0/SKILL.md");
		});

		test("does not advertise disabled skills in the discovery index", () => {
			const prompt = buildSystemPrompt({
				cwd: "/tmp",
				selectedTools: ["skill_search"],
				skills: [testSkill, { ...testSkill, name: "manual-only", disableModelInvocation: true }],
			});
			expect(prompt).toContain("test-skill");
			expect(prompt).not.toContain("manual-only");
		});

		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<skills>");
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>test-skill</name>");
			expect(prompt).toContain("Use bash to load a skill's file");
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});
});
