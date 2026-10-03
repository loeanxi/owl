import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../i18n/index.ts";
import { IconPanelLeft } from "./icons.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { useEvaluationText } from "../features/evaluation/evaluation-copy.ts";
import "./evaluation-entry.css";

type MenuKey = "file" | "edit" | "view" | "help";

interface MenuEntry {
	label: string;
	/** 右侧对齐的快捷键提示（如 "Ctrl+Shift+S"）。 */
	hint?: string;
	disabled?: boolean;
	/** 开关型条目的当前状态：定义了就渲染勾选列（true = 开启中，✓ + 强调色）。 */
	active?: boolean;
	action: () => void;
}

type MenuRow = MenuEntry | "separator";

interface DesktopTitlebarProps {
	connected: boolean;
	sidebarCollapsed: boolean;
	sidebarView?: "chat" | "map" | "news" | "mail" | "evaluation";
	sidebarToggleRef: RefObject<HTMLButtonElement | null>;
	workbenchOpen: boolean;
	workbenchDock: "right" | "bottom";
	fullscreen: boolean;
	onToggleSidebar: () => void;
	onNewChat: () => void;
	onOpenProject: () => void;
	onCloseWindow: () => void;
	onQuit: () => void;
	onOpenSettings: () => void;
	onOpenDeveloper: () => void;
	onToggleBottomPanel: () => void;
	onToggleRightPanel: () => void;
	onOpenTerminal: () => void;
	onOpenBrowserTab: () => void;
	onOpenTasks: () => void;
	onToggleChatContext: () => void;
	onPrevSession: () => void;
	onNextSession: () => void;
	onHistoryBack: () => void;
	onHistoryForward: () => void;
	onFind: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onZoomReset: () => void;
	onToggleFullscreen: () => void;
	onOpenGuide: () => void;
	onShowShortcuts: () => void;
	onOpenAbout: () => void;
	onOpenEvaluation: () => void;
}

/** 可编辑目标（含内层命中后的向上回溯）；CodeMirror 与内嵌浏览器自理键位，不归菜单管。 */
const EDITABLE_SELECTOR = "input, textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']";

function captureEditableTarget(): HTMLElement | null {
	const active = document.activeElement;
	if (!active) return null;
	if (active.closest(".cm-editor") || active.closest("[data-iab-capture]")) return null;
	const editable = active.closest(EDITABLE_SELECTOR);
	return editable instanceof HTMLElement ? editable : null;
}

