import { useEffect, useId, useRef, useState } from "react";
import type { DesktopSubagentSummary } from "../bridge/protocol.ts";
import { useSubagentText } from "./subagent-copy.ts";
import "./subagent-pin.css";

/** Subagent picker anchored beside the task-list entry in the conversation. */
export function SubagentPin({ runs, activeId, onSelect }: {
	runs: readonly DesktopSubagentSummary[];
	activeId?: string;
	onSelect: (id: string) => void;
}): React.JSX.Element | null {
	const copy = useSubagentText();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const panelId = useId();
	const visible = runs.length > 0;
	const running = runs.filter((run) => run.status === "running").length;
	const summary = `${copy.title} ${runs.length} · ${copy.statusRunning} ${running}`;
	const statusText = {
		running: copy.statusRunning, completed: copy.statusCompleted, failed: copy.statusFailed,
		paused: copy.statusPaused, stopped: copy.statusStopped, unknown: copy.statusUnknown,
	};

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		(panelRef.current?.querySelector<HTMLButtonElement>("button[aria-current='page']") ?? panelRef.current?.querySelector<HTMLButtonElement>(".owl-subagent-pin-row"))?.focus();
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		if (!visible) setOpen(false);
	}, [visible]);

	if (!visible) return null;

	return <div className="owl-subagent-anchor" ref={rootRef}>
		<button
			type="button"
			ref={triggerRef}
			className="owl-subagent-pin-trigger"
			data-running={running > 0 || undefined}
			aria-expanded={open}
			aria-haspopup="dialog"
			aria-controls={open ? panelId : undefined}
			aria-label={`${open ? copy.collapse : copy.expand} · ${summary}`}
			title={summary}
			onClick={() => setOpen((value) => !value)}
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
				<path d="M12 3v4M2 11v4M22 11v4" />
				<rect x="5" y="7" width="14" height="12" rx="3" />
				<path d="M9 11v2M15 11v2M9 16h6" />
			</svg>
			<span className="owl-subagent-pin-count">{runs.length}</span>
			{running > 0 && <span className="owl-subagent-pin-running"><span aria-hidden="true" />{running}</span>}
		</button>
		{open && <div id={panelId} ref={panelRef} className="owl-subagent-pin-popover" role="dialog" aria-label={copy.title}>
			<div className="owl-subagent-pin-header">
				<span className="owl-subagent-pin-title">{copy.title}</span>
				<span className="owl-subagent-pin-summary">{runs.length} · {copy.statusRunning} {running}</span>
				<button type="button" className="owl-subagent-pin-close" title={copy.collapse} aria-label={copy.collapse} onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
				</button>
			</div>
			<ul className="owl-subagent-pin-list">
				{runs.map((run) => <li key={run.id}>
					<button type="button" className="owl-subagent-pin-row" aria-current={run.id === activeId ? "page" : undefined} onClick={() => { setOpen(false); onSelect(run.id); }}>
						<span className="owl-subagent-pin-dot" data-status={run.status} aria-hidden="true" />
						<span className="owl-subagent-pin-copy">
							<span className="owl-subagent-pin-heading"><span className="owl-subagent-pin-name">{run.agent}</span><span className="owl-subagent-pin-status" data-status={run.status}>{statusText[run.status]}</span></span>
							<span className="owl-subagent-pin-task">{run.task}</span>
						</span>
					</button>
				</li>)}
			</ul>
		</div>}
	</div>;
}
