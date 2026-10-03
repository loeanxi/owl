import { useEffect, useRef, useState, type RefObject } from "react";
import { IconPanelLeft } from "./icons.tsx";
import { WindowControls } from "./WindowControls.tsx";

type MenuKey = "file" | "edit" | "view" | "help";

interface DesktopTitlebarProps {
	connected: boolean;
	sidebarCollapsed: boolean;
	sidebarToggleRef: RefObject<HTMLButtonElement | null>;
	onToggleSidebar: () => void;
	onNewChat: () => void;
	onOpenProject: () => void;
	onOpenSettings: () => void;
	onOpenAbout: () => void;
	onDockRight: () => void;
	onDockBottom: () => void;
}

/** Desktop chrome owns app actions; conversation controls stay in the frame below. */
export function DesktopTitlebar(props: DesktopTitlebarProps): React.JSX.Element {
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
			{ label: "新会话", action: props.onNewChat, disabled: !props.connected },
			{ label: "打开项目…", action: props.onOpenProject, disabled: !props.connected },
		],
		edit: [
			{
				label: "复制选中内容",
				disabled: !window.getSelection()?.toString(),
				action: () => {
					const selected = window.getSelection()?.toString();
					if (selected) {
						void navigator.clipboard.writeText(selected).catch(() => {
							setCopyError("复制失败，请使用系统复制操作。");
						});
					}
				},
			},
			{ label: "设置…", action: props.onOpenSettings },
		],
		view: [
			{ label: props.sidebarCollapsed ? "显示会话列表" : "隐藏会话列表", action: props.onToggleSidebar },
			{ label: "右侧工作台", action: props.onDockRight },
			{ label: "底部工作台", action: props.onDockBottom },
		],
		help: [{ label: "关于 OWL", action: props.onOpenAbout }],
	};

	return (
		<header className="owl-desktop-titlebar" ref={root} data-tauri-drag-region="deep">
			<div className="owl-desktop-menu-row" data-tauri-drag-region="false">
				<button
					ref={props.sidebarToggleRef}
					type="button"
					className="owl-chrome-button owl-desktop-sidebar-toggle"
					aria-label={props.sidebarCollapsed ? "显示会话列表" : "隐藏会话列表"}
					title={props.sidebarCollapsed ? "显示会话列表" : "隐藏会话列表"}
					aria-expanded={!props.sidebarCollapsed}
					aria-controls="owl-session-sidebar"
					onClick={props.onToggleSidebar}
				>
					<IconPanelLeft className="h-4 w-4" />
				</button>
				{([['file', '文件'], ['edit', '编辑'], ['view', '视图'], ['help', '帮助']] as const).map(([key, label]) => (
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
							{label}
						</button>
						{menu === key && (
							<div className="owl-desktop-menu-panel" role="menu" id={`owl-desktop-menu-${key}`} aria-label={label}>
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
