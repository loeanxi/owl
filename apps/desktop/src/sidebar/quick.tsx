/**
 * 快捷入口元数据 —— 对应 dsh-better-sidebar 的 buildNewTabOptions（开始页 /
 * 工作台空态两处共用的同一份卡片清单）。彩色图标走固定色值（与
 * VSCode 文件图标同理，不随主题 token 变），排版照搬 DSH 开始页：实心橙
 * 文件夹、蓝终端、绿变动、蓝浏览器、琥珀任务、蓝侧聊。
 */
import type { ReactNode } from "react";
import { t } from "../i18n/index.ts";
import { IconGitBranch } from "./icons.tsx";
import type { SidebarStore } from "./store.ts";
import { isTabKindEnabled } from "./config.ts";

interface IconProps {
	size?: number;
	className?: string;
}

function stroked(size: number | undefined, className: string | undefined, children: ReactNode): ReactNode {
	const s = size ?? 16;
	return (
		<svg
			width={s}
			height={s}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

/** 实心文件夹（开始页第一项，对照 DSH 的橙色 folder 艺术字）。 */
export const IconFolderSolid = (p: IconProps): ReactNode => {
	const s = p.size ?? 16;
	return (
		<svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" className={p.className} aria-hidden="true">
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		</svg>
	);
};

export const IconTerminal = (p: IconProps): ReactNode =>
	stroked(
		p.size,
		p.className,
		<>
			<path d="m4 17 6-6-6-6" />
			<path d="M12 19h8" />
		</>,
	);

export const IconGlobe = (p: IconProps): ReactNode =>
	stroked(
		p.size,
		p.className,
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
			<path d="M2 12h20" />
		</>,
	);

/** 叠层（任务管理，DSH 用 VscLayers 的同款隐喻：三层纸片）。 */
export const IconLayers = (p: IconProps): ReactNode =>
	stroked(
		p.size,
		p.className,
		<>
			<path d="M12 2 2 7l10 5 10-5-10-5Z" />
			<path d="m2 12 10 5 10-5" />
			<path d="m2 17 10 5 10-5" />
		</>,
	);

/** 双气泡（侧边对话，对应 VscCommentDiscussion）。 */
export const IconChatDiscussion = (p: IconProps): ReactNode =>
	stroked(
		p.size,
		p.className,
		<>
			<path d="M14 9a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1.7.7L6 18h6a2 2 0 0 0 2-2V9Z" />
			<path d="M9 9V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2" />
		</>,
	);

/** 人像+星（用户印象：助手对用户的长期记忆）。 */
export const IconUserStar = (p: IconProps): ReactNode =>
	stroked(
		p.size,
		p.className,
		<>
			<circle cx="10" cy="8" r="4" />
			<path d="M2 21c0-3.5 3.6-6 8-6 1.2 0 2.4.2 3.4.6" />
			<path d="m17.5 14.5 1.1 2.2 2.4.35-1.75 1.7.4 2.4-2.15-1.15-2.15 1.15.4-2.4-1.75-1.7 2.4-.35Z" />
		</>,
	);

export interface QuickAction {
	/** 工作台 tab kind。 */
	kind: string;
	label: string;
	color: string;
	icon: (size?: number) => ReactNode;
	/** 快捷键提示（App 里有对应的键盘处理）。 */
	hint?: string;
	/** 多实例 tab（终端 / 浏览器）：每次点击都开新的。tabTitle 是落成 tab 条上的短标题。 */
	multi?: boolean;
	tabTitle?: string;
	/** 占位卡：功能未实现时置灰。 */
	disabled?: boolean;
}

/**
 * label/tabTitle 用 getter 在「访问时」经 t() 解析：消费方（开始页/工作台/设置页）
 * 渲染期才读到当前语言，语言切换后无需改任何使用点。key 见 i18n/zh.ts 的 wb.*。
 */
export const QUICK_ACTIONS: QuickAction[] = [
	{ kind: "files", get label() { return t("dev.files"); }, color: "#e0a33e", icon: (s) => <IconFolderSolid size={s} /> },
	{ kind: "terminal", get label() { return t("wb.newTerminal"); }, color: "#4d9fd8", icon: (s) => <IconTerminal size={s} />, hint: "Ctrl + `", multi: true, get tabTitle() { return t("start.terminal"); } },
	{ kind: "changes", get label() { return t("dev.changes"); }, color: "#41c463", icon: (s) => <IconGitBranch size={s} /> },
	{ kind: "browser", get label() { return t("app.browserTab"); }, color: "#4d9fd8", icon: (s) => <IconGlobe size={s} />, hint: "Ctrl + T", multi: true },
	{ kind: "tasks", get label() { return t("wb.tasks"); }, color: "#d29922", icon: (s) => <IconLayers size={s} /> },
	{ kind: "impression", get label() { return t("wb.impression"); }, color: "#c77dff", icon: (s) => <IconUserStar size={s} /> },
	{ kind: "sidechat", get label() { return t("wb.sidechat"); }, color: "#549bf5", icon: (s) => <IconChatDiscussion size={s} /> },
];

/** 按 kind 取快捷入口（开始页 / 空态卡片共用）。 */
export function quickActionOf(kind: string): QuickAction | undefined {
	return QUICK_ACTIONS.find((action) => action.kind === kind);
}

/** 统一的快捷入口打开逻辑：单例去重，终端/浏览器每次开新的；侧边卡片设置停用的卡片直接忽略。 */
export function openQuickAction(store: SidebarStore, kind: string): void {
	const action = quickActionOf(kind);
	if (!action || action.disabled) return;
	if (!isTabKindEnabled(kind)) return;
	if (action.multi) store.openNew(kind, action.tabTitle ?? action.label);
	else store.openSingleton(kind, action.label);
}
