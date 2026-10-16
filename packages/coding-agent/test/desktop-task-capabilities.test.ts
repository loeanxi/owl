import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PRESETS } from "../src/core/agent-presets.ts";
import {
	desktopComputerCapabilityError,
	desktopPresetNeedsReplacement,
	desktopPresetToolAllowlist,
} from "../src/modes/desktop/task-capabilities.ts";

describe("desktop task capabilities", () => {
	it.each([
		"查看这个会话：history.jsonl，里面调用了 computer_act。",
		"只读检查 Computer Use 源码和日志，解释调用链，不实际操作电脑。",
		"修复 Computer Use 失败的问题，先定位原因。",
		"如何使用 computer_observe、computer_act、computer_release？",
		"How do I use computer_observe?",
		"Explain how to use Computer Use",
		"Computer Use 是什么？",
		"查看 computer_act 的调用链",
		"分析 computer_act 的执行链",
		"不要使用 computer_act，只解释它的参数",
	])("allows inspection and implementation without native tools: %s", (message) => {
		expect(desktopComputerCapabilityError(message, "极简模式", ["read", "bash", "edit"])).toBeUndefined();
	});
	it.each([
		"测试 Owl 新版 Computer Use，完成真实桌面操作闭环。",
		"用鼠标点击记事本，在编辑区域输入中文。",
		"使用 computer_observe 观察当前窗口。",
	])("stops unsupported execution before a model is involved: %s", (message) => {
		expect(desktopComputerCapabilityError(message, "极简模式", ["read", "bash", "edit"])).toContain("极简模式");
	});
	it("permits an observation-only loadout and normal registered on-demand capabilities", () => {
		expect(
			desktopComputerCapabilityError("只用 computer_observe 观察窗口，不要调用 computer_act。", "只读", [
				"computer_observe",
			]),
		).toBeUndefined();
		expect(
			desktopComputerCapabilityError("先调用 computer_observe 观察窗口。", "只读", ["computer_observe"]),
		).toBeUndefined();
		expect(
			desktopComputerCapabilityError("只使用 computer_observe 查看当前窗口", "极简", ["read", "bash", "edit"]),
		).toContain("computer_observe");
		expect(
			desktopComputerCapabilityError("使用 computer_observe 观察当前窗口。", "只读", ["computer_observe"]),
		).toBeUndefined();
		expect(
			desktopComputerCapabilityError("测试 Computer Use，在记事本输入中文。", "标准模式", [
				"computer_observe",
				"computer_act",
				"tool_search",
			]),
		).toBeUndefined();
	});
	it("keeps fixed tool lists immutable while preserving modifier and research loadouts", () => {
		const minimal = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === "minimal")!;
		const standard = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === "standard")!;
		const ptc = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === "ptc")!;
		expect(desktopPresetToolAllowlist(minimal)).toEqual(["read", "bash", "edit"]);
		expect(desktopPresetToolAllowlist(standard)).toBeUndefined();
		expect(desktopPresetToolAllowlist(ptc)).toBeUndefined();
		expect(desktopPresetToolAllowlist(minimal, true)).toBeUndefined();
		expect(desktopPresetNeedsReplacement(minimal, standard)).toBe(true);
		expect(desktopPresetNeedsReplacement(standard, minimal)).toBe(true);
		expect(desktopPresetNeedsReplacement(standard, ptc)).toBe(false);
	});
});
