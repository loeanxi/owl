import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/index.ts";
import { getProjectDisplayName, useProjectSidebarRevision } from "../project-sidebar-model.ts";
import { IconDownload, IconFolder, IconPanelBottom, IconPanelRight } from "../sidebar/icons.tsx";
import { Menu } from "./Menu.tsx";
import "./conversation-responsive.css";

export type ConversationView = "chat" | "context" | "trajectory";
export type SessionExportFormat = "jsonl" | "markdown";

const exportItemClass =
	"flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-owl-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

const VIEW_OPTIONS = ["chat", "context", "trajectory"] as const satisfies readonly ConversationView[];

/** Shared conversation chrome for ordinary and research sessions. */
export function ConversationHeader({ title, workspaceDir, presetName, view, onViewChange, terminalOpen, sidebarOpen, onToggleTerminal, onToggleSidebar, sessionId, exporting, onExport, onExportTurns, actions }: {
	title: string;
	workspaceDir: string;
	/** 当前会话的 Agent 预设名：顶栏标签，resume 一眼可辨本会话用的组合。 */
	presetName?: string;
	view: ConversationView;
	onViewChange: (view: ConversationView) => void;
	/** 终端底栏开合（独立于工具侧栏）。 */
	terminalOpen: boolean;
	/** 右侧工具侧栏开合。 */
	sidebarOpen: boolean;
	onToggleTerminal: () => void;
	onToggleSidebar: () => void;
	/** 当前会话；缺失（开始页）时不渲染导出入口。 */
	sessionId?: string;
	/** 导出请求进行中，菜单项暂时不可再点。 */
	exporting?: boolean;
	onExport: (format: SessionExportFormat) => void;
	/** 勾选历史分享：打开轮次勾选弹窗，确认后按所选轮次导出。 */
	onExportTurns: () => void;
	/** Panels may replace the default export and workbench controls with their own actions. */
	actions?: ReactNode;
}): React.JSX.Element {
	const t = useT();
	useProjectSidebarRevision();
	const viewLabels: Record<ConversationView, string> = {
		chat: t("app.viewChat"),
		context: t("app.viewContext"),
		trajectory: t("app.viewTrajectory"),
	};
	// 视图切换收进悬停小列表：默认只露出当前视图名，降低顶栏常驻按钮。
	const [viewMenuOpen, setViewMenuOpen] = useState(false);
	const viewMenuRootRef = useRef<HTMLDivElement>(null);
	const viewMenuCloseTimer = useRef<number | null>(null);

	useEffect(() => () => {
		if (viewMenuCloseTimer.current !== null) window.clearTimeout(viewMenuCloseTimer.current);
	}, []);

	useEffect(() => {
		if (!viewMenuOpen) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (!viewMenuRootRef.current?.contains(event.target as Node)) setViewMenuOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setViewMenuOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [viewMenuOpen]);

	const openViewMenu = (): void => {
		if (viewMenuCloseTimer.current !== null) {
			window.clearTimeout(viewMenuCloseTimer.current);
			viewMenuCloseTimer.current = null;
		}
		setViewMenuOpen(true);
	};
	const scheduleCloseViewMenu = (): void => {
		if (viewMenuCloseTimer.current !== null) window.clearTimeout(viewMenuCloseTimer.current);
		viewMenuCloseTimer.current = window.setTimeout(() => setViewMenuOpen(false), 150);
	};
	return <header className="owl-chat-header flex shrink-0 select-none items-center" data-tauri-drag-region="deep">
		<div className="owl-shell-header-info">
			<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text" title={title}>{title}</h1>
			{presetName && (
				<span className="owl-shell-preset-tag" title={presetName}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" /></svg>
					{presetName}
				</span>
			)}
			{/* 空目录 = 未选择对话目录（叉掉了 chip），此时不显示项目标签。 */}
			{workspaceDir !== "" && (
				<span className="owl-shell-project" title={workspaceDir}><IconFolder size={12} /><span className="owl-shell-project-label">{getProjectDisplayName(workspaceDir)}</span></span>
			)}
		</div>
		<div className="owl-view-tabs" aria-label={t("app.viewTabsAria")} data-tauri-drag-region="false" ref={viewMenuRootRef} onMouseEnter={openViewMenu} onMouseLeave={scheduleCloseViewMenu}>
			<button
				type="button"
				className={`owl-view-tabs-trigger${viewMenuOpen ? " is-open" : ""}`}
				title={t("app.viewSwitchTitle")}
				aria-haspopup="menu"
				aria-expanded={viewMenuOpen}
				onClick={() => setViewMenuOpen((value) => !value)}
			>
				{viewLabels[view]}
				<svg className="owl-view-tabs-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
			</button>
			{viewMenuOpen && (
				<div className="owl-view-tabs-popover" role="menu">
					{VIEW_OPTIONS.map((candidate) => (
						<button
							key={candidate}
							type="button"
							role="menuitemradio"
							aria-checked={candidate === view}
							className={candidate === view ? "is-current" : undefined}
							onClick={() => {
								setViewMenuOpen(false);
								onViewChange(candidate);
							}}
						>
							<span className="owl-view-tabs-label">{viewLabels[candidate]}</span>
							{candidate === view && (
								<svg className="owl-view-tabs-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5l3.5 3.5L13 5" /></svg>
							)}
						</button>
					))}
				</div>
			)}
		</div>
		<div className="owl-shell-header-actions" data-tauri-drag-region="false">
			{actions !== undefined ? actions : <>
			{sessionId && (
				<Menu
					direction="down"
					// 按钮贴窗口右缘，面板必须右对齐向左展开，否则小窗下会被窗口右边界裁掉
					panelClassName="right-0"
					triggerTitle={exporting ? t("app.exportingSession") : t("app.downloadSessionLog")}
					triggerClassName="owl-chrome-button"
					trigger={<span aria-busy={exporting}><IconDownload size={16} /></span>}
				>
					{(close) => (
						<div className="w-64">
							<button
								type="button"
								className={exportItemClass}
								disabled={exporting}
								title={t("app.exportSessionJsonl")}
								onClick={() => {
									close();
									onExport("jsonl");
								}}
							>
								<span>{t("app.exportSessionJsonl")}</span>
								<span className="text-[10px] text-owl-faint">{t("app.exportSessionJsonlHint")}</span>
							</button>
							<button
								type="button"
								className={exportItemClass}
								disabled={exporting}
								title={t("app.exportSessionMarkdown")}
								onClick={() => {
									close();
									onExport("markdown");
								}}
							>
								<span>{t("app.exportSessionMarkdown")}</span>
								<span className="text-[10px] text-owl-faint">{t("app.exportSessionMarkdownHint")}</span>
							</button>
							<button
								type="button"
								className={exportItemClass}
								disabled={exporting}
								title={t("app.exportSessionTurns")}
								onClick={() => {
									close();
									onExportTurns();
								}}
							>
								<span>{t("app.exportSessionTurns")}</span>
								<span className="text-[10px] text-owl-faint">{t("app.exportSessionTurnsHint")}</span>
							</button>
						</div>
					)}
				</Menu>
			)}
			<button type="button" title={t("app.dockBottomTitle")} aria-label={t("app.dockBottomTitle")} aria-pressed={terminalOpen} className={`owl-chrome-button${terminalOpen ? " is-active" : ""}`} onClick={onToggleTerminal}><IconPanelBottom size={16} /></button>
			<button type="button" title={t("app.dockRightTitle")} aria-label={t("app.dockRightTitle")} aria-pressed={sidebarOpen} className={`owl-chrome-button${sidebarOpen ? " is-active" : ""}`} onClick={onToggleSidebar}><IconPanelRight size={16} /></button>
			</>}
		</div>
	</header>;
}
