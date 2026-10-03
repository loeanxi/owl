import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../i18n/index.ts";
import { IconPanelLeft } from "./icons.tsx";
import { WindowControls } from "./WindowControls.tsx";

type MenuKey = "file" | "edit" | "view" | "help";

interface DesktopTitlebarProps {
	connected: boolean;
	sidebarCollapsed: boolean;
	sidebarView?: "chat" | "map" | "news" | "mail";
	sidebarToggleRef: RefObject<HTMLButtonElement | null>;
	onToggleSidebar: () => void;
	onNewChat: () => void;
	onOpenProject: () => void;
	onOpenSettings: () => void;
	onOpenAbout: () => void;
	onDockRight: () => void;
	onDockBottom: () => void;
	onOpenDeveloper: () => void;
}

/** Desktop chrome owns app actions; conversation controls stay in the frame below. */
export function DesktopTitlebar(props: DesktopTitlebarProps): React.JSX.Element {
	const t = useT();
	const sidebarLabel = props.sidebarView === "mail"
		? props.sidebarCollapsed ? t("mail.showSidebar") : t("mail.hideSidebar")
		: props.sidebarView === "news"
		? t("news.navigation")
		: props.sidebarView === "map"
		? props.sidebarCollapsed ? t("titlebar.showMapSidebar") : t("titlebar.hideMapSidebar")
		: props.sidebarCollapsed ? t("titlebar.showSessions") : t("titlebar.hideSessions");
	const [menu, setMenu] = useState<MenuKey | undefined>();
	const [copyError, setCopyError] = useState("");
	const root = useRef<HTMLElement>(null);

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

	const actions: Record<MenuKey, { label: string; action: () => void; disabled?: boolean }[]> = {
		file: [
			{ label: t("titlebar.newChat"), action: props.onNewChat, disabled: !props.connected },
			{ label: t("titlebar.openProject"), action: props.onOpenProject, disabled: !props.connected },
		],
		edit: [
			{
				label: t("titlebar.copySelection"),
				disabled: !window.getSelection()?.toString(),
				action: () => {
					const selected = window.getSelection()?.toString();
					if (selected) {
						void navigator.clipboard.writeText(selected).catch(() => {
							setCopyError(t("titlebar.copyFailed"));
						});
					}
				},
			},
			{ label: t("titlebar.settings"), action: props.onOpenSettings },
		],
		view: [
			{ label: t("titlebar.openDeveloperWorkbench"), action: props.onOpenDeveloper },
			{ label: sidebarLabel, action: props.onToggleSidebar },
			{ label: t("titlebar.dockRight"), action: props.onDockRight },
			{ label: t("titlebar.dockBottom"), action: props.onDockBottom },
		],
		help: [{ label: t("titlebar.aboutOwl"), action: props.onOpenAbout }],
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
							onClick={() => {
								setCopyError("");
								setMenu((current) => current === key ? undefined : key);
							}}
						>
							{t(labelKey)}
						</button>
						{menu === key && (
							<div className="owl-desktop-menu-panel" role="menu" id={`owl-desktop-menu-${key}`} aria-label={t(labelKey)}>
								{actions[key].map((item) => (
									<button
										key={item.label}
										type="button"
										role="menuitem"
										disabled={item.disabled}
										onClick={() => {
											setMenu(undefined);
											item.action();
										}}
									>
										{item.label}
									</button>
								))}
							</div>
						)}
					</div>
				))}
			</div>
			<span className="owl-desktop-app-name" data-tauri-drag-region="deep">OWL</span>
			{copyError && <span className="owl-desktop-copy-error" role="status">{copyError}</span>}
			<div className="owl-desktop-window-controls" data-tauri-drag-region="false">
				<WindowControls />
			</div>
		</header>
	);
}
