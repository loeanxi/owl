import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DesktopClientRequestWithoutId, ResearchPromptSettings as PromptLibrary, ResearchPromptsResult } from "../../bridge/protocol.ts";
import { ResearchPromptSettings } from "./ResearchPromptSettings.tsx";
import { ResearchPromptController } from "./research-prompts.ts";

vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return { ...actual, useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot) };
});

async function panel(content: string, overrides: { running?: boolean; connected?: boolean; settings?: PromptLibrary; configure?: (controller: ResearchPromptController) => void } = {}): Promise<string> {
	const controller = new ResearchPromptController({
		async request<T>(_request: DesktopClientRequestWithoutId) {
			return { ok: true, result: { settings: overrides.settings ?? { version: 1, enabled: false, activePresetId: null, presets: [{ id: "first", name: "示例研究", content }] }, defaultPrompt: "真实默认研究提示词" } as ResearchPromptsResult as T };
		},
	});
	controller.setConnected(true);
	await controller.load();
	overrides.configure?.(controller);
	if (overrides.connected === false) controller.setConnected(false);
	return renderToStaticMarkup(React.createElement(ResearchPromptSettings, { controller, running: overrides.running ?? false, onClose: () => undefined }));
}

describe("research prompt manager states", () => {
	it("provides a visible return control, local import/export, and the real default prompt preview", async () => {
		const markup = await panel("研究正文");
		expect(markup).toContain("返回对话");
		expect(markup).toContain("导入文件");
		expect(markup).toContain("导出提示词库");
		expect(markup).toContain("真实默认研究提示词");
		expect(markup).toContain("普通聊天不受影响");
		expect(markup).toContain("保存并一键覆盖");
	});
	it("blocks empty prompt activation while explaining that text is required", async () => {
		const markup = await panel("");
		expect(markup).toMatch(/type="checkbox"[^>]*disabled/);
		expect(markup).toMatch(/class="research-prompts-primary"[^>]*disabled/);
		expect(markup).toContain("填写后才能启用");
	});
	it("keeps running tasks intact and makes next-turn scope explicit", async () => {
		const markup = await panel("研究正文", { running: true });
		expect(markup).toContain("当前任务继续使用原提示词");
		expect(markup).not.toMatch(/class="research-prompts-primary"[^>]*disabled/);
	});
	it("keeps the editor available offline while disabling server writes", async () => {
		const markup = await panel("研究正文", { connected: false });
		expect(markup).toContain("本地服务已断开");
		expect(markup).toMatch(/class="research-prompts-primary"[^>]*disabled/);
		expect(markup).not.toMatch(/class="research-prompts-text"[^>]*disabled/);
	});
	it("shows category filtering, keyword search, multiple model tags and matching counts", async () => {
		const markup = await panel("", { settings: { version: 1, enabled: false, activePresetId: null, presets: [
			{ id: "claude", name: "Claude only", content: "Hidden Claude text", modelFamilies: ["claude"] },
			{ id: "shared", name: "Shared sample", content: "Shared text", modelFamilies: ["deepseek", "gpt"] },
		] }, configure: (controller) => controller.setFilters({ modelFilter: "deepseek", searchQuery: "shared" }) });
		expect(markup).toContain("模型分类");
		expect(markup).toContain("搜索提示词");
		expect(markup).toContain("显示 1 / 2 份");
		expect(markup).toContain("适用模型（可多选）");
		expect(markup).toContain("适用模型：DeepSeek、GPT / ChatGPT");
		expect(markup).toMatch(/<details class="research-prompts-model-editor">/);
		expect(markup).toContain("仍需验证");
		expect(markup).toMatch(/<input type="checkbox"(?=[^>]*value="deepseek")(?=[^>]*checked)[^>]*>/);
		expect(markup).toMatch(/<input type="checkbox"(?=[^>]*value="gpt")(?=[^>]*checked)[^>]*>/);
		expect(markup).toContain('type="search"');
		expect(markup).toContain('value="shared"');
		expect(markup).not.toContain("Hidden Claude text");
	});
	it("keeps the actual active status visible with zero matches and blocks applying a hidden preset", async () => {
		const markup = await panel("", { settings: { version: 1, enabled: true, activePresetId: "claude", presets: [
			{ id: "claude", name: "Active Claude", content: "Hidden active text", modelFamilies: ["claude"] },
		] }, configure: (controller) => controller.setFilters({ modelFilter: "gemini" }) });
		expect(markup).toContain("已启用：Active Claude");
		expect(markup).toContain("显示 0 / 1 份");
		expect(markup).toContain("没有符合当前分类和关键词的提示词");
		expect(markup).toContain("重置筛选");
		expect(markup).toMatch(/class="research-prompts-primary"[^>]*disabled/);
		expect(markup).not.toContain("Hidden active text");
		expect(markup).not.toMatch(/class="research-prompts-restore"[^>]*disabled/);
	});
	it("retains unknown valid categories in both filtering and model editing controls", async () => {
		const markup = await panel("", { settings: { version: 1, enabled: false, activePresetId: null, presets: [
			{ id: "future", name: "Future model sample", content: "Future text", modelFamilies: ["future-model"] },
		] }, configure: (controller) => controller.setFilters({ modelFilter: "future-model" }) });
		expect(markup).toMatch(/<option value="future-model" selected="">future-model \(1\)<\/option>/);
		expect(markup).toMatch(/<input type="checkbox"(?=[^>]*value="future-model")(?=[^>]*checked)[^>]*>/);
		expect(markup).toContain("显示 1 / 1 份");
	});
	it("keeps the edited prompt visible and explains automatic filter reset", async () => {
		const markup = await panel("", { settings: { version: 1, enabled: false, activePresetId: null, presets: [
			{ id: "first", name: "Common first", content: "First text" },
			{ id: "second", name: "Common second", content: "Second text" },
		] }, configure: (controller) => { controller.setFilters({ searchQuery: "common" }); controller.edit({ name: "Renamed first" }); } });
		expect(markup).toContain("当前提示词已不符合筛选，已重置筛选");
		expect(markup).toContain("显示 2 / 2 份");
		expect(markup).toMatch(/<option value="first" selected="">Renamed first<\/option>/);
		expect(markup).toContain("research-prompts-text");
		expect(markup).not.toMatch(/class="research-prompts-primary"[^>]*disabled/);
	});
});
