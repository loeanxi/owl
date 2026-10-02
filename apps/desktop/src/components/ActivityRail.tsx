import { IconClock, IconFolder, IconHome, IconMore, IconSettings } from "./icons.tsx";

/** rail 当前高亮项。聊天是默认视图；其余对应侧栏分组，后续新功能再加枚举。 */
export type RailView = "chat" | "projects" | "recent";

/**
 * 最左侧图标栏（Codex 式 activity bar）。
 * 结构刻意做成纯配置驱动：加功能 = 在 items 里加一项 + 接一个 onSelect 分支。
 */
export function ActivityRail({
	view,
	onSelect,
	onOpenSettings,
}: {
	view: RailView;
	/** 点击 rail 图标：聊天回到会话视图，项目/最近定位到侧栏对应分组。 */
	onSelect: (view: RailView) => void;
	onOpenSettings: () => void;
}): React.JSX.Element {
	const itemClass = (active: boolean): string =>
		`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
			active ? "bg-owl-hover text-owl-text" : "text-owl-faint hover:bg-owl-hover/60 hover:text-owl-text"
		}`;

	return (
		<nav
			className="flex w-[52px] shrink-0 select-none flex-col items-center gap-1 border-r border-owl-border bg-owl-rail py-3"
			data-tauri-drag-region="deep"
			aria-label="主导航"
		>
			<button type="button" className={itemClass(view === "chat")} title="聊天" onClick={() => onSelect("chat")}>
				<IconHome className="h-[18px] w-[18px]" />
			</button>
			<button
				type="button"
				className={itemClass(view === "projects")}
				title="项目"
				onClick={() => onSelect("projects")}
			>
				<IconFolder className="h-[18px] w-[18px]" />
			</button>
			<button
				type="button"
				className={itemClass(view === "recent")}
				title="最近"
				onClick={() => onSelect("recent")}
			>
				<IconClock className="h-[18px] w-[18px]" />
			</button>

			<div className="my-1.5 h-px w-6 bg-owl-border" />

			<button
				type="button"
				className={itemClass(false)}
				title="设置"
				onClick={onOpenSettings}
			>
				<IconSettings className="h-[18px] w-[18px]" />
			</button>
			<button type="button" className={`${itemClass(false)} opacity-40`} title="更多功能开发中" disabled>
				<IconMore className="h-[18px] w-[18px]" />
			</button>

			{/* 底部：owl 头像位。先复用为设置入口，后续可挂账号/状态菜单。 */}
			<button
				type="button"
				className="mt-auto flex h-8 w-8 items-center justify-center rounded-full border border-owl-border bg-owl-panel transition-colors hover:border-owl-faint"
				title="owl"
				onClick={onOpenSettings}
			>
				<img src="/owl.svg" alt="owl" className="h-4.5 w-4.5" draggable={false} />
			</button>
		</nav>
	);
}
