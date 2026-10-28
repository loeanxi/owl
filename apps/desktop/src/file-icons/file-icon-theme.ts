/**
 * 文件图标主题（settings.json 的 fileIconTheme 字段），对齐 VS Code「文件图标主题」：
 * none = 不显示文件图标；minimal = Owl 原有的通用图标 + 扩展名着色；
 * seti = VS Code 默认的 Seti 字体图标；material = Material Icon Theme 彩色 SVG。
 * App 启动和设置页切换时写入模块级状态，FileIcon 订阅后即时重绘。
 */

export const FILE_ICON_THEMES = ["none", "minimal", "seti", "material"] as const;

export type FileIconThemeId = (typeof FILE_ICON_THEMES)[number];

export const DEFAULT_FILE_ICON_THEME: FileIconThemeId = "minimal";

export function parseFileIconTheme(value: unknown): FileIconThemeId {
	return (FILE_ICON_THEMES as readonly string[]).includes(value as string)
		? (value as FileIconThemeId)
		: DEFAULT_FILE_ICON_THEME;
}

let current: FileIconThemeId = DEFAULT_FILE_ICON_THEME;
const listeners = new Set<() => void>();

export function getFileIconTheme(): FileIconThemeId {
	return current;
}

export function setFileIconTheme(next: FileIconThemeId): void {
	if (next === current) return;
	current = next;
	for (const listener of listeners) listener();
}

export function subscribeFileIconTheme(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
