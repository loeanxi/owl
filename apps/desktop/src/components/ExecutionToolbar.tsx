import { useState, type ReactNode } from "react";
import { appKeybindingFromEvent, formatAppKeybinding } from "../app-keybindings.ts";
import { Menu } from "./Menu.tsx";
import { EXECUTION_VIEWS, type ExecutionView } from "./execution-view.ts";
import { useExecutionText } from "./execution-copy.ts";
import "./execution-toolbar.css";

export function ExecutionToolbar({ view, onView, shortcut, onShortcut, onTerminal, onTasks, onChanges, terminalOpen, changeCount, plan, collapsed, onToggleCollapsed }: {
	view: ExecutionView; onView: (view: ExecutionView) => void; shortcut?: string;
	onShortcut: (binding: string | undefined) => boolean;
	onTerminal: () => void; onTasks: () => void; onChanges: () => void;
	terminalOpen: boolean; changeCount?: number; plan: ReactNode;
	collapsed: boolean; onToggleCollapsed: () => void;
}): React.JSX.Element {
	const copy = useExecutionText();
	const [capturing, setCapturing] = useState(false);
	const [shortcutError, setShortcutError] = useState<string>();
	return <div className="owl-execution-controls">
		<div className={"owl-execution-toolbar" + (collapsed ? " is-collapsed" : "")} role="toolbar" aria-label={copy("viewMenu")}>
			{collapsed ? <button type="button" className="owl-execution-button" title={copy("expandToolbar")} aria-label={copy("expandToolbar")} aria-expanded="false" onClick={onToggleCollapsed}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
			: <>
				<Menu direction="down" triggerClassName="owl-execution-button" triggerTitle={copy("cycleView")} panelClassName="owl-execution-view-menu left-0" trigger={<><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" /></svg><span>{copy(view)} {copy("view")}</span><span aria-hidden="true">⌄</span></>}>
					{(close) => <>
						<div className="owl-execution-menu-heading"><span>{copy("viewMenu")}</span><kbd>{formatAppKeybinding(shortcut)}</kbd></div>
						<div role="menu" aria-label={copy("viewMenu")}>{EXECUTION_VIEWS.map((mode) => <button key={mode} type="button" role="menuitemradio" aria-checked={view === mode} className="owl-execution-view-option" onClick={() => { onView(mode); close(); }}><span aria-hidden="true">{view === mode ? "✓" : ""}</span><span><strong>{copy(mode)}</strong><small>{copy(`${mode}Desc`)}</small></span></button>)}</div>
						<p className="owl-execution-menu-note">{copy("globalPreference")}</p>
						<div className="owl-execution-shortcut">
							<button type="button" title={copy("shortcut")} onBlur={() => setCapturing(false)} onClick={() => { setCapturing(true); setShortcutError(undefined); }} onKeyDown={(event) => {
								if (!capturing) return;
								event.stopPropagation(); event.preventDefault();
								if (event.key === "Escape") { setCapturing(false); return; }
								if (["Control", "Alt", "Meta", "Shift"].includes(event.key)) return;
								const binding = appKeybindingFromEvent(event.nativeEvent);
								if (!binding) { setShortcutError(copy("shortcutInvalid")); return; }
								if (!onShortcut(binding)) { setShortcutError(copy("shortcutConflict")); return; }
								setCapturing(false); setShortcutError(undefined);
							}}>{capturing ? copy("pressShortcut") : copy("captureShortcut")}</button>
							<button type="button" onClick={() => { if (onShortcut(undefined)) { setCapturing(false); setShortcutError(undefined); } else setShortcutError(copy("shortcutConflict")); }}>{copy("resetShortcut")}</button>
						</div>
						{shortcutError && <p className="owl-execution-menu-note" role="alert">{shortcutError}</p>}
					</>}
				</Menu>
				<div className="owl-execution-actions">
					<button type="button" className="owl-execution-button" aria-label={copy("terminal")} aria-pressed={terminalOpen} onClick={onTerminal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 6 5 5-5 5M13 17h6" /></svg><span>{copy("terminal")}</span></button>
					<button type="button" className="owl-execution-button" aria-label={copy("tasks")} onClick={onTasks}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10M18 7a8 8 0 0 1-8 8H6" /></svg><span>{copy("tasks")}</span></button>
					<button type="button" className="owl-execution-button" aria-label={copy("changes")} onClick={onChanges}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8M16 3l5 5-10 10-5 1 1-5Z" /></svg><span>{copy("changes")}</span>{changeCount !== undefined && <b>{changeCount}</b>}</button>
					<button type="button" className="owl-execution-button" title={copy("collapseToolbar")} aria-label={copy("collapseToolbar")} aria-expanded="true" onClick={onToggleCollapsed}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>
				</div>
			</>}
		</div>
		{plan}
	</div>;
}
