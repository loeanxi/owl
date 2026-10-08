import { useEffect, useRef, useState } from "react";
import { hasTauri, startDebugRebuild } from "../bridge/native.ts";
import { getUiLanguageSetting, setUiLanguageSetting, useT, type TextKey, type UiLanguageSetting } from "../i18n/index.ts";
import { useMediaPlayingDot } from "../features/media/use-media.ts";
import { IconFolder, IconHome, IconNews, IconPin, IconSelf, IconSettings } from "./icons.tsx";
import { loadRailPins, RAIL_PINNABLE_VIEWS, saveRailPins, toggleRailPin } from "./rail-pins.ts";
import type { SettingsInitialTab } from "./SettingsPage.tsx";
import "./navigation-design.css";

/** 主导航视图；设置作为覆盖页保留当前视图。 */
export type RailView = "manager" | "chat" | "automation" | "map" | "news" | "mail" | "evaluation" | "media" | "projects" | "research" | "guide" | "myself" | "expert" | "career" | "monitor" | "bagu" | "market";

/** 菜单底部通知条：调试更新流程的进度 / 结果。 */
type UpdateNotice = {
	tone: "info" | "success" | "warning" | "error";
	key: TextKey;
	vars?: Record<string, string | number>;
};

/** 菜单条目：普通动作项，或界面语言子菜单占位。 */
type RailMenuItem = {
	label: TextKey;
	icon: React.ReactNode;
	action: () => void;
	closeOnSelect?: boolean;
	disabled?: boolean;
	busy?: boolean;
	disabledTitle?: TextKey;
} | { kind: "language" };

/** 可置顶功能条目（Codex 式）：默认不占位，图钉后进入图标栏下方置顶区。 */
type RailTool = {
	view: RailView;
	labelKey: TextKey;
	icon: React.ReactNode;
	/** 音乐入口的播放指示点。 */
	showPlayingDot?: boolean;
};

const RAIL_TOOL_ICONS: Record<string, React.ReactNode> = {
	news: <IconNews className="h-[18px] w-[18px]" />,
	projects: <IconFolder className="h-[18px] w-[18px]" />,
	automation: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="12" cy="13" r="8" />
			<path d="M12 9v4l2.5 2.5" />
			<path d="M5 3 2 6M19 3l3 3" />
		</svg>
	),
	map: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
			<path d="M9 3v15M15 6v15" />
		</svg>
	),
	mail: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<path d="m3 6 9 7 9-7" />
		</svg>
	),
	media: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M9 18V6l11-2v11" />
			<circle cx="6.5" cy="18" r="2.6" />
			<circle cx="17.5" cy="15" r="2.6" />
		</svg>
	),
	expert: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="9.5" />
			<path d="m15.5 8.5-2 5-5 2 2-5z" />
		</svg>
	),
	bagu: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="12" cy="8.5" r="5" />
			<path d="M9.2 12.8 7.5 21l4.5-2.4L16.5 21l-1.7-8.2" />
		</svg>
	),
	market: (
		<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M13.5 3.5 15 5a1.4 1.4 0 0 1-1 2.4h-1.3a1.6 1.6 0 0 0 0 3.2H14a1.4 1.4 0 0 1 1.4 1.4v1.6a1.4 1.4 0 0 0 1.4 1.4H19a1.6 1.6 0 0 0 0-3.2h-.4" />
			<path d="M19.6 10.6A1.7 1.7 0 0 1 21 12.3V19a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19V5.6A1.6 1.6 0 0 1 5.6 4h6.1a1.7 1.7 0 0 1 1.7 1.4Z" />
		</svg>
	),
};

/** 功能抽屉展示顺序与 rail-pins.RAIL_PINNABLE_VIEWS 保持一致。 */
const RAIL_TOOLS: RailTool[] = RAIL_PINNABLE_VIEWS.map((view) => ({
	view,
	labelKey: `rail.${view}` as TextKey,
	icon: RAIL_TOOL_ICONS[view],
	showPlayingDot: view === "media",
}));

