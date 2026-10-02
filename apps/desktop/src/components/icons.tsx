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
