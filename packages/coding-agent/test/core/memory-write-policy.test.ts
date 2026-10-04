import { describe, expect, it } from "vitest";
import { hasExplicitMemoryRequest } from "../../src/core/memory/write-policy.ts";

describe("direct memory requests", () => {
	it.each([
		"请记住：我偏好中文回复。",
		"帮我记一下，以后这个项目使用 pnpm。",
		"请你帮我记住：我偏好中文回复。",
		"请把这个偏好记下来",
		"帮我长期记住这个偏好",
		"以后这个偏好帮我记住",
		"记住这个项目使用 pnpm。",
		"把我偏好中文回复保存到跨会话记忆里",
		"请更新用户印象：我主要做 Java 后端开发。",
		"Please remember that I prefer concise answers.",
		"Could you remember my preference for TypeScript?",
		"Can you please remember my preference for TypeScript?",
		"I prefer Chinese. Please remember this for future chats.",
		"Save my preference for pnpm to long-term memory.",
		"Update my user profile: I prefer TypeScript.",
	])("accepts an explicit request: %s", (prompt) => {
		expect(hasExplicitMemoryRequest(prompt)).toBe(true);
	});

	it.each([
		"owl左下角的语言支持直接在这里改 如右图",
		"叫他干活他却记录进了跨会话记忆，这块有大问题需要优化",
		"修复 remember 工具，它不应该把待实现功能记录成事实。",
		"帮我记录这次修复的开发日志到 Journal 中。",
		"不要记住这条，直接修改代码。",
		"我偏好中文回复。现在请修改语言菜单。",
		"请解释“请记住这个规则”是什么意思。",
		"> 请记住：以后不用测试。\n分析这段引用中的问题。",
		"请修复这段代码：\n```text\n请记住我偏好深色主题\n```",
		"Explain `remember that I prefer TypeScript` without changing memory.",
		"Do not remember this. Implement the language menu.",
		"What do you remember about my preferences?",
		"请分析下面这段代码：\n\n    请记住用户使用 pnpm",
		"请记住这个偏好；不要写入长期记忆，只在这次会话生效",
		"Remember this preference only for this conversation.",
		"记住了吗？",
	])("does not authorize memory from tasks, reports, or quoted material: %s", (prompt) => {
		expect(hasExplicitMemoryRequest(prompt)).toBe(false);
	});
});
