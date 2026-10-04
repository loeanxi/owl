import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProjectSidebarText } from "./project-sidebar-copy.ts";
import "./new-project-dialog.css";
import "./project-sidebar-dialog.css";

/** Project sections and bulk actions use the same focused dialog surface. */
export function ProjectSidebarDialog({ title, description, fieldLabel, initialValue = "", error, busy = false, confirmLabel, onSubmit, onClose }: {
	title: string; description?: string; fieldLabel?: string; initialValue?: string; error?: string; busy?: boolean;
	confirmLabel: string; onSubmit: (value: string) => void; onClose: () => void;
}): React.JSX.Element {
	const text = useProjectSidebarText();
	const id = useId();
	const [value, setValue] = useState(initialValue);
	const root = useRef<HTMLDivElement>(null);
	const close = useRef(onClose); close.current = onClose;
	const busyRef = useRef(busy); busyRef.current = busy;
	useEffect(() => {
		const previous = document.activeElement;
		root.current?.querySelector<HTMLElement>("input, button")?.focus();
		const key = (event: KeyboardEvent): void => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) close.current(); }
			if (event.key !== "Tab") return;
			const controls = [...(root.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') ?? [])];
			const first = controls[0]; const last = controls.at(-1);
			if (!first || !last) { event.preventDefault(); root.current?.focus(); return; }
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		};
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
	}, []);
	return createPortal(<div className="owl-project-backdrop"><div className="owl-project-dialog" ref={root} role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy} tabIndex={-1}>
		<header className="owl-project-dialog-heading"><h2 id={id}>{title}</h2><button type="button" className="owl-project-icon-button" disabled={busy} onClick={onClose} aria-label={text("close")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
		<form onSubmit={(event) => { event.preventDefault(); if (!busy && (fieldLabel === undefined || value.trim())) onSubmit(value.trim()); }}>
			{description && <p className="owl-project-dialog-description">{description}</p>}
			{fieldLabel && <label className="owl-project-section-name"><span>{fieldLabel}</span><input autoFocus value={value} maxLength={80} disabled={busy} onChange={(event) => setValue(event.target.value)} /></label>}
			{error && <p className="owl-project-error" role="alert">{error}</p>}
			<footer className="owl-project-dialog-footer"><button type="button" className="owl-project-text-button" onClick={onClose} disabled={busy}>{text("cancel")}</button><button type="submit" className="owl-project-primary-button" disabled={busy || (fieldLabel !== undefined && !value.trim())}>{busy ? text("working") : confirmLabel}</button></footer>
		</form>
	</div></div>, document.body);
}
