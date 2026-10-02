/**
 * 快捷入口元数据 —— 对应 dsh-better-sidebar 的 buildNewTabOptions（开始页 /
 * 底部栏 / 工作台空态三处共用的同一份卡片清单）。彩色图标走固定色值（与
 * VSCode 文件图标同理，不随主题 token 变），排版照搬 DSH 开始页：实心橙
 * 文件夹、蓝终端、绿变动、蓝浏览器、琥珀任务、蓝侧聊。
 */
import type { ReactNode } from "react";
import { IconGitBranch } from "./icons.tsx";

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

export interface QuickAction {
	/** 工作台 tab kind（terminal / browser 目前只是占位卡，未注册 tab）。 */
	kind: string;
	label: string;
	color: string;
	icon: (size?: number) => ReactNode;
	/** 右侧快捷键提示（仅展示，见 App 的快捷键处理）。 */
	hint?: string;
	/** 占位卡：置灰不可点（owl 尚无终端/浏览器宿主能力）。 */
	disabled?: boolean;
}

export const QUICK_ACTIONS: QuickAction[] = [
	{ kind: "files", label: "文件", color: "#e0a33e", icon: (s) => <IconFolderSolid size={s} /> },
	{ kind: "terminal", label: "新建终端", color: "#4d9fd8", icon: (s) => <IconTerminal size={s} />, hint: "Ctrl + `", disabled: true },
	{ kind: "changes", label: "文件变动", color: "#41c463", icon: (s) => <IconGitBranch size={s} /> },
	{ kind: "browser", label: "浏览器", color: "#4d9fd8", icon: (s) => <IconGlobe size={s} />, hint: "Ctrl + T", disabled: true },
	{ kind: "tasks", label: "任务管理", color: "#d29922", icon: (s) => <IconLayers size={s} /> },
	{ kind: "sidechat", label: "侧边对话(beta)", color: "#549bf5", icon: (s) => <IconChatDiscussion size={s} /> },
];

/** 按 kind 取快捷入口（底部栏 / 开始页共用）。 */
export function quickActionOf(kind: string): QuickAction | undefined {
	return QUICK_ACTIONS.find((action) => action.kind === kind);
}
