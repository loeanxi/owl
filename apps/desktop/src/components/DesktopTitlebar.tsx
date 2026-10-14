import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../i18n/index.ts";
import { IconMore, IconNavBack, IconNavForward, IconPanelLeft, IconPool, IconStickFigure, IconTokenCareer } from "./icons.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { useEvaluationText } from "../features/evaluation/evaluation-copy.ts";
import { useResearchEntryText } from "../features/research/research-entry-copy.ts";
import "./evaluation-entry.css";
import "./titlebar-responsive.css";

type MenuKey = "file" | "edit" | "view" | "help";
type OpenMenuKey = MenuKey | "more";

const MENU_LABELS = [["file", "titlebar.menuFile"], ["edit", "titlebar.menuEdit"], ["view", "titlebar.menuView"], ["help", "titlebar.menuHelp"]] as const;

interface MenuEntry {
	label: string;
	/** 右侧对齐的快捷键提示（如 "Ctrl+Shift+S"）。 */
	hint?: string;
	submenu?: MenuKey;
	disabled?: boolean;
	/** 开关型条目的当前状态：定义了就渲染勾选列（true = 开启中，✓ + 强调色）。 */
	active?: boolean;
	action: () => void;
}

type MenuRow = MenuEntry | "separator";

interface DesktopTitlebarProps {
	connected: boolean;
	sidebarCollapsed: boolean;
	sidebarView?: "manager" | "chat" | "map" | "news" | "mail" | "evaluation" | "projects" | "research" | "guide" | "myself" | "expert" | "market" | "career" | "automation" | "bagu" | "account";
	sidebarToggleRef: RefObject<HTMLButtonElement | null>;
	terminalOpen: boolean;
	sidebarOpen: boolean;
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
	onOpenIsland: () => void;
	onHistoryBack: () => void;
	onHistoryForward: () => void;
	canHistoryBack: boolean;
	canHistoryForward: boolean;
	onFind: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onZoomReset: () => void;
	onToggleFullscreen: () => void;
	onOpenGuide: () => void;
	onShowShortcuts: () => void;
	onOpenAbout: () => void;
	onOpenEvaluation: () => void;
	onOpenResearch: () => void;
	onOpenLifeGuide: () => void;
	onOpenTokenCareer: () => void;
	onOpenManager: () => void;
	/** 设置 →「诊断」。标题栏只在有异常（lifeCount > 0）时露出入口。 */
	onOpenDiagnostics: () => void;
	lifeDot: "ok" | "bad" | "warn" | "idle";
	lifeCount: number;
	island?: React.ReactNode;
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
	const researchTitle = useResearchEntryText();
	const [sessionDrawer, setSessionDrawer] = useState({ enabled: false, open: false });
	const sidebarCollapsed = sessionDrawer.enabled ? !sessionDrawer.open : props.sidebarCollapsed;
	const sidebarLabel = props.sidebarView === "evaluation"
		? evaluationText("title")
		: props.sidebarView === "mail"
		? sidebarCollapsed ? t("mail.showSidebar") : t("mail.hideSidebar")
		: props.sidebarView === "news"
		? t(sidebarCollapsed ? "news.showNavigation" : "news.hideNavigation")
		: props.sidebarView === "map"
		? sidebarCollapsed ? t("titlebar.showMapSidebar") : t("titlebar.hideMapSidebar")
		: sidebarCollapsed ? t("titlebar.showSessions") : t("titlebar.hideSessions");
	const [menu, setMenu] = useState<OpenMenuKey | undefined>();
	const [compactMenus, setCompactMenus] = useState(() => window.matchMedia("(max-width: 899px)").matches);
	const [menuError, setMenuError] = useState("");
	const root = useRef<HTMLElement>(null);
	const menuTrigger = useRef<HTMLButtonElement | null>(null);
	// 打开菜单那一刻焦点会移到触发按钮上；先把正在输入的可编辑元素记下来，
	// 编辑菜单项执行前把焦点还给它（execCommand 只作用于焦点元素）。
	const capturedEditableRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const update = (event: Event): void => {
			const state = (event as CustomEvent<{ enabled: boolean; open: boolean }>).detail;
			if (state && typeof state.enabled === "boolean" && typeof state.open === "boolean") setSessionDrawer(state);
		};
		window.addEventListener("owl:session-drawer-state", update);
		return () => window.removeEventListener("owl:session-drawer-state", update);
	}, []);

	useEffect(() => {
		const compact = window.matchMedia("(max-width: 899px)");
		const overflow = window.matchMedia("(max-width: 1239px)");
		const update = (): void => {
			setCompactMenus(compact.matches);
			setMenu(undefined);
		};
		compact.addEventListener("change", update);
		overflow.addEventListener("change", update);
		return () => {
			compact.removeEventListener("change", update);
			overflow.removeEventListener("change", update);
		};
	}, []);

	useEffect(() => {
		if (!menu) return;
		const dismiss = (event: PointerEvent): void => {
			if (!root.current?.contains(event.target as Node)) setMenu(undefined);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setMenu(undefined);
				menuTrigger.current?.focus({ preventScroll: true });
			}
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const bottomOpen = props.terminalOpen;
	const rightOpen = props.sidebarOpen;
	const editTarget = capturedEditableRef.current;
	const selectionText = window.getSelection()?.toString() ?? "";
	const toggleSidebar = (): void => {
		if (!window.dispatchEvent(new Event("owl:toggle-session-drawer", { cancelable: true }))) return;
		props.onToggleSidebar();
	};

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
		if (event.key === "ArrowLeft" && compactMenus && menu !== "more") {
			event.preventDefault();
			setMenu("more");
			requestAnimationFrame(() => {
				const panel = document.getElementById("owl-desktop-menu-more");
				if (panel) moveMenuFocus(panel, "first");
			});
			return;
		}
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
			{ label: sidebarLabel, hint: "Ctrl+Shift+S", active: !sidebarCollapsed, action: toggleSidebar },
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
			{ label: t("view.openIsland"), hint: "Ctrl+.", action: props.onOpenIsland },
			{ label: t("view.back"), hint: "Ctrl+[", disabled: !props.canHistoryBack, action: props.onHistoryBack },
			{ label: t("view.forward"), hint: "Ctrl+]", disabled: !props.canHistoryForward, action: props.onHistoryForward },
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
	const menuLabels: Record<OpenMenuKey, string> = {
		file: t("titlebar.menuFile"),
		edit: t("titlebar.menuEdit"),
		view: t("titlebar.menuView"),
		help: t("titlebar.menuHelp"),
		more: t("rail.more"),
	};
	const overflowActions: MenuRow[] = [
		...(compactMenus ? [
			...MENU_LABELS.map(([key, labelKey]) => ({ label: t(labelKey), submenu: key, action: () => {
				setMenu(key);
				requestAnimationFrame(() => {
					const panel = document.getElementById(`owl-desktop-menu-${key}`);
					if (panel) moveMenuFocus(panel, "first");
				});
			} })),
			"separator" as const,
		] : []),
		{ label: evaluationText("title"), active: props.sidebarView === "evaluation", action: props.onOpenEvaluation },
		{ label: researchTitle, active: props.sidebarView === "research", action: props.onOpenResearch },
		"separator",
		{ label: "号池 Manager", active: props.sidebarView === "manager", action: props.onOpenManager },
		{ label: t("titlebar.tokenCareer"), active: props.sidebarView === "career", action: props.onOpenTokenCareer },
		{ label: t("titlebar.lifeGuide"), active: props.sidebarView === "guide", action: props.onOpenLifeGuide },
	];
	const renderMenuPanel = (key: OpenMenuKey): React.JSX.Element => (
		<div className="owl-desktop-menu-panel" role="menu" id={`owl-desktop-menu-${key}`} aria-label={menuLabels[key]} onKeyDown={onMenuKeyDown}>
			{compactMenus && key !== "more" && (
				<div className="owl-desktop-compact-menu-heading">
					<button type="button" role="menuitem" onClick={() => {
						setMenu("more");
						requestAnimationFrame(() => {
							const panel = document.getElementById("owl-desktop-menu-more");
							if (panel) moveMenuFocus(panel, "first");
						});
					}}><IconNavBack /><span>{t("rail.more")}</span></button>
					<span>{menuLabels[key]}</span>
				</div>
			)}
			{(key === "more" ? overflowActions : actions[key]).map((row, index) => (
				row === "separator" ? (
					<div className="owl-desktop-menu-separator" key={`sep-${index}`} role="separator" />
				) : (
					<button
						key={row.label}
						type="button"
						role={row.active !== undefined ? "menuitemcheckbox" : "menuitem"}
						aria-checked={row.active !== undefined ? Boolean(row.active) : undefined}
						aria-haspopup={row.submenu ? "menu" : undefined}
						className={row.active ? "is-active" : undefined}
						disabled={row.disabled}
						onKeyDown={(event) => {
							if (event.key === "ArrowRight" && row.submenu) {
								event.preventDefault();
								row.action();
							}
						}}
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
						{row.hint ? <span className="owl-desktop-menu-hint">{row.hint}</span> : row.submenu ? <IconNavForward /> : null}
					</button>
				)
			))}
		</div>
	);

	return (
		<header className="owl-desktop-titlebar owl-desktop-titlebar-responsive" ref={root} data-tauri-drag-region="deep">
				{props.island}
				<div className="owl-desktop-menu-row" data-tauri-drag-region="false">
				<button
					ref={props.sidebarToggleRef}
					type="button"
					className="owl-chrome-button owl-desktop-sidebar-toggle"
					aria-label={sidebarLabel}
					title={sidebarLabel}
					aria-expanded={!sidebarCollapsed}
					aria-controls={props.sidebarView === "evaluation" ? "owl-evaluation-sidebar" : props.sidebarView === "mail" ? "owl-mail-sidebar" : props.sidebarView === "news" ? "owl-news-sidebar" : props.sidebarView === "map" ? "owl-map-sidebar" : "owl-session-sidebar"}
					onClick={toggleSidebar}
				>
					<IconPanelLeft className="h-4 w-4" />
				</button>
				<div className="owl-desktop-history-nav">
					<button
						type="button"
						className="owl-chrome-button"
						aria-label={t("view.back")}
						title={`${t("view.back")} (Ctrl+[)`}
						disabled={!props.canHistoryBack}
						onClick={props.onHistoryBack}
					>
						<IconNavBack className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="owl-chrome-button"
						aria-label={t("view.forward")}
						title={`${t("view.forward")} (Ctrl+])`}
						disabled={!props.canHistoryForward}
						onClick={props.onHistoryForward}
					>
						<IconNavForward className="h-4 w-4" />
					</button>
				</div>
				{!compactMenus && MENU_LABELS.map(([key, labelKey]) => (
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
									menuTrigger.current = event.currentTarget;
									capturedEditableRef.current = captureEditableTarget();
									setMenuError("");
									setMenu(key);
									requestAnimationFrame(() => {
										const panel = document.getElementById(`owl-desktop-menu-${key}`);
										if (panel) moveMenuFocus(panel, "first");
									});
								}
							}}
							onClick={(event) => {
								menuTrigger.current = event.currentTarget;
								setMenuError("");
								setMenu((current) => current === key ? undefined : key);
							}}
						>
							{t(labelKey)}
						</button>
						{menu === key && renderMenuPanel(key)}
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
				<button type="button" className={`owl-desktop-menu-trigger owl-desktop-evaluation-entry${props.sidebarView === "research" ? " is-active" : ""}`} aria-pressed={props.sidebarView === "research"} data-fd-id="research-workbench-entry" onClick={() => { setMenu(undefined); props.onOpenResearch(); }}>
					{researchTitle}
				</button>
				<div className="owl-desktop-menu owl-desktop-compact-menu">
					<button
						type="button"
						className={`owl-desktop-menu-trigger owl-desktop-more-trigger${menu === "more" || (compactMenus && menu) ? " is-open" : ""}`}
						aria-label={t("rail.more")}
						title={t("rail.more")}
						aria-haspopup="menu"
						aria-expanded={menu === "more" || Boolean(compactMenus && menu)}
						aria-controls={`owl-desktop-menu-${compactMenus && menu ? menu : "more"}`}
						onPointerDown={() => { capturedEditableRef.current = captureEditableTarget(); }}
						onKeyDown={(event) => {
							if (event.key !== "ArrowDown") return;
							event.preventDefault();
							menuTrigger.current = event.currentTarget;
							capturedEditableRef.current = captureEditableTarget();
							setMenuError("");
							setMenu("more");
							requestAnimationFrame(() => {
								const panel = document.getElementById("owl-desktop-menu-more");
								if (panel) moveMenuFocus(panel, "first");
							});
						}}
						onClick={(event) => {
							menuTrigger.current = event.currentTarget;
							setMenuError("");
							setMenu((current) => current === "more" || (compactMenus && current) ? undefined : "more");
						}}
					><IconMore /></button>
					{menu && (menu === "more" || compactMenus) && renderMenuPanel(menu)}
				</div>
			</div>
			{menuError && <span className="owl-desktop-copy-error" role="status">{menuError}</span>}
			<div className="owl-desktop-window-controls" data-tauri-drag-region="false">
				<button
					type="button"
					className={`owl-chrome-button owl-desktop-manager${props.sidebarView === "manager" ? " is-active" : ""}`}
					aria-label="号池 Manager"
					title="号池 Manager"
					aria-pressed={props.sidebarView === "manager"}
					onClick={props.onOpenManager}
				>
					<IconPool />
				</button>
				<button
					type="button"
					className={`owl-chrome-button owl-desktop-token-career${props.sidebarView === "career" ? " is-active" : ""}`}
					aria-label={t("titlebar.tokenCareer")}
					title={t("titlebar.tokenCareer")}
					aria-pressed={props.sidebarView === "career"}
					onClick={props.onOpenTokenCareer}
				>
					<IconTokenCareer />
				</button>
				<button
					type="button"
					className={`owl-chrome-button owl-desktop-life-guide${props.sidebarView === "guide" ? " is-active" : ""}`}
					aria-label={t("titlebar.lifeGuide")}
					title={t("titlebar.lifeGuide")}
					aria-pressed={props.sidebarView === "guide"}
					onClick={props.onOpenLifeGuide}
				>
					<IconStickFigure />
				</button>
				{props.lifeCount > 0 && (
					<button
						type="button"
						className="owl-chrome-button owl-desktop-life-monitor"
						aria-label={t("titlebar.lifeMonitor", { n: props.lifeCount })}
						title={t("titlebar.lifeMonitor", { n: props.lifeCount })}
						onClick={props.onOpenDiagnostics}
					>
						<span className={`owl-life-dot ${props.lifeDot}`} aria-hidden="true">{props.lifeCount}</span>
					</button>
				)}
				<WindowControls />
			</div>
		</header>
	);
}
