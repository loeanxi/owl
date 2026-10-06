import { useEffect, useRef, useState } from "react";
import { hasTauri, startDebugRebuild } from "../bridge/native.ts";
import { getUiLanguageSetting, setUiLanguageSetting, useT, type TextKey, type UiLanguageSetting } from "../i18n/index.ts";
import { useMediaPlayingDot } from "../features/media/use-media.ts";
import { IconChat, IconHome, IconMore, IconNews, IconSettings } from "./icons.tsx";
import type { SettingsInitialTab } from "./SettingsPage.tsx";
import "./navigation-design.css";

/** 主导航视图；设置作为覆盖页保留当前视图。 */
export type RailView = "chat" | "map" | "news" | "mail" | "evaluation" | "media" | "research" | "guide";

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
 * 结构刻意做成纯配置驱动：加功能 = 在 items 里加一项 + 接一个 onSelect 分支。
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
	const menuRootRef = useRef<HTMLDivElement>(null);
	const menuPanelRef = useRef<HTMLDivElement>(null);
	const menuTriggerRef = useRef<HTMLButtonElement>(null);
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

	useEffect(() => setMenuOpen(false), [view, settingsOpen]);

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

	return (
		<nav className="owl-activity-rail" data-tauri-drag-region="deep" aria-label={t("rail.aria")}>
			<button
				type="button"
				className="owl-rail-brand"
				title={t("rail.homeTitle")}
				aria-label={t("rail.home")}
				onClick={() => { setMenuOpen(false); onHome(); }}
			>
				<IconHome className="h-5 w-5" />
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

			{/* 媒体桥（owl-media-bridge 插件）：音乐一等视图入口；绿点 = 有播放器正在播放。 */}
			<button
				type="button"
				className={itemClass(view === "media" && !settingsOpen)}
				title={t("rail.media")}
				aria-label={t("rail.media")}
				aria-current={view === "media" && !settingsOpen ? "page" : undefined}
				onClick={() => onSelect("media")}
			>
				<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M9 18V6l11-2v11" />
					<circle cx="6.5" cy="18" r="2.6" />
					<circle cx="17.5" cy="15" r="2.6" />
				</svg>
				{mediaPlaying && <span className="owl-rail-media-dot" aria-hidden="true" />}
			</button>

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
