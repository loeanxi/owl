import { useT } from "../i18n/index.ts";
import { getProjectDisplayName, useProjectSidebarRevision } from "../project-sidebar-model.ts";
import { IconFolder, IconPanelBottom, IconPanelRight } from "../sidebar/icons.tsx";
import type { WorkbenchDock } from "../sidebar/Workbench.tsx";

export type ConversationView = "chat" | "context";

/** Shared conversation chrome for ordinary and research sessions. */
export function ConversationHeader({ title, workspaceDir, connected, everConnected, view, onViewChange, workbenchOpen, workbenchDock, onToggleDock }: {
	title: string;
	workspaceDir: string;
	connected: boolean;
	everConnected: boolean;
	view: ConversationView;
	onViewChange: (view: ConversationView) => void;
	workbenchOpen: boolean;
	workbenchDock: WorkbenchDock;
	onToggleDock: (dock: WorkbenchDock) => void;
}): React.JSX.Element {
	const t = useT();
	useProjectSidebarRevision();
	const buttonClass = (dock: WorkbenchDock): string => `owl-chrome-button${workbenchOpen && workbenchDock === dock ? " is-active" : ""}`;
	return <header className="owl-chat-header flex shrink-0 select-none items-center" data-tauri-drag-region="deep">
		<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text" title={title}>{title}</h1>
		<span className="owl-shell-project" title={workspaceDir}><IconFolder size={12} /><span className="owl-shell-project-label">{getProjectDisplayName(workspaceDir)}</span></span>
		<div className="owl-view-tabs" role="tablist" aria-label={t("app.viewTabsAria")} data-tauri-drag-region="false">
			<button type="button" role="tab" aria-selected={view === "chat"} title={t("app.viewChat")} onClick={() => onViewChange("chat")}>{t("app.viewChat")}</button>
			<button type="button" role="tab" aria-selected={view === "context"} title={t("composer.context")} onClick={() => onViewChange("context")}>{t("composer.context")}</button>
		</div>
		<div className="owl-shell-header-actions" data-tauri-drag-region="false">
			<span className={"owl-shell-connection" + (connected ? "" : " is-offline")} role="status" title={connected ? t("composer.connected") : t("app.connectionOffline")}>
				<span className="owl-shell-connection-dot" />{connected ? t("composer.runLocation.local") : everConnected ? t("app.reconnecting") : t("app.connecting")}
			</span>
			<button type="button" title={t("app.dockBottomTitle")} aria-label={t("app.dockBottomTitle")} aria-pressed={workbenchOpen && workbenchDock === "bottom"} className={buttonClass("bottom")} onClick={() => onToggleDock("bottom")}><IconPanelBottom size={16} /></button>
			<button type="button" title={t("app.dockRightTitle")} aria-label={t("app.dockRightTitle")} aria-pressed={workbenchOpen && workbenchDock === "right"} className={buttonClass("right")} onClick={() => onToggleDock("right")}><IconPanelRight size={16} /></button>
		</div>
	</header>;
}
