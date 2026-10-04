import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconArchive, IconCheck, IconChevron, IconCompose, IconFolder, IconList, IconPin, IconSliders } from "./icons.tsx";
import { useProjectSidebarText } from "./project-sidebar-copy.ts";
import type { ProjectSection } from "../project-sidebar-model.ts";
import "./project-actions-menu.css";

type Entry = "separator" | { label: string; icon?: ReactNode; selected?: boolean; danger?: boolean; action?: () => void; children?: Entry[] };
type BaseProps = { anchor: HTMLButtonElement; menuId: string; label: string; onClose: (restoreFocus?: boolean) => void };
type Point = { left: number; top: number };
const closeIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;

/** Menus are portaled so project rows and nested choices cannot be clipped. */
function SidebarPopup({ anchor, menuId, label, onClose, entries }: BaseProps & { entries: Entry[] }): React.JSX.Element {
	const root = useRef<HTMLDivElement>(null);
	const main = useRef<HTMLDivElement>(null);
	const child = useRef<HTMLDivElement>(null);
	const close = useRef(onClose); close.current = onClose;
	const focusChild = useRef(false);
	const [position, setPosition] = useState<Point | null>(null);
	const [subPosition, setSubPosition] = useState<Point | null>(null);
	const [sub, setSub] = useState<number | null>(null);
	const selected = sub === null ? null : entries[sub];
	const childEntries = selected !== null && selected !== "separator" ? selected.children : undefined;
	useLayoutEffect(() => {
		if (!main.current || !anchor.isConnected) { close.current(false); return; }
		const a = anchor.getBoundingClientRect(); const b = main.current.getBoundingClientRect();
		const below = innerHeight - a.bottom - 8;
		const y = below >= b.height + 4 || below >= a.top - 8 ? a.bottom + 4 : a.top - b.height - 4;
		setPosition({ left: Math.max(8, Math.min(a.right - b.width, innerWidth - b.width - 8)), top: Math.max(8, Math.min(y, innerHeight - b.height - 8)) });
	}, [anchor, menuId, label, entries.length]);
	useLayoutEffect(() => { if (position) main.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus({ preventScroll: true }); }, [position]);
	useLayoutEffect(() => {
		if (sub === null || !child.current || !main.current) return;
		const row = main.current.querySelector<HTMLButtonElement>(`button[data-entry="${sub}"]`);
		if (!row) return;
		const a = main.current.getBoundingClientRect(); const b = child.current.getBoundingClientRect(); const r = row.getBoundingClientRect();
		const x = a.right + 4 + b.width <= innerWidth - 8 ? a.right + 4 : a.left - b.width - 4;
		setSubPosition({ left: Math.max(8, Math.min(x, innerWidth - b.width - 8)), top: Math.max(8, Math.min(r.top, innerHeight - b.height - 8)) });
	}, [sub, position, childEntries?.length]);
	useLayoutEffect(() => { if (subPosition && focusChild.current) { child.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus({ preventScroll: true }); focusChild.current = false; } }, [subPosition]);
	useEffect(() => {
		const outside = (event: MouseEvent): void => { if (event.target instanceof Node && (root.current?.contains(event.target) || anchor.contains(event.target))) return; close.current(false); };
		const key = (event: KeyboardEvent): void => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(true); }
			else if (event.key === "Tab") { if (root.current?.contains(document.activeElement) && anchor.isConnected) anchor.focus({ preventScroll: true }); close.current(false); }
		};
		const scroll = (event: Event): void => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close.current(false); };
		const resize = (): void => close.current(false);
		document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", key, true); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", resize);
		return () => { document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", key, true); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
	}, [anchor]);
	const openSub = (index: number, keyboard: boolean): void => {
		if (sub === index && subPosition !== null) { if (keyboard) child.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus({ preventScroll: true }); return; }
		focusChild.current = keyboard; setSubPosition(null); setSub(index);
	};
	const navigate = (event: React.KeyboardEvent<HTMLDivElement>, nested: boolean): void => {
		const active = document.activeElement as HTMLButtonElement;
		if (event.key === "ArrowRight" && !nested) {
			const index = Number(active.dataset.entry); const entry = entries[index];
			if (entry && entry !== "separator" && entry.children) { event.preventDefault(); event.stopPropagation(); openSub(index, true); }
			return;
		}
		if (event.key === "ArrowLeft" && nested) { event.preventDefault(); event.stopPropagation(); main.current?.querySelector<HTMLButtonElement>(`button[data-entry="${sub}"]`)?.focus({ preventScroll: true }); setSub(null); return; }
		const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined;
		if (direction === undefined) return;
		event.preventDefault(); event.stopPropagation();
		const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
		const index = items.indexOf(active);
		const next = direction === "first" ? 0 : direction === "last" ? items.length - 1 : (index + direction + items.length) % items.length;
		items[next]?.focus({ preventScroll: true });
	};
	const rows = (items: Entry[], nested: boolean): ReactNode => items.map((entry, index) => entry === "separator" ? <div className="owl-project-menu-divider" role="separator" key={`s-${index}`} /> : <button key={index} type="button" role="menuitem" tabIndex={-1} data-entry={index} className={`owl-project-menu-item ${entry.danger ? "is-danger" : ""}`} aria-haspopup={entry.children ? "menu" : undefined} aria-expanded={entry.children ? sub === index : undefined}
		onMouseEnter={() => { if (!nested) { if (entry.children && sub !== index) openSub(index, false); else if (!entry.children) setSub(null); } }}
		onClick={() => { if (entry.children) openSub(index, true); else { onClose(true); entry.action?.(); } }}>
		<span className="owl-project-menu-icon">{entry.icon}</span><span>{entry.label}</span><span className="owl-project-menu-trailing">{entry.children ? <IconChevron /> : entry.selected ? <IconCheck /> : null}</span>
	</button>);
	return createPortal(<div className="owl-project-menu-layer" ref={root} data-menu-root>
		<div ref={main} id={menuId} role="menu" aria-label={label} className="owl-project-actions-menu" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? undefined : "hidden" }} onKeyDown={(event) => navigate(event, false)}>{rows(entries, false)}</div>
		{childEntries && <div ref={child} role="menu" aria-label={selected !== "separator" ? selected?.label : undefined} className="owl-project-actions-menu is-submenu" style={{ left: subPosition?.left ?? 0, top: subPosition?.top ?? 0, visibility: subPosition ? undefined : "hidden" }} onKeyDown={(event) => navigate(event, true)}>{rows(childEntries, true)}</div>}
	</div>, document.body);
}

