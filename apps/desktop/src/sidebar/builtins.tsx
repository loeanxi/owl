/**
 * 内置 tab 注册：files / changes / editor / image / tasks / sidechat 与第三方
 * 扩展走同一套 registerTab API（dsh-better-sidebar 的"内置 5 tab 也走
 * ctx.betterSidebar"对等设计）。模块加载即注册；HMR 下重复调用幂等。
 *
 * 编辑器是懒加载 chunk（React.lazy）：语言包 + CodeMirror ~600KB 不进首屏。
 * 单例 tab 的图标沿用 quick.tsx 的彩色（工作台 tab 条与开始页一致）。
 */
import { lazy } from "react";
import { registerTab, type TabDefinition } from "./registry.ts";
import { BrowserTab } from "./tabs/BrowserTab.tsx";
import { ChangesTab } from "./tabs/ChangesTab.tsx";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { ImageTab } from "./tabs/ImageTab.tsx";
import { ImpressionTab } from "./tabs/ImpressionTab.tsx";
import { TasksTab } from "./tabs/TasksTab.tsx";
import { SideChatTab } from "./tabs/SideChatTab.tsx";
import { IconFile, IconImage } from "./icons.tsx";
import { quickActionOf } from "./quick.tsx";

const EditorTab = lazy(() => import("./tabs/EditorTab.tsx").then((m) => ({ default: m.EditorTab })));
const TerminalTab = lazy(() => import("./tabs/TerminalTab.tsx").then((m) => ({ default: m.TerminalTab })));

/** 单例快捷 tab 的彩色图标（kind 必须已在 QUICK_ACTIONS 里）。 */
function quickIcon(kind: string): TabDefinition["icon"] {
	return (size) => {
		const action = quickActionOf(kind);
		const glyph = action?.icon(size ?? 14);
		return glyph ?? null;
	};
}

const DEFINITIONS: TabDefinition[] = [
	{
		kind: "files",
		title: "文件",
		icon: quickIcon("files"),
		component: FilesTab,
	},
	{
		kind: "changes",
		title: "文件变动",
		icon: quickIcon("changes"),
		component: ChangesTab,
	},
	{
		kind: "terminal",
		title: "终端",
		icon: quickIcon("terminal"),
		// xterm + 语言包都重，走懒加载 chunk
		component: TerminalTab,
	},
	{
		kind: "browser",
		title: "浏览器",
		icon: quickIcon("browser"),
		component: BrowserTab,
	},
	{
		kind: "tasks",
		title: "任务管理",
		icon: quickIcon("tasks"),
		component: TasksTab,
	},
	{
		kind: "impression",
		title: "用户印象",
		icon: quickIcon("impression"),
		component: ImpressionTab,
	},
	{
		kind: "sidechat",
		title: "侧边对话(beta)",
		icon: quickIcon("sidechat"),
		component: SideChatTab,
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
