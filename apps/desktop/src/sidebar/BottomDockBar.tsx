/**
 * 底部栏目 —— 对照 DSH 会话底部的快捷卡片条：文件 / 文件变动 / 任务管理 /
 * 侧边对话(beta) + 右侧收起按钮。点卡片把对应单例打开到工作台（停靠位置跟随
 * 当前的 dock 设置，默认底部），面板打开时高亮激活项。整条可用 X 收起
 * （owl.dock.visible 持久化，顶栏的底部面板按钮随时唤回）。
 */
import type { SidebarStore } from "./store.ts";
import { useSidebarState } from "./store.ts";
import { QUICK_ACTIONS } from "./quick.tsx";
import { IconX } from "./icons.tsx";

export function BottomDockBar({
	store,
	panelOpen,
	onOpenKind,
	onHide,
}: {
	store: SidebarStore;
	/** 工作台面板当前是否展开（展开时卡片反映激活 tab）。 */
	panelOpen: boolean;
	onOpenKind: (kind: string) => void;
	onHide: () => void;
}): React.JSX.Element {
	const state = useSidebarState(store);
	const activeKind = state.tabs.find((tab) => tab.id === state.activeId)?.kind;

	return (
		<div className="flex shrink-0 select-none items-center gap-2 border-t border-owl-border/60 bg-owl-rail/70 px-3 py-2" data-tauri-drag-region="deep">
			{QUICK_ACTIONS.filter((action) => !action.disabled && !action.multi).map((action) => {
				const opened = state.tabs.some((tab) => tab.kind === action.kind);
				const active = panelOpen && opened && activeKind === action.kind;
				return (
					<button
						key={action.kind}
						type="button"
						title={action.label}
						className={`flex h-10 min-w-0 flex-1 basis-0 items-center justify-center gap-2 rounded-xl border px-3 text-sm transition-colors sm:flex-none ${
							active
								? "border-owl-accent/60 bg-owl-accent/10 text-owl-text"
								: "border-owl-border/70 bg-owl-panel text-owl-muted hover:bg-owl-hover hover:text-owl-text"
						}`}
						onClick={() => onOpenKind(action.kind)}
					>
						<span className="shrink-0" style={{ color: action.color }}>
							{action.icon(16)}
						</span>
						<span className="truncate">{action.label}</span>
					</button>
				);
			})}
			<div className="flex-1" data-tauri-drag-region="deep" />
			<button
				type="button"
				title="收起底部栏"
				aria-label="收起底部栏"
				className="shrink-0 rounded-md p-1.5 text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
				onClick={onHide}
			>
				<IconX size={14} />
			</button>
		</div>
	);
}