export function ProjectActionsMenu(props: BaseProps & { pinned: boolean; sections: ProjectSection[]; sectionId: string | null; onPin: () => void; onEdit: () => void; onSection: (id: string | null) => void; onNewSection: () => void; onReveal: () => void; onMarkRead: () => void; onArchive: () => void; onRemove: () => void }): React.JSX.Element {
	const t = useProjectSidebarText();
	const entries: Entry[] = [
		{ label: t(props.pinned ? "unpin" : "pin"), icon: <IconPin />, action: props.onPin }, { label: t("edit"), icon: <IconSliders />, action: props.onEdit },
		{ label: t("section"), icon: <IconList />, children: [{ label: t("defaultSection"), icon: <IconFolder />, selected: props.sectionId === null, action: () => props.onSection(null) }, ...props.sections.map((section) => ({ label: section.name, selected: props.sectionId === section.id, action: () => props.onSection(section.id) })), "separator", { label: t("newSection"), action: props.onNewSection }] },
		"separator", { label: t("reveal"), icon: <IconFolder />, action: props.onReveal }, { label: t("markAllRead"), icon: <IconCheck />, action: props.onMarkRead }, { label: t("archiveChats"), icon: <IconArchive />, action: props.onArchive },
		"separator", { label: t("removeProject"), icon: closeIcon, danger: true, action: props.onRemove },
	];
	return <SidebarPopup {...props} entries={entries} />;
}
export function ProjectsSectionMenu(props: BaseProps & { organize: "projects" | "merged"; sort: "recent" | "name" | "oldest"; onOrganize: (view: "projects" | "merged") => void; onSort: (sort: "recent" | "name" | "oldest") => void }): React.JSX.Element {
	const t = useProjectSidebarText();
	return <SidebarPopup {...props} entries={[
		{ label: t("organize"), icon: <IconList />, children: (["projects", "merged"] as const).map((view) => ({ label: t(view), selected: props.organize === view, action: () => props.onOrganize(view) })) },
		{ label: t("sort"), icon: <IconSliders />, children: (["recent", "name", "oldest"] as const).map((sort) => ({ label: t(sort), selected: props.sort === sort, action: () => props.onSort(sort) })) },
	]} />;
}
export function SectionActionsMenu(props: BaseProps & { onEdit: () => void; onRemove: () => void }): React.JSX.Element {
	const t = useProjectSidebarText();
	return <SidebarPopup {...props} entries={[{ label: t("renameSection"), icon: <IconCompose />, action: props.onEdit }, { label: t("removeSection"), icon: closeIcon, danger: true, action: props.onRemove }]} />;
}
