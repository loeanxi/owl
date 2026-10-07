import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/index.ts";
import { bridgeLogPath } from "../bridge/native.ts";
import "./session-actions-menu.css";

/** 右键菜单要用的会话路径信息；字段缺失时对应菜单项隐藏。 */
export type SessionMenuInfo = {
	id?: string;
	/** 会话所属项目（cwd）。 */
	cwd?: string;
	/** 会话记录 JSONL 文件的绝对路径（session.list 行上的 path）。 */
	file?: string;
};

/** Session actions float outside the sidebar's scrolling and clipping region. */
export function SessionActionsMenu({
	anchor,
	point,
	menuId,
	label,
	pinned,
	session,
	onClose,
	onPin,
	onArchive,
	onDelete,
	onReveal,
}: {
	anchor: HTMLButtonElement;
	/** 右键打开时的指针位置：菜单锚在指针处；省略时按 anchor（⋯ 按钮）定位。 */
	point?: { x: number; y: number };
	menuId: string;
	label: string;
	pinned: boolean;
	session?: SessionMenuInfo;
	onClose: (restoreFocus?: boolean) => void;
	onPin: () => void;
	onArchive: () => void;
	onDelete: () => void;
	onReveal?: () => void;
}): React.JSX.Element {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (!menu || (point === undefined && !anchor.isConnected)) {
			closeRef.current(false);
			return;
		}
		const bounds = menu.getBoundingClientRect();
		const inset = 8;
		if (point !== undefined) {
			setPosition({
				left: Math.max(inset, Math.min(point.x, window.innerWidth - bounds.width - inset)),
				top: Math.max(inset, Math.min(point.y, window.innerHeight - bounds.height - inset)),
			});
			return;
		}
		const trigger = anchor.getBoundingClientRect();
		const gap = 4;
		const below = window.innerHeight - trigger.bottom - inset;
		const above = trigger.top - inset;
		const preferredTop = below >= bounds.height + gap || below >= above
			? trigger.bottom + gap
			: trigger.top - bounds.height - gap;
		setPosition({
			left: Math.max(inset, Math.min(trigger.right - bounds.width, window.innerWidth - bounds.width - inset)),
			top: Math.max(inset, Math.min(preferredTop, window.innerHeight - bounds.height - inset)),
		});
	}, [anchor, point, menuId]);

	useLayoutEffect(() => {
		if (position !== null) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
	}, [position]);

	// 桥进程日志路径（%TEMP%\owl-bridge.log）：仅桌面壳有，解析失败按无日志处理
	const [logPath, setLogPath] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void bridgeLogPath().then((value) => {
			if (!cancelled) setLogPath(value);
		});
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		const onOutsideDown = (event: MouseEvent): void => {
			const target = event.target;
			if (target instanceof Node && (menuRef.current?.contains(target) || anchor.contains(target))) return;
			closeRef.current(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeRef.current(true);
			} else if (event.key === "Tab") {
				// Continue native tab order from the row, not the portal at the end of body.
				if (anchor.isConnected && event.target instanceof Node && menuRef.current?.contains(event.target)) {
					anchor.focus({ preventScroll: true });
				}
				closeRef.current(false);
			}
		};
		const onScroll = (event: Event): void => {
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			closeRef.current(false);
		};
		const onResize = (): void => closeRef.current(false);
		document.addEventListener("mousedown", onOutsideDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("mousedown", onOutsideDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [anchor]);

	const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined;
		if (step === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
			.filter((item) => !item.disabled);
		if (items.length === 0) return;
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = step === "first" ? 0
			: step === "last" ? items.length - 1
			: current === -1 ? (step > 0 ? 0 : items.length - 1)
			: (current + step + items.length) % items.length;
		items[next]?.focus({ preventScroll: true });
	};

	const copyText = (value: string): void => {
		void navigator.clipboard.writeText(value).catch(() => {});
	};

	return createPortal(
		<div
			ref={menuRef}
			id={menuId}
			role="menu"
			aria-label={label}
			data-menu-root
			className="owl-session-actions-menu"
			style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position === null ? "hidden" : undefined }}
			onKeyDown={onMenuKeyDown}
		>
			<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); onPin(); }}>
				{pinned ? t("sidebar.unpin") : t("sidebar.pin")}
			</button>
			<div className="owl-session-actions-menu-separator" role="separator" />
			<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); onArchive(); }}>
				{t("sidebar.archive")}
			</button>
			<div className="owl-session-actions-menu-separator" role="separator" />
			{onReveal !== undefined && (
				<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); onReveal(); }}>
					{t("sidebar.revealInExplorer")}
				</button>
			)}
			{session?.cwd && (
				<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); copyText(session.cwd!); }}>
					{t("sidebar.copyPath")}
				</button>
			)}
			{session?.file && (
				<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); copyText(session.file!); }}>
					{t("sidebar.copyTaskPath")}
				</button>
			)}
			{logPath !== null && (
				<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); copyText(logPath); }}>
					{t("sidebar.copyLogPath")}
				</button>
			)}
			{session?.id && (
				<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item" onClick={() => { onClose(false); copyText(session.id!); }}>
					{t("sidebar.copySessionId")}
				</button>
			)}
			<div className="owl-session-actions-menu-separator" role="separator" />
			<button type="button" role="menuitem" tabIndex={-1} className="owl-session-actions-menu-item is-danger" onClick={() => { onClose(false); onDelete(); }}>
				{t("sidebar.deleteSessionTitle")}
			</button>
		</div>,
		document.body,
	);
}
