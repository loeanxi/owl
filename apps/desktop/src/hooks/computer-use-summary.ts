const actions: Record<string, readonly [string, string]> = {
	click: ["点击", "Click"],
	type: ["输入文本", "Type text"],
	key: ["发送按键", "Press key"],
	scroll: ["滚动", "Scroll"],
	focus: ["聚焦窗口", "Focus window"],
	restore: ["恢复窗口", "Restore window"],
	invoke: ["执行控件操作", "Invoke control"],
	set_value: ["设置控件值", "Set control value"],
	select: ["选择控件", "Select control"],
	toggle: ["切换控件状态", "Toggle control"],
	open_app: ["打开应用", "Open app"],
};

export function computerUseSummary(
	name: string,
	input: Record<string, unknown>,
	language: "zh" | "en",
): string | undefined {
	const english = language === "en";
	if (name === "computer_observe") {
		const target =
			typeof input.windowId === "string"
				? input.windowId
				: typeof input.windowQuery === "string"
					? input.windowQuery
					: english
						? "current app"
						: "当前应用";
		return `${english ? "Observe window" : "观察窗口"} ${target}`;
	}
	if (name === "computer_release") return english ? "Release desktop control" : "释放桌面控制";
	if (name !== "computer_act") return undefined;
	const action = typeof input.action === "string" ? input.action : "";
	const label = actions[action]?.[english ? 1 : 0] ?? (english ? "Operate window" : "操作窗口");
	const target =
		action === "open_app" && typeof input.app === "string"
			? ` ${input.app}`
			: typeof input.elementId === "string"
				? ` ${input.elementId}`
				: "";
	const combo = action === "key" && typeof input.combo === "string" ? ` (${input.combo})` : "";
	const mode =
		input.inputMode === "foreground"
			? english
				? "Foreground"
				: "前台控制"
			: input.inputMode === "background"
				? english
					? "Background"
					: "后台"
				: english
					? "Auto"
					: "自动";
	return `${mode} · ${label}${target}${combo}`;
}
