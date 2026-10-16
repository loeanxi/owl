import { type AgentPresetDefinition, applyPresetToolModifiers } from "../../core/agent-presets.ts";

/** Bare tool names define a fixed preset; modifiers retain ordinary on-demand discovery. */
export function desktopPresetToolAllowlist(preset: AgentPresetDefinition, research = false): string[] | undefined {
	if (research) return undefined;
	if (preset.runtime === "pi") return applyPresetToolModifiers(["read", "bash", "edit", "write"], preset.tools);
	if (preset.tools?.some((name) => !name.startsWith("+") && !name.startsWith("-"))) {
		return applyPresetToolModifiers([], preset.tools);
	}
	return undefined;
}

/** SDK tool allowlists are immutable, so crossing a preset boundary replaces its runtime. */
export function desktopPresetNeedsReplacement(before: AgentPresetDefinition, after: AgentPresetDefinition): boolean {
	return (
		before.runtime !== after.runtime ||
		JSON.stringify(desktopPresetToolAllowlist(before)?.slice().sort()) !==
			JSON.stringify(desktopPresetToolAllowlist(after)?.slice().sort())
	);
}

/** Reject only explicit desktop execution; source diagnosis and conversation inspection remain ordinary work. */
export function desktopComputerCapabilityError(
	message: string,
	presetName: string,
	availableToolNames: readonly string[],
): string | undefined {
	const first = message
		.trim()
		.replace(/^#+\s*/, "")
		.split(/[\n。]/, 1)[0];
	if (
		/^(?:(?:请|帮我|麻烦|先|只读|仅)\s*)*(?:如何|怎么|解释|讲解|介绍|说明|how\b|what\b|why\b|explain\b|describe\b)/i.test(
			first,
		)
	)
		return undefined;
	if (
		/(?:查看|读取|阅读|检查|分析|诊断|排查|定位|修复|开发|实现|修改|优化|适配|改进|重构)/.test(first) &&
		/(?:源码|源代码|代码|调用链|执行链|原理|会话|对话|聊天|日志|提示词|预设|\b(?:source|code|history|jsonl|preset)\b|\.(?:tsx?|cs|rs|ps1)\b)/i.test(
			first,
		)
	)
		return undefined;
	if (
		/^(?:(?:请|帮我|麻烦|先|只读|仅)\s*)*(?:诊断|排查|定位|修复|开发|实现|设计|修改|优化|适配|改进|重构)\s*(?:Owl\s*)?(?:的\s*)?(?:computer\s*use|computer_(?:observe|act|release)|电脑控制|桌面控制)/i.test(
			first,
		)
	)
		return undefined;
	const positive = message
		.split(/[，,。；;\n]/)
		.map(
			(clause) =>
				clause.split(
					/不要|别|別|勿|无需|無需|不必|不(?:用|使用|调用|調用|执行|執行|操作)|\b(?:do not|don't|never|without)\b/i,
				)[0],
		)
		.join(" ");
	const positiveFirst = first
		.split(
			/不要|别|別|勿|无需|無需|不必|不(?:用|使用|调用|調用|执行|執行|操作)|\b(?:do not|don't|never|without)\b/i,
		)[0]
		.replace(/computer\s*use|computer_(?:observe|act|release)/gi, "");
	const computer =
		/computer\s*use|computer_(?:observe|act|release)|电脑控制|桌面操作|原生窗口|记事本|計算器|计算器|鼠标|鼠標|键盘|鍵盤/i.test(
			positive,
		);
	const execution =
		/测试|測試|执行|執行|调用|調用|使用|操作|打开|打開|聚焦|点击|點擊|输入|輸入|键入|观察|觀察|截图|截圖|\b(?:test|run|use|call|click|type|observe|open)\b/i.test(
			positiveFirst,
		);
	if (!computer || !execution) return undefined;
	const required = ["computer_observe"];
	if (
		/computer_act|打开|打開|聚焦|点击|點擊|输入|輸入|键入|滚动|滾動|按键|按鍵|替换|替換|\b(?:click|type|open|scroll|press|focus|restore)\b/i.test(
			positive,
		) ||
		(!/computer_observe/i.test(positive) && /执行|執行|调用|調用|操作|\brun\b/i.test(positive))
	)
		required.push("computer_act");
	if (/computer_release/i.test(positive)) required.push("computer_release");
	const available = new Set(availableToolNames);
	const missing = required.filter((name) => !available.has(name));
	if (missing.length === 0) return undefined;
	return `当前「${presetName}」未提供本次桌面操作需要的工具：${missing.join("、")}，无法执行这项 Computer Use 任务。请在提供这些工具的标准模式会话中执行，并确认 Computer Use 插件已启用。不会改用 Bash、源码或自身日志调查来代替真实桌面操作。`;
}
