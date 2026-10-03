/**
 * 桌面端主题：dark / light / system。
 * 值来自 settings.json 的 theme 字段；system 跟随操作系统 prefers-color-scheme
 * 并在其变化时实时切换。切档通过在 <html> 上写 data-owl-theme 实现，
 * index.css 据此覆盖 --color-owl-* 变量，组件无需感知。
 */
export type ThemePreference = "dark" | "light" | "system";

const lightQuery = window.matchMedia("(prefers-color-scheme: light)");

let preference: ThemePreference = "dark";

function resolved(): "dark" | "light" {
	if (preference === "system") return lightQuery.matches ? "light" : "dark";
	return preference;
}

function apply(): void {
	document.documentElement.dataset.owlTheme = resolved();
	// 广播解析档（可能因 system 跟随操作系统而变）：外观自定义颜色监听后重放内联变量。
	window.dispatchEvent(new Event("owl-theme-change"));
}

/** 当前实际生效的深浅档（system 已解析）；外观自定义颜色按它决定落在哪个档。 */
export function getResolvedTheme(): "dark" | "light" {
	return resolved();
}

/** 应用一档主题偏好；重复调用会覆盖上一档（设置页即时切档、启动时初始化共用）。 */
export function setThemePreference(pref: ThemePreference): void {
	preference = pref;
	apply();
}

// system 档下操作系统切换深浅色时实时跟随；非 system 档不受影响。
lightQuery.addEventListener("change", () => {
	if (preference === "system") apply();
});

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "dark" || value === "light" || value === "system";
}
