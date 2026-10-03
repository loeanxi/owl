import { useT } from "../i18n/index.ts";
import { IconChat, IconMore, IconNews, IconSettings } from "./icons.tsx";
import "./navigation-design.css";

/** 主导航视图；设置作为覆盖页保留当前视图。 */
export type RailView = "chat" | "map" | "news" | "mail" | "evaluation";

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
	/** 切换主导航视图，保留各视图当前内容。 */
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

			<button type="button" className={itemClass(view === "news" && !settingsOpen)} title={t("rail.news")} aria-label={t("rail.news")} aria-current={view === "news" && !settingsOpen ? "page" : undefined} onClick={() => onSelect("news")}>
				<IconNews className="h-[18px] w-[18px]" />
			</button>

			<button
				type="button"
				className={itemClass(view === "map" && !settingsOpen)}
				title={t("rail.map")}
				aria-label={t("rail.map")}
				aria-current={view === "map" && !settingsOpen ? "page" : undefined}
				onClick={() => onSelect("map")}
			>
				<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
					<path d="M9 3v15M15 6v15" />
				</svg>
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
			<button
				type="button"
				className={itemClass(view === "mail" && !settingsOpen)}
				title={t("rail.mail")}
				aria-label={t("rail.mail")}
				aria-current={view === "mail" && !settingsOpen ? "page" : undefined}
				onClick={() => onSelect("mail")}
				data-fd-id="btn-mail-entry"
			>
				<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<rect x="3" y="5" width="18" height="14" rx="2" />
					<path d="m3 6 9 7 9-7" />
				</svg>
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
