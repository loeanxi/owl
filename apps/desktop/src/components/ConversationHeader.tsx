import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/index.ts";
import { useProjectSidebarRevision } from "../project-sidebar-model.ts";
import { IconDownload, IconGitBranch, IconPanelBottom, IconPanelRight, IconPencil } from "../sidebar/icons.tsx";
import { IconChatDiscussion, IconDrama, IconLayers } from "../sidebar/quick.tsx";
import { Menu } from "./Menu.tsx";
import "./conversation-responsive.css";

export type ConversationView = "chat" | "context" | "trajectory";
export type SessionExportFormat = "jsonl" | "markdown";

const exportItemClass =
	"flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-owl-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

const VIEW_OPTIONS = ["chat", "context", "trajectory"] as const satisfies readonly ConversationView[];

/** 各视图的图标：触发钮只露当前视图图标，悬浮 title 出视图名。 */
const VIEW_ICONS: Record<ConversationView, (props: { size?: number }) => ReactNode> = {
	chat: IconChatDiscussion,
	context: IconLayers,
	trajectory: IconGitBranch,
};

/** Shared conversation chrome for ordinary and research sessions. */
export function ConversationHeader({ title, presetName, view, onViewChange, terminalOpen, sidebarOpen, onToggleTerminal, onToggleSidebar, mirrorOpen, onToggleMirror, sessionId, onRenameSession, renameDisabled, exporting, onExport, onExportTurns, actions }: {
	title: string;
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
	/** 短剧面板开合（机器级面板，跨项目/会话共用）。 */
	mirrorOpen?: boolean;
	onToggleMirror?: () => void;
	/** 当前会话；缺失（开始页）时不渲染导出入口。 */
	sessionId?: string;
	/** 悬停铅笔 → 行内重命名（App 负责调 session.rename 并刷新侧栏）；不传不出铅笔。 */
	onRenameSession?: (name: string) => void;
	renameDisabled?: boolean;
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
	const ViewIcon = VIEW_ICONS[view];
	// 视图切换收进图标菜单：触发钮只露当前视图图标（悬浮 title 出视图名），点击才展开列表。
	const [viewMenuOpen, setViewMenuOpen] = useState(false);
	const viewMenuRootRef = useRef<HTMLDivElement>(null);

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

	// 行内重命名：铅笔进入，Enter 提交 / Esc 取消；空名视为放弃。
	const [renaming, setRenaming] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	const renameInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (renaming) renameInputRef.current?.select();
	}, [renaming]);
	const startRename = (): void => {
		if (!onRenameSession || !sessionId) return;
		setRenameDraft(title);
		setRenaming(true);
	};
	const commitRename = (): void => {
		const next = renameDraft.trim();
		setRenaming(false);
		if (next && next !== title) onRenameSession?.(next);
	};
	return <header className="owl-chat-header flex shrink-0 select-none items-center" data-tauri-drag-region="deep">
		<div className="owl-shell-header-info">
			{renaming ? (
				<form
					className="owl-shell-rename flex items-center gap-1.5"
					onSubmit={(event) => { event.preventDefault(); commitRename(); }}
				>
					<input
						ref={renameInputRef}
						value={renameDraft}
						disabled={renameDisabled}
						aria-label={t("sidebar.renameAria")}
						className="owl-shell-rename-input h-6 w-56 rounded-md border border-owl-accent bg-owl-panel px-2 text-sm text-owl-text outline-none"
						onChange={(event) => setRenameDraft(event.target.value)}
						onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(false); } }}
						onBlur={() => commitRename()}
					/>
					<button type="submit" className="rounded-md px-1.5 py-0.5 text-xs text-owl-accent transition-colors hover:bg-owl-hover" disabled={renameDisabled}>{t("common.save")}</button>
				</form>
			) : (
				<h1 className="owl-shell-session-title group/title relative flex items-center gap-1 text-sm font-semibold text-owl-text" title={title}>
					<span className="min-w-0 max-w-[340px] truncate">{title}</span>
					{onRenameSession && sessionId && (
						<button
							type="button"
							className="owl-shell-rename-trigger shrink-0 rounded p-0.5 text-owl-faint opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
							title={t("sidebar.rename")}
							aria-label={t("sidebar.rename")}
							disabled={renameDisabled}
							onClick={startRename}
						>
							<IconPencil size={12} />
						</button>
					)}
				</h1>
			)}
			{presetName && (
				<span className="owl-shell-preset-tag" title={presetName}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" /></svg>
					{presetName}
				</span>
			)}
		</div>
		<div className="owl-view-tabs" aria-label={t("app.viewTabsAria")} data-tauri-drag-region="false" ref={viewMenuRootRef}>
			<button
				type="button"
				className={`owl-view-tabs-trigger${viewMenuOpen ? " is-open" : ""}`}
				title={viewLabels[view]}
				aria-label={viewLabels[view]}
				aria-haspopup="menu"
				aria-expanded={viewMenuOpen}
				onClick={() => setViewMenuOpen((value) => !value)}
			>
				<ViewIcon size={16} />
			</button>
			{viewMenuOpen && (
				<div className="owl-view-tabs-popover" role="menu">
					{VIEW_OPTIONS.map((candidate) => {
						const OptionIcon = VIEW_ICONS[candidate];
						return (
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
								<span className="owl-view-tabs-item">
									<OptionIcon size={14} />
									<span className="owl-view-tabs-label">{viewLabels[candidate]}</span>
								</span>
								{candidate === view && (
									<svg className="owl-view-tabs-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5l3.5 3.5L13 5" /></svg>
								)}
							</button>
						);
					})}
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
			{onToggleMirror !== undefined && (
				<button type="button" title={t("wb.drama")} aria-label={t("wb.drama")} aria-pressed={mirrorOpen === true} className={`owl-chrome-button${mirrorOpen ? " is-active" : ""}`} onClick={onToggleMirror}><IconDrama size={16} /></button>
			)}
			<button type="button" title={t("app.dockRightTitle")} aria-label={t("app.dockRightTitle")} aria-pressed={sidebarOpen} className={`owl-chrome-button${sidebarOpen ? " is-active" : ""}`} onClick={onToggleSidebar}><IconPanelRight size={16} /></button>
			</>}
		</div>
	</header>;
}