/** Desktop chrome owns app actions; conversation controls stay in the frame below. */
export function DesktopTitlebar(props: DesktopTitlebarProps): React.JSX.Element {
	const t = useT();
	const evaluationText = useEvaluationText();
	const sidebarLabel = props.sidebarView === "mail"
		? props.sidebarCollapsed ? t("mail.showSidebar") : t("mail.hideSidebar")
		: props.sidebarView === "news"
		? t("news.navigation")
		: props.sidebarView === "map"
		? props.sidebarCollapsed ? t("titlebar.showMapSidebar") : t("titlebar.hideMapSidebar")
		: props.sidebarCollapsed ? t("titlebar.showSessions") : t("titlebar.hideSessions");
	const [menu, setMenu] = useState<MenuKey | undefined>();
	const [menuError, setMenuError] = useState("");
	const root = useRef<HTMLElement>(null);
	// 打开菜单那一刻焦点会移到触发按钮上；先把正在输入的可编辑元素记下来，
	// 编辑菜单项执行前把焦点还给它（execCommand 只作用于焦点元素）。
	const capturedEditableRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!menu) return;
		const dismiss = (event: PointerEvent): void => {
			if (!root.current?.contains(event.target as Node)) setMenu(undefined);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setMenu(undefined);
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const bottomOpen = props.workbenchOpen && props.workbenchDock === "bottom";
	const rightOpen = props.workbenchOpen && props.workbenchDock === "right";
	const editTarget = capturedEditableRef.current;
	const selectionText = window.getSelection()?.toString() ?? "";

	const runEditCommand = (command: string): void => {
		const el = capturedEditableRef.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		if (!document.execCommand(command)) setMenuError(t("titlebar.editUnsupported"));
	};

	const runCopy = (): void => {
		const selected = selectionText;
		if (selected) {
			void navigator.clipboard.writeText(selected).catch(() => setMenuError(t("titlebar.copyFailed")));
			return;
		}
		const el = capturedEditableRef.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		if (!document.execCommand("copy")) setMenuError(t("titlebar.copyFailed"));
	};

	const runPaste = (): void => {
		const el = capturedEditableRef.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		void navigator.clipboard
			.readText()
			.then((text) => {
				if (!text) return;
				if (!document.execCommand("insertText", false, text)) setMenuError(t("titlebar.pasteFailed"));
			})
			.catch(() => setMenuError(t("titlebar.pasteFailed")));
	};

	const runSelectAll = (): void => {
		const el = capturedEditableRef.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
		else if (!document.execCommand("selectAll")) setMenuError(t("titlebar.editUnsupported"));
	};

	// 菜单内 ↑/↓/Home/End 的选中导航：焦点在可用项之间循环（Enter 原生触发点击）。
	const moveMenuFocus = (panel: HTMLElement, step: number | "first" | "last"): void => {
		const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('button[role="menuitem"], button[role="menuitemcheckbox"]'))
			.filter((item) => !item.disabled);
		if (items.length === 0) return;
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = step === "first" ? 0
			: step === "last" ? items.length - 1
			: current === -1 ? (step > 0 ? 0 : items.length - 1)
			: (current + step + items.length) % items.length;
		items[next]?.focus();
	};

	const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined;
		if (step === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		moveMenuFocus(event.currentTarget, step);
	};

	const actions: Record<MenuKey, MenuRow[]> = {
		file: [
			{ label: t("titlebar.newChat"), hint: "Ctrl+N", disabled: !props.connected, action: props.onNewChat },
			{ label: t("titlebar.openProject"), hint: "Ctrl+O", disabled: !props.connected, action: props.onOpenProject },
			"separator",
			{ label: t("titlebar.closeWindow"), hint: "Ctrl+W", action: props.onCloseWindow },
			{ label: t("titlebar.quitOwl"), hint: "Ctrl+Q", action: props.onQuit },
		],
		edit: [
			{ label: t("edit.undo"), hint: "Ctrl+Z", disabled: !editTarget, action: () => runEditCommand("undo") },
			{ label: t("edit.redo"), hint: "Ctrl+Y", disabled: !editTarget, action: () => runEditCommand("redo") },
			"separator",
			{ label: t("edit.cut"), hint: "Ctrl+X", disabled: !editTarget, action: () => runEditCommand("cut") },
			{ label: t("edit.copy"), hint: "Ctrl+C", disabled: !editTarget && !selectionText, action: runCopy },
			{ label: t("edit.paste"), hint: "Ctrl+V", disabled: !editTarget, action: runPaste },
			{ label: t("edit.delete"), hint: "Delete", disabled: !editTarget, action: () => runEditCommand("delete") },
			"separator",
			{ label: t("edit.selectAll"), hint: "Ctrl+A", disabled: !editTarget, action: runSelectAll },
			{ label: t("titlebar.settings"), hint: "Ctrl+,", action: props.onOpenSettings },
		],
		view: [
			{ label: sidebarLabel, hint: "Ctrl+Shift+S", active: !props.sidebarCollapsed, action: props.onToggleSidebar },
			{ label: bottomOpen ? t("view.hideBottomPanel") : t("view.showBottomPanel"), hint: "Ctrl+J", active: bottomOpen, action: props.onToggleBottomPanel },
			{ label: rightOpen ? t("view.hideRightPanel") : t("view.showRightPanel"), hint: "Ctrl+Shift+E", active: rightOpen, action: props.onToggleRightPanel },
			{ label: t("titlebar.openDeveloperWorkbench"), action: props.onOpenDeveloper },
			"separator",
			{ label: t("wb.newTerminal"), hint: "Ctrl+`", action: props.onOpenTerminal },
			{ label: t("app.browserTab"), hint: "Ctrl+T", action: props.onOpenBrowserTab },
			{ label: t("view.toggleChatContext"), hint: "Alt+Ctrl+B", action: props.onToggleChatContext },
			"separator",
			{ label: t("view.find"), hint: "Ctrl+F", action: props.onFind },
			{ label: t("view.prevSession"), hint: "Ctrl+Shift+[", disabled: !props.connected, action: props.onPrevSession },
			{ label: t("view.nextSession"), hint: "Ctrl+Shift+]", disabled: !props.connected, action: props.onNextSession },
			{ label: t("view.back"), hint: "Ctrl+[", action: props.onHistoryBack },
			{ label: t("view.forward"), hint: "Ctrl+]", action: props.onHistoryForward },
			"separator",
			{ label: t("view.zoomIn"), hint: "Ctrl+Shift+=", action: props.onZoomIn },
			{ label: t("view.zoomOut"), hint: "Ctrl+-", action: props.onZoomOut },
			{ label: t("view.zoomReset"), hint: "Ctrl+0", action: props.onZoomReset },
			"separator",
			{ label: t("view.toggleFullscreen"), hint: "F11", active: props.fullscreen, action: props.onToggleFullscreen },
		],
		help: [
			{ label: t("help.guide"), action: props.onOpenGuide },
			{ label: t("help.shortcuts"), hint: "Ctrl+/", action: props.onShowShortcuts },
			{ label: t("help.taskManager"), action: props.onOpenTasks },
			"separator",
			{ label: t("titlebar.aboutOwl"), action: props.onOpenAbout },
		],
	};

	return (
		<header className="owl-desktop-titlebar" ref={root} data-tauri-drag-region="deep">
			<div className="owl-desktop-menu-row" data-tauri-drag-region="false">
				<button
					ref={props.sidebarToggleRef}
					type="button"
					className="owl-chrome-button owl-desktop-sidebar-toggle"
					aria-label={sidebarLabel}
					title={sidebarLabel}
					aria-expanded={!props.sidebarCollapsed}
					aria-controls={props.sidebarView === "mail" ? "owl-mail-sidebar" : props.sidebarView === "news" ? "owl-news-sidebar" : props.sidebarView === "map" ? "owl-map-sidebar" : "owl-session-sidebar"}
					onClick={props.onToggleSidebar}
				>
					<IconPanelLeft className="h-4 w-4" />
				</button>
				{([['file', 'titlebar.menuFile'], ['edit', 'titlebar.menuEdit'], ['view', 'titlebar.menuView'], ['help', 'titlebar.menuHelp']] as const).map(([key, labelKey]) => (
					<div className="owl-desktop-menu" key={key}>
						<button
							type="button"
							className={`owl-desktop-menu-trigger${menu === key ? " is-open" : ""}`}
							aria-haspopup="menu"
							aria-expanded={menu === key}
							aria-controls={`owl-desktop-menu-${key}`}
							onPointerDown={() => {
								// pointerdown 先于按钮抢焦点，此时 activeElement 还是用户正在输入的元素
								capturedEditableRef.current = captureEditableTarget();
							}}
							onKeyDown={(event) => {
								// 键盘用户：↓ 直接展开并选中第一项（鼠标用户保持原样，不抢焦点）
								if (event.key === "ArrowDown" && menu !== key) {
									event.preventDefault();
									capturedEditableRef.current = captureEditableTarget();
									setMenuError("");
									setMenu(key);
									requestAnimationFrame(() => {
										const panel = document.getElementById(`owl-desktop-menu-${key}`);
										if (panel) moveMenuFocus(panel, "first");
									});
								}
							}}
							onClick={() => {
								setMenuError("");
								setMenu((current) => current === key ? undefined : key);
							}}
						>
							{t(labelKey)}
						</button>
						{menu === key && (
							<div className="owl-desktop-menu-panel" role="menu" id={`owl-desktop-menu-${key}`} aria-label={t(labelKey)} onKeyDown={onMenuKeyDown}>
								{actions[key].map((row, index) => (
									row === "separator" ? (
										<div className="owl-desktop-menu-separator" key={`sep-${index}`} role="separator" />
									) : (
										<button
											key={row.label}
											type="button"
											role={row.active !== undefined ? "menuitemcheckbox" : "menuitem"}
											aria-checked={row.active !== undefined ? Boolean(row.active) : undefined}
											className={row.active ? "is-active" : undefined}
											disabled={row.disabled}
											onClick={() => {
												setMenu(undefined);
												row.action();
											}}
										>
											<span className="owl-desktop-menu-left">
												{row.active !== undefined && (
													<span className="owl-desktop-menu-check" aria-hidden="true">{row.active ? "✓" : ""}</span>
												)}
												<span className="owl-desktop-menu-label">{row.label}</span>
											</span>
											{row.hint && <span className="owl-desktop-menu-hint">{row.hint}</span>}
										</button>
									)
								))}
							</div>
						)}
					</div>
				))}
				<button
					type="button"
					className={`owl-desktop-menu-trigger owl-desktop-evaluation-entry${props.sidebarView === "evaluation" ? " is-active" : ""}`}
					aria-pressed={props.sidebarView === "evaluation"}
					data-fd-id="model-evaluation-entry"
					onClick={() => { setMenu(undefined); props.onOpenEvaluation(); }}
				>
					{evaluationText("title")}
				</button>
			</div>
			<span className="owl-desktop-app-name" data-tauri-drag-region="deep">OWL</span>
			{menuError && <span className="owl-desktop-copy-error" role="status">{menuError}</span>}
			<div className="owl-desktop-window-controls" data-tauri-drag-region="false">
				<WindowControls />
			</div>
		</header>
	);
}
