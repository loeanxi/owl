import { describe, expect, it } from "vitest";
import {
	assistantCommittedToMemory,
	hasExplicitMemoryRequest,
	memoryWriteDenial,
} from "../../src/core/memory/write-policy.ts";

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

describe("assistant commitment authorizes memory writes", () => {
	it.each([
		"收到，记下了 👍",
		"记下了，下次遇到项目里有名有姓的词，先 grep 再开口。",
		"这回真记了——存到了全局跨会话记忆里。",
		"好的，我会记住这个偏好。",
		"已保存到跨会话记忆。",
		"我把这条写入了长期记忆。",
		"已更新用户印象。",
	])("recognizes a commitment in the assistant reply: %s", (text) => {
		expect(assistantCommittedToMemory(text)).toBe(true);
	});

	it.each([
		"不用记住了，直接干活。",
		"别记住这条。",
		"没有记住任何东西。",
		"记住了吗？",
		"记住了没？",
		"下次遇到项目里的具体名词，我会先 grep 再开口。", // 行为承诺 ≠ 记忆承诺
		"这个文件的改动已保存到 reports/report.md。", // 保存的不是记忆
	])("does not treat negations, questions, or unrelated claims as commitment: %s", (text) => {
		expect(assistantCommittedToMemory(text)).toBe(false);
	});

	it("lets a remembered promise through the denial gate, but not a disabled switch", () => {
		expect(memoryWriteDenial("可以", true, true)).toBeUndefined();
		expect(memoryWriteDenial("可以", true, false)).toMatch(/未保存/);
		expect(memoryWriteDenial("请记住这条", true, false)).toBeUndefined();
		expect(memoryWriteDenial("可以", false, true)).toMatch(/已关闭/);
	});
});
