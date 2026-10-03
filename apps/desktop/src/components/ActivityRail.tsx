import { useT } from "../i18n/index.ts";
import { IconChat, IconMore, IconSettings } from "./icons.tsx";
import "./navigation-design.css";

/** rail 当前高亮项。目前只有聊天视图；后续新功能再加枚举。 */
export type RailView = "chat";

/**
 * 最左侧图标栏（Codex 式 activity bar）。
 * 结构刻意做成纯配置驱动：加功能 = 在 items 里加一项 + 接一个 onSelect 分支。
 */
export function ActivityRail({
	view,
	settingsOpen = false,
	onSelect,
	onOpenSettings,
}: {
	view: RailView;
	settingsOpen?: boolean;
	/** 点击 rail 图标：回到聊天视图。 */
	onSelect: (view: RailView) => void;
	onOpenSettings: () => void;
}): React.JSX.Element {
	const t = useT();
	const itemClass = (active: boolean): string => `owl-rail-button${active ? " is-active" : ""}`;

	return (
		<nav className="owl-activity-rail" data-tauri-drag-region="deep" aria-label={t("rail.aria")}>
			<button
				type="button"
				className="owl-rail-brand"
				title={t("rail.owlSessionsTitle")}
				aria-label={t("rail.owlSessions")}
				onClick={() => onSelect("chat")}
			>
				<img src="/owl.svg" alt="" className="h-6 w-6" draggable={false} />
			</button>

			<button
				type="button"
				className={itemClass(view === "chat" && !settingsOpen)}
				title={t("rail.chat")}
				aria-label={t("rail.chat")}
				aria-current={view === "chat" && !settingsOpen ? "page" : undefined}
				onClick={() => onSelect("chat")}
			>
				<IconChat className="h-[18px] w-[18px]" />
			</button>

			<button
				type="button"
				className={itemClass(settingsOpen)}
				title={t("rail.settings")}
				aria-label={t("rail.settings")}
				aria-current={settingsOpen ? "page" : undefined}
				onClick={onOpenSettings}
			>
				<IconSettings className="h-[18px] w-[18px]" />
			</button>
			<button type="button" className={itemClass(false)} title={t("rail.more")} aria-label={t("rail.more")} disabled>
				<IconMore className="h-[18px] w-[18px]" />
			</button>

			{/* 底部：owl 头像位。先复用为设置入口，后续可挂账号/状态菜单。 */}
			<button
				type="button"
				className="owl-rail-avatar"
				title="owl"
				aria-label={t("rail.owlSettings")}
				onClick={onOpenSettings}
			>
				<img src="/owl.svg" alt="owl" className="h-4.5 w-4.5" draggable={false} />
			</button>
		</nav>
	);
}