/** 「界面语言」子菜单项：悬停/点击向右弹出 选项，✓ 标当前；选择即切换并交给上层持久化。 */
function LanguageMenuItem({ onPick }: { onPick: (next: UiLanguageSetting) => void }): React.JSX.Element {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ left: 0, bottom: 0 });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const selectedRef = useRef<HTMLButtonElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const current = getUiLanguageSetting();
	const options: { value: UiLanguageSetting; labelKey: TextKey }[] = [
		{ value: "system", labelKey: "settings.general.uiLanguageSystem" },
		{ value: "en", labelKey: "settings.general.uiLanguageEn" },
		{ value: "zh", labelKey: "settings.general.uiLanguageZh" },
	];

	const clearCloseTimer = (): void => {
		window.clearTimeout(closeTimer.current);
	};
	// fixed 定位不受面板 overflow 裁剪：贴触发项右侧弹出，底边对齐（不够高时贴屏底）。
	const syncPos = (): void => {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) setPos({ left: rect.right + 6, bottom: Math.max(8, window.innerHeight - rect.bottom) });
	};
	const openNow = (): void => {
		clearCloseTimer();
		syncPos();
		setOpen(true);
	};
	const scheduleClose = (): void => {
		clearCloseTimer();
		closeTimer.current = setTimeout(() => setOpen(false), 160);
	};

	useEffect(() => () => clearCloseTimer(), []);
	useEffect(() => {
		if (open) selectedRef.current?.focus();
	}, [open]);

	const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>, step: number | "first" | "last"): void => {
		const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]'));
		if (items.length === 0) return;
		const idx = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = step === "first" ? 0 : step === "last" ? items.length - 1 : idx === -1 ? (step > 0 ? 0 : items.length - 1) : (idx + step + items.length) % items.length;
		items[next]?.focus();
	};

	return (
		<div
			className="owl-rail-menu-submenu"
			onMouseEnter={openNow}
			onMouseLeave={scheduleClose}
			onKeyDown={(event) => {
				// 焦点在触发项上时 Esc 只收子菜单，不关整个菜单（阻止冒泡到 document 监听）
				if (open && event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					setOpen(false);
				}
			}}
		>
			<button
				ref={triggerRef}
				type="button"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => {
					if (open) {
						clearCloseTimer();
						setOpen(false);
					} else openNow();
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowRight") {
						event.preventDefault();
						event.stopPropagation();
						openNow();
					}
				}}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z" /></svg>
				<span>{t("rail.language")}</span>
				<span className="owl-rail-menu-current">{t(options.find((option) => option.value === current)?.labelKey ?? "settings.general.uiLanguageZh")}</span>
				<span className="owl-rail-menu-arrow" aria-hidden="true">›</span>
			</button>
			{open && (
				<div
					className="owl-rail-menu-flyout"
					role="menu"
					aria-label={t("rail.language")}
					style={{ left: pos.left, bottom: pos.bottom }}
					onMouseEnter={clearCloseTimer}
					onMouseLeave={scheduleClose}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							setOpen(false);
							triggerRef.current?.focus();
							return;
						}
						const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined;
						if (step === undefined) return;
						event.preventDefault();
						event.stopPropagation();
						moveFocus(event, step);
					}}
				>
					{options.map((option) => {
						const active = option.value === current;
						return (
							<button
								key={option.value}
								ref={active ? selectedRef : undefined}
								type="button"
								role="menuitemradio"
								aria-checked={active}
								onClick={() => onPick(option.value)}
							>
								<span className="owl-rail-menu-check" aria-hidden="true">{active ? "✓" : ""}</span>
								<span>{t(option.labelKey)}</span>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

/**
 * 最左侧图标栏（Codex 式 activity bar）。
 * 顶部固定：首页 / 我的助理 / 号池 / 功能抽屉触发钮；
 * 资讯与其余功能默认不占位，在「功能抽屉」里点图钉后才常驻到分隔线下方置顶区，再点图钉取消。
 * app 菜单单独贴底，中段不留空档。
 */
export function ActivityRail({
	view,
	settingsOpen = false,
	onSelect,
	onHome,
	onOpenSettings,
	onOpenGuide,
	onShowShortcuts,
	onPersistUiLanguage,
}: {
	view: RailView;
	settingsOpen?: boolean;
	/** 切换主导航视图，保留各视图当前内容。 */
	onSelect: (view: RailView) => void;
	onHome: () => void;
	onOpenSettings: (tab: SettingsInitialTab) => void;
	onOpenGuide: () => void;
	onShowShortcuts: () => void;
	/** 界面语言在菜单里直选后持久化到 settings.json（App 侧接 settings.set）。 */
	onPersistUiLanguage?: (next: UiLanguageSetting) => void;
}): React.JSX.Element {
	const t = useT();
	const mediaPlaying = useMediaPlayingDot();
	const itemClass = (active: boolean): string => `owl-rail-button${active ? " is-active" : ""}`;
	const [menuOpen, setMenuOpen] = useState(false);
	const [toolsOpen, setToolsOpen] = useState(false);
	const [pins, setPins] = useState<RailView[]>(() => loadRailPins());
	const menuRootRef = useRef<HTMLDivElement>(null);
	const menuPanelRef = useRef<HTMLDivElement>(null);
	const menuTriggerRef = useRef<HTMLButtonElement>(null);
	const toolsRootRef = useRef<HTMLDivElement>(null);
	const toolsPanelRef = useRef<HTMLDivElement>(null);
	const toolsTriggerRef = useRef<HTMLButtonElement>(null);
	const updateBusyRef = useRef(false);
	const [updateAction, setUpdateAction] = useState<"debug">();
	const [updateNotice, setUpdateNotice] = useState<UpdateNotice>();
	const nativeAvailable = hasTauri();

	useEffect(() => {
		if (!menuOpen) return;
		menuPanelRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
		const dismiss = (event: PointerEvent): void => {
			if (!menuRootRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		const dismissOnEscape = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setMenuOpen(false);
			menuTriggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", dismissOnEscape);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", dismissOnEscape);
		};
	}, [menuOpen]);

	useEffect(() => {
		if (!toolsOpen) return;
		toolsPanelRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
		const dismiss = (event: PointerEvent): void => {
			if (!toolsRootRef.current?.contains(event.target as Node)) setToolsOpen(false);
		};
		const dismissOnEscape = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setToolsOpen(false);
			toolsTriggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", dismissOnEscape);
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			document.removeEventListener("keydown", dismissOnEscape);
		};
	}, [toolsOpen]);

	useEffect(() => {
		setMenuOpen(false);
		setToolsOpen(false);
	}, [view, settingsOpen]);

	const togglePin = (view: RailView): void => {
		setPins((current) => {
			const next = toggleRailPin(current, view);
			saveRailPins(next);
			return next;
		});
	};

	const debugUpdate = async (): Promise<void> => {
		if (updateBusyRef.current) return;
		// 「调试更新」会退出当前 Owl 并启动一次全量构建，先让用户确认。
		if (!window.confirm(t("rail.debugUpdateConfirm"))) return;
		updateBusyRef.current = true;
		setUpdateAction("debug");
		setUpdateNotice({ tone: "info", key: "rail.debugUpdateStarting" });
		try {
			if (!(await startDebugRebuild())) {
				setUpdateNotice({ tone: "warning", key: "rail.updateDesktopOnly" });
				updateBusyRef.current = false;
				setUpdateAction(undefined);
				return;
			}
			setUpdateNotice({ tone: "success", key: "rail.debugUpdateStarted" });
		} catch (error) {
			const message = error instanceof Error && error.message.trim()
				? error.message.trim()
				: typeof error === "string" && error.trim()
					? error.trim()
					: String(error || "unknown");
			setUpdateNotice({ tone: "error", key: "rail.debugUpdateFailed", vars: { message } });
			updateBusyRef.current = false;
			setUpdateAction(undefined);
		}
	};

	const menuGroups: RailMenuItem[][] = [
		[
			{ label: "rail.settings", icon: <IconSettings className="h-4 w-4" />, action: () => onOpenSettings("general") },
			{ label: "rail.about", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>, action: () => window.alert(t("rail.aboutText")) },
			{ kind: "language" },
			{ label: "rail.models", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></svg>, action: () => onOpenSettings("models") },
		],
		[
			{
				label: updateAction === "debug" ? "rail.debugUpdating" : "rail.debugUpdate",
				icon: <svg className={updateAction === "debug" ? "owl-rail-menu-spinner" : undefined} viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /><path d="m15 17 2 2 4-4" /></svg>,
				action: () => { void debugUpdate(); },
				closeOnSelect: false,
				disabled: !nativeAvailable || updateAction !== undefined,
				busy: updateAction === "debug",
				disabledTitle: !nativeAvailable ? "rail.updateDesktopOnly" : undefined,
			},
		],
		[
			{ label: "help.guide", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15" /></svg>, action: onOpenGuide },
			{ label: "help.shortcuts", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" /></svg>, action: onShowShortcuts },
		],
	];

	// 置顶区 = 已图钉功能；当前打开但未图钉的功能临时跟随显示，避免「开着却找不到入口」。
	const toolByView = new Map(RAIL_TOOLS.map((tool) => [tool.view, tool]));
	const pinnedTools = pins.flatMap((pinned) => {
		const tool = toolByView.get(pinned);
		return tool ? [tool] : [];
	});
	const activeTool = toolByView.get(view);
	const railTools = activeTool && !pins.includes(activeTool.view) ? [...pinnedTools, activeTool] : pinnedTools;

	const renderToolButton = (tool: RailTool): React.JSX.Element => (
		<button
			key={tool.view}
			type="button"
			className={itemClass(view === tool.view && !settingsOpen)}
			title={t(tool.labelKey)}
			aria-label={t(tool.labelKey)}
			aria-current={view === tool.view && !settingsOpen ? "page" : undefined}
			onClick={() => onSelect(tool.view)}
		>
			{tool.icon}
			{tool.showPlayingDot && mediaPlaying && <span className="owl-rail-media-dot" aria-hidden="true" />}
		</button>
	);

	const renderDrawerRow = (tool: RailTool, pinned: boolean): React.JSX.Element => (
		<div key={tool.view} className="owl-rail-tools-row">
			<button
				type="button"
				role="menuitem"
				className={`owl-rail-tools-item${view === tool.view ? " is-active" : ""}`}
				onClick={() => {
					setToolsOpen(false);
					onSelect(tool.view);
				}}
			>
				{tool.icon}
				<span>{t(tool.labelKey)}</span>
			</button>
			<button
				type="button"
				className={`owl-rail-tools-pin${pinned ? " is-pinned" : ""}`}
				title={pinned ? t("rail.unpin") : t("rail.pin")}
				aria-label={pinned ? t("rail.unpin") : t("rail.pin")}
				aria-pressed={pinned}
				onClick={() => togglePin(tool.view)}
			>
				<IconPin className="h-4 w-4" filled={pinned} />
			</button>
		</div>
	);

	const drawerPinned = pinnedTools;
	const drawerRest = RAIL_TOOLS.filter((tool) => !pins.includes(tool.view));

	return (
		<nav className="owl-activity-rail" data-tauri-drag-region="deep" aria-label={t("rail.aria")}>
			<button
				type="button"
				className="owl-rail-brand"
				title={t("rail.homeTitle")}
				aria-label={t("rail.home")}
				onClick={() => { setMenuOpen(false); setToolsOpen(false); onHome(); }}
			>
				<IconHome className="h-5 w-5" />
			</button>

			{/* 「我的助理」：顶部固定入口（每天一个 owl-myself/md 的日程与提炼）。 */}
			<button
				type="button"
				className={itemClass(view === "myself" && !settingsOpen)}
				title={t("rail.myself")}
				aria-label={t("rail.myself")}
				aria-current={view === "myself" && !settingsOpen ? "page" : undefined}
				onClick={() => onSelect("myself")}
			>
				<IconSelf className="h-[18px] w-[18px]" />
			</button>

			{/* 号池 Manager：顶部固定入口（迁移阶段 6）：嵌入 owl 主内容区的一等视图。 */}
			<button
				type="button"
				className={itemClass(view === "manager" && !settingsOpen)}
				title="号池 Manager"
				aria-label="号池 Manager"
				aria-current={view === "manager" && !settingsOpen ? "page" : undefined}
				onClick={() => onSelect("manager")}
			>
				<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<ellipse cx="12" cy="5.5" rx="8" ry="2.8" />
					<path d="M4 5.5v6c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-6" />
					<path d="M4 11.5v6c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-6" />
				</svg>
			</button>

			{/* 功能抽屉触发钮：Codex 式放在固定组末尾、分隔线之上。 */}
			<div className="owl-rail-tools" ref={toolsRootRef} data-tauri-drag-region="false">
				<button
					ref={toolsTriggerRef}
					type="button"
					className={`owl-rail-button${toolsOpen ? " is-active" : ""}`}
					title={t("rail.tools")}
					aria-label={t("rail.tools")}
					aria-haspopup="menu"
					aria-expanded={toolsOpen}
					aria-controls="owl-rail-tools-panel"
					onClick={() => setToolsOpen((open) => !open)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setToolsOpen(true);
						}
					}}
				>
					<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
						<rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
						<rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
						<rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
					</svg>
				</button>
				{toolsOpen && (
					<div
						ref={toolsPanelRef}
						id="owl-rail-tools-panel"
						className="owl-rail-tools-panel"
						role="menu"
						aria-label={t("rail.tools")}
						onBlur={(event) => {
							if (event.relatedTarget && !toolsRootRef.current?.contains(event.relatedTarget as Node)) setToolsOpen(false);
						}}
						onKeyDown={(event) => {
							const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined;
							if (step === undefined) return;
							event.preventDefault();
							event.stopPropagation();
							const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
							if (items.length === 0) return;
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const next = step === "first" ? 0 : step === "last" ? items.length - 1 : (current + step + items.length) % items.length;
							items[next]?.focus();
						}}
					>
					{drawerPinned.length > 0 && (
						<>
							<div className="owl-rail-tools-group">{drawerRest.length > 0 ? t("rail.pins") : t("rail.tools")}</div>
							{drawerPinned.map((tool) => renderDrawerRow(tool, true))}
						</>
					)}
					{drawerRest.length > 0 && (
						<>
							{drawerPinned.length > 0 && <div className="owl-rail-menu-separator" role="separator" />}
							<div className="owl-rail-tools-group">{drawerPinned.length > 0 ? t("rail.toolsMore") : t("rail.toolsAll")}</div>
							{drawerRest.map((tool) => renderDrawerRow(tool, false))}
						</>
					)}
					</div>
				)}
			</div>

			{/* 置顶区：图钉决定常驻功能。 */}
			<div className="owl-rail-pins" data-tauri-drag-region="false">
				<div className="owl-rail-divider" role="separator" aria-hidden="true" />
				{railTools.map(renderToolButton)}
			</div>

			<div className="owl-rail-app-menu" ref={menuRootRef} data-tauri-drag-region="false">
				<button
					ref={menuTriggerRef}
					type="button"
					className={`owl-rail-menu-trigger${menuOpen ? " is-open" : ""}`}
					title={t("rail.appMenu")}
					aria-label={t("rail.appMenu")}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					aria-controls="owl-rail-app-menu-panel"
					onClick={() => setMenuOpen((open) => !open)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setMenuOpen(true);
						}
					}}
				>
					<img src="/owl.svg" alt="" className="h-6 w-6" draggable={false} />
				</button>
				{menuOpen && (
					<div
						ref={menuPanelRef}
						id="owl-rail-app-menu-panel"
						className="owl-rail-menu-panel"
						role="menu"
						aria-label={t("rail.appMenu")}
						onBlur={(event) => {
							if (event.relatedTarget && !menuRootRef.current?.contains(event.relatedTarget as Node)) setMenuOpen(false);
						}}
						onKeyDown={(event) => {
							const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined;
							if (step === undefined) return;
							event.preventDefault();
							event.stopPropagation();
							const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const next = step === "first" ? 0 : step === "last" ? items.length - 1 : (current + step + items.length) % items.length;
							items[next]?.focus();
						}}
					>
						<div className="owl-rail-menu-header"><strong>Owl</strong></div>
						{menuGroups.map((group, index) => (
							<div key={index} role="group">
								{index > 0 && <div className="owl-rail-menu-separator" role="separator" />}
								{group.map((item) => (
									"kind" in item ? (
										<LanguageMenuItem
											key="language"
											onPick={(next) => {
												setUiLanguageSetting(next);
												onPersistUiLanguage?.(next);
												setMenuOpen(false);
											}}
										/>
									) : (
										<button
											key={item.label}
											type="button"
											role="menuitem"
											disabled={item.disabled}
											aria-busy={item.busy || undefined}
											title={item.disabledTitle ? t(item.disabledTitle) : undefined}
											onClick={() => {
												if (item.closeOnSelect !== false) setMenuOpen(false);
												item.action();
											}}
										>
											{item.icon}
											<span>{t(item.label)}</span>
										</button>
									)
								))}
							</div>
						))}
						{updateNotice && (
							<div role="group" aria-label={t("rail.updateStatus")}>
								<div className={`owl-rail-update-status is-${updateNotice.tone}`} role="status" aria-live="polite">
									{t(updateNotice.key, updateNotice.vars)}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</nav>
	);
}
