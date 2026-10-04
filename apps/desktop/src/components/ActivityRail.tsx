import { useEffect, useRef, useState } from "react";
import { useT, type TextKey } from "../i18n/index.ts";
import { useMediaPlayingDot } from "../features/media/use-media.ts";
import { IconChat, IconHome, IconMore, IconNews, IconSettings } from "./icons.tsx";
import type { SettingsInitialTab } from "./SettingsPage.tsx";
import { useResearchEntryText } from "../features/research/research-entry-copy.ts";
import "./navigation-design.css";

/** 主导航视图；设置作为覆盖页保留当前视图。 */
export type RailView = "chat" | "map" | "news" | "mail" | "evaluation" | "media" | "research";

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
}: {
	view: RailView;
	settingsOpen?: boolean;
	/** 切换主导航视图，保留各视图当前内容。 */
	onSelect: (view: RailView) => void;
	onHome: () => void;
	onOpenSettings: (tab: SettingsInitialTab) => void;
	onOpenGuide: () => void;
	onShowShortcuts: () => void;
}): React.JSX.Element {
	const t = useT();
	const researchTitle = useResearchEntryText();
	const mediaPlaying = useMediaPlayingDot();
	const itemClass = (active: boolean): string => `owl-rail-button${active ? " is-active" : ""}`;
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRootRef = useRef<HTMLDivElement>(null);
	const menuPanelRef = useRef<HTMLDivElement>(null);
	const menuTriggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		menuPanelRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
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

	const menuGroups: { label: TextKey; icon: React.ReactNode; action: () => void }[][] = [
		[
			{ label: "rail.settings", icon: <IconSettings className="h-4 w-4" />, action: () => onOpenSettings("general") },
			{ label: "rail.language", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z" /></svg>, action: () => onOpenSettings("general") },
			{ label: "rail.models", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></svg>, action: () => onOpenSettings("models") },
		],
		[
			{ label: "help.guide", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15" /></svg>, action: onOpenGuide },
			{ label: "help.shortcuts", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" /></svg>, action: onShowShortcuts },
			{ label: "rail.about", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>, action: () => onOpenSettings("about") },
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

			<button type="button" className={itemClass(view === "research" && !settingsOpen)} title={researchTitle} aria-label={researchTitle} aria-current={view === "research" && !settingsOpen ? "page" : undefined} onClick={() => onSelect("research")} data-fd-id="research-rail-entry">
				<svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m16 8-2.4 5.6L8 16l2.4-5.6Z" /></svg>
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
							const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
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
									<button key={item.label} type="button" role="menuitem" onClick={() => { setMenuOpen(false); item.action(); }}>
										{item.icon}
										<span>{t(item.label)}</span>
									</button>
								))}
							</div>
						))}
					</div>
				)}
			</div>
		</nav>
	);
}
