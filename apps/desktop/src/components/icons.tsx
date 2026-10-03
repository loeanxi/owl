/**
 * 内联线性图标（24 viewBox，stroke = currentColor）。
 * 手写 path 参考 lucide（ISC 许可）风格，避免引入图标依赖。
 */
function Svg({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className ?? "h-4 w-4"}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

/** rail：聊天（主页） */
export function IconHome({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M3 10.5 12 3l9 7.5" />
			<path d="M5 9.5V21h14V9.5" />
			<path d="M9.5 21v-6h5v6" />
		</Svg>
	);
}

/** rail：项目 */
export function IconFolder({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		</Svg>
	);
}

/** rail：最近 */
export function IconClock({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3.5 2" />
		</Svg>
	);
}

/** rail：设置 */
export function IconSettings({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="3.2" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.02z" />
		</Svg>
	);
}

/** rail：更多（占位，后续挂新功能） */
export function IconMore({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
			<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
			<circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
		</Svg>
	);
}

/** 侧栏头部：搜索 */
export function IconSearch({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="11" cy="11" r="7" />
			<path d="m20.5 20.5-4.2-4.2" />
		</Svg>
	);
}

/** 侧栏头部：展开 / 收起会话列表 */
export function IconPanelLeft({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M9 4v16" />
		</Svg>
	);
}

/** 分组折叠指示：闭合时指右，展开时旋转向下 */
export function IconChevron({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="m9 18 6-6-6-6" />
		</Svg>
	);
}

/** 置顶图钉；filled 时实心表示已置顶 */
export function IconPin({
	className,
	filled = false,
}: {
	className?: string;
	filled?: boolean;
}): React.JSX.Element {
	return (
		<Svg className={className}>
			<path
				d="M12 17v5"
				style={filled ? { opacity: 0.45 } : undefined}
			/>
			<path
				d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
				fill={filled ? "currentColor" : "none"}
			/>
		</Svg>
	);
}

/** 会话行默认图标 */
export function IconChat({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.1-1L3 21l1.5-5.4A8.5 8.5 0 1 1 21 12z" />
		</Svg>
	);
}

/** 会话行操作：归档（收纳盒） */
export function IconArchive({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<rect width="20" height="5" x="2" y="3" rx="1" />
			<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
			<path d="M10 12h4" />
		</Svg>
	);
}

/** 会话行操作：取消归档（收纳盒 + 向上取出箭头），与「归档」图标区分开 */
export function IconUnarchive({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<rect width="20" height="5" x="2" y="3" rx="1" />
			<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
			<path d="m9 14 3-3 3 3" />
			<path d="M12 17v-6" />
		</Svg>
	);
}

/** 会话行操作：删除（垃圾桶） */
export function IconTrash({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M3 6h18" />
			<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
			<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
		</Svg>
	);
}

/** 分组菜单项右端的选中勾 */
export function IconCheck({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="m4.5 12.5 5 5 10-11" />
		</Svg>
	);
}

/** 分组头部快速操作：新建 */
export function IconPlus({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</Svg>
	);
}

/** 分组头部快速操作：新建聊天（笔形） */
export function IconCompose({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
			<path d="M18.2 2.8a2 2 0 0 1 2.9 2.9L13 13.8l-3.9 1 1-3.9z" />
		</Svg>
	);
}

/** 设置侧栏：模型与供应商（滑杆） */
export function IconSliders({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M21 5h-7M10 5H3" />
			<path d="M21 12h-9M8 12H3" />
			<path d="M21 19h-5M12 19H3" />
			<path d="M14 3v4M8 10v4M16 17v4" />
		</Svg>
	);
}

/** 设置侧栏：扩展与插件（插头） */
export function IconPlug({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M9 7V3M15 7V3" />
			<path d="M6 7h12v4a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z" />
			<path d="M12 16v5" />
		</Svg>
	);
}

/** 设置侧栏：外观（太阳） */
export function IconSun({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
		</Svg>
	);
}

/** 设置侧栏：settings.json（代码括号） */
export function IconCode({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="m16 18 6-6-6-6" />
			<path d="m8 6-6 6 6 6" />
		</Svg>
	);
}

/** 设置侧栏：关于（信息） */
export function IconInfo({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 8h.01M12 11.5V16" />
		</Svg>
	);
}

/** 聊天流节点：思考过程（灯泡） */
export function IconLightbulb({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M9 18h6" />
			<path d="M10 21h4" />
			<path d="M12 3a6 6 0 0 0-3.9 10.6c.6.5.9 1.2.9 2v.4h6v-.4c0-.8.3-1.5.9-2A6 6 0 0 0 12 3z" />
		</Svg>
	);
}

/** 聊天流节点：工具调用（终端提示符） */
export function IconTerminal({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="m5 6 6 6-6 6" />
			<path d="M13 18h7" />
		</Svg>
	);
}

/** 聊天流节点：出错（叹号圆片） */
export function IconAlert({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7.5V13" />
			<path d="M12 16.5h.01" />
		</Svg>
	);
}

/** 提问导航开关（列表） */
export function IconList({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<path d="M4 6.5h16" />
			<path d="M4 12h16" />
			<path d="M4 17.5h16" />
		</Svg>
	);
}

/** 设置页：图像生成（owl-image） */
export function IconImage({ className }: { className?: string }): React.JSX.Element {
	return (
		<Svg className={className}>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<path d="m21 15-5-5L5 21" />
		</Svg>
	);
}
