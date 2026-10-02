/**
 * 侧边栏工作台的内联 SVG 图标（16px、currentColor 描边，lucide 风格手绘）。
 * 与组件同源维护，不引入 react-icons 依赖。
 */
import type { ReactNode } from "react";

interface IconProps {
	size?: number;
	className?: string;
}

function base(size: number | undefined, className: string | undefined, children: ReactNode): ReactNode {
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

export const IconChevronRight = (p: IconProps): ReactNode =>
	base(p.size, p.className, <path d="m9 18 6-6-6-6" />);
export const IconChevronDown = (p: IconProps): ReactNode =>
	base(p.size, p.className, <path d="m6 9 6 6 6-6" />);
export const IconFolder = (p: IconProps): ReactNode =>
	base(p.size, p.className, <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />);
export const IconFolderOpen = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
		</>
	));
export const IconFile = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		</>
	));
export const IconX = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	));
export const IconSearch = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</>
	));
export const IconGitBranch = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<line x1="6" x2="6" y1="3" y2="15" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</>
	));
export const IconSave = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
			<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
			<path d="M7 3v4a1 1 0 0 0 1 1h7" />
		</>
	));
export const IconRefresh = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
			<path d="M21 3v5h-5" />
			<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
			<path d="M8 16H3v5" />
		</>
	));
export const IconFolderPlus = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
			<line x1="12" x2="12" y1="10" y2="16" />
			<line x1="9" x2="15" y1="13" y2="13" />
		</>
	));
export const IconTrash = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M3 6h18" />
			<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
			<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
		</>
	));
export const IconPencil = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		</>
	));
export const IconExternal = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</>
	));
export const IconCopy = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<rect width="14" height="14" x="8" y="8" rx="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</>
	));
export const IconImage = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
		</>
	));
export const IconPanelRight = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M15 3v18" />
		</>
	));
export const IconLoader = (p: IconProps): ReactNode =>
	base(p.size, p.className, <path d="M21 12a9 9 0 1 1-6.219-8.56" />);
export const IconUndo = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M3 7v6h6" />
			<path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
		</>
	));
export const IconPlus = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</>
	));
/** 底部停靠面板（DSH 的 bottom-toggle 同款：圆角矩形 + 底部实心条）。 */
export const IconPanelBottom = (p: IconProps): ReactNode =>
	base(p.size, p.className, (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="M3 15.5h18" strokeWidth="2.6" />
		</>
	));
