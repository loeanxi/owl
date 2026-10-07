/**
 * 内置 tab 注册：files / changes / editor / image / tasks / sidechat 与第三方
 * 扩展走同一套 registerTab API（dsh-better-sidebar 的"内置 5 tab 也走
 * ctx.betterSidebar"对等设计）。模块加载即注册；HMR 下重复调用幂等。
 *
 * 编辑器是懒加载 chunk（React.lazy）：语言包 + CodeMirror ~600KB 不进首屏。
 * 单例 tab 的图标沿用 quick.tsx 的彩色（工作台 tab 条与开始页一致）。
 */
import { lazy } from "react";
import { t } from "../i18n/index.ts";
import { registerTab, type TabDefinition } from "./registry.ts";
import { BrowserTab } from "./tabs/BrowserTab.tsx";
import { ChangesTab } from "./tabs/ChangesTab.tsx";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { ImageTab } from "./tabs/ImageTab.tsx";
import { DocumentTab } from "./tabs/DocumentTab.tsx";
import { ImpressionTab } from "./tabs/ImpressionTab.tsx";
import { MirrorTab } from "./tabs/MirrorTab.tsx";
import { ManagerTab } from "./tabs/ManagerTab.tsx";
import { ReviewTab } from "./tabs/ReviewTab.tsx";
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
		kind: "document",
		get title() { return t("settings.sidecards.filePreview"); },
		icon: (size) => <IconFile size={size ?? 14} />,
		component: DocumentTab,
		exts: ["md", "markdown", "html", "htm", "txt", "csv", "tsv"],
	},
	{
		kind: "files",
		get title() { return t("dev.files"); },
		icon: quickIcon("files"),
		component: FilesTab,
	},
	{
		kind: "changes",
		get title() { return t("dev.changes"); },
		icon: quickIcon("changes"),
		component: ChangesTab,
	},
	{
		kind: "review",
		get title() { return t("wb.review"); },
		icon: quickIcon("review"),
		component: ReviewTab,
	},
	{
		kind: "terminal",
		get title() { return t("start.terminal"); },
		icon: quickIcon("terminal"),
		// xterm + 语言包都重，走懒加载 chunk
		component: TerminalTab,
	},
	{
		kind: "browser",
		get title() { return t("app.browserTab"); },
		icon: quickIcon("browser"),
		component: BrowserTab,
	},
	{
		kind: "mirror",
		get title() { return t("wb.drama"); },
		icon: quickIcon("mirror"),
		component: MirrorTab,
	},
	{
		kind: "manager",
		title: "号池 Manager",
		icon: quickIcon("mirror"),
		component: ManagerTab,
	},
	{
		kind: "tasks",
		get title() { return t("wb.tasks"); },
		icon: quickIcon("tasks"),
		component: TasksTab,
	},
	{
		kind: "impression",
		get title() { return t("wb.impression"); },
		icon: quickIcon("impression"),
		component: ImpressionTab,
	},
	{
		kind: "sidechat",
		get title() { return t("wb.sidechat"); },
		icon: quickIcon("sidechat"),
		component: SideChatTab,
	},
	{
		kind: "editor",
		get title() { return t("wb.editor"); },
		icon: (size) => <IconFile size={size ?? 14} />,
		component: EditorTab,
		// exts 留空：editor 是 viewer 的兜底 kind（registry.viewerKindFor）
	},
	{
		kind: "image",
		get title() { return t("settings.sidecards.viewerImage"); },
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
