/**
 * 内置 tab 注册：files / changes / editor / image 与第三方扩展走同一套
 * registerTab API（dsh-better-sidebar 的"内置 5 tab 也走 ctx.betterSidebar"
 * 对等设计）。模块加载即注册；HMR 下重复调用幂等。
 */
import { registerTab, type TabDefinition } from "./registry.ts";
import { ChangesTab } from "./tabs/ChangesTab.tsx";
import { EditorTab } from "./tabs/EditorTab.tsx";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { ImageTab } from "./tabs/ImageTab.tsx";
import { IconFile, IconGitBranch, IconImage, IconFolder } from "./icons.tsx";

const DEFINITIONS: TabDefinition[] = [
	{
		kind: "files",
		title: "文件",
		icon: (size) => <IconFolder size={size ?? 14} />,
		component: FilesTab,
	},
	{
		kind: "changes",
		title: "文件变动",
		icon: (size) => <IconGitBranch size={size ?? 14} />,
		component: ChangesTab,
	},
	{
		kind: "editor",
		title: "编辑器",
		icon: (size) => <IconFile size={size ?? 14} />,
		component: EditorTab,
		// exts 留空：editor 是 viewer 的兜底 kind（registry.viewerKindFor）
	},
	{
		kind: "image",
		title: "图片",
		icon: (size) => <IconImage size={size ?? 14} />,
		component: ImageTab,
		exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"],
	},
];

let done = false;

export function registerBuiltins(): void {
	if (done) return;
	done = true;
	for (const def of DEFINITIONS) registerTab(def);
}
