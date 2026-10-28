import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { IconSearch } from "./icons.tsx";
import { SessionSearchPanel, type SessionSearchPanelProps } from "./SessionSearchPanel.tsx";
import { useSessionSearchText } from "./session-search-copy.ts";
import "./session-search-dialog.css";

export type SessionSearchDialogProps = SessionSearchPanelProps & {
	onQueryChange: (query: string) => void;
	onClose: () => void;
	placeholder?: string;
};

/** Search keeps its own focus and scrolling surface while the sidebar remains available after closing. */
export function SessionSearchDialog({
	query,
	onQueryChange,
	onClose,
	placeholder,
	...panelProps
}: SessionSearchDialogProps): React.JSX.Element {
	const text = useSessionSearchText();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		const previous = document.activeElement;
		inputRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.isComposing) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const dialog = dialogRef.current;
			const controls = [
				...(dialog?.querySelectorAll<HTMLElement>(
					'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
				) ?? []),
			].filter((element) => element.tabIndex >= 0 && !element.hidden && element.getClientRects().length > 0);
			const first = controls[0];
			const last = controls.at(-1);
			if (!first || !last) {
				event.preventDefault();
				dialog?.focus();
			} else if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
			} else if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		const onFocusIn = (event: FocusEvent): void => {
			if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) inputRef.current?.focus();
		};
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("focusin", onFocusIn);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("focusin", onFocusIn);
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
		};
	}, []);

	return createPortal(
		<div
			className="owl-session-search-backdrop"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				className="owl-session-search-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
			>
				<header className="owl-session-search-dialog-heading">
					<h2 id={titleId}>{text("title")}</h2>
					<button
						type="button"
						className="owl-session-search-dialog-icon owl-session-search-dialog-close"
						aria-label={text("close")}
						title={text("close")}
						onClick={onClose}
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
							<path d="m6 6 12 12M18 6 6 18" />
						</svg>
					</button>
				</header>
				<div className="owl-session-search-dialog-control">
					<IconSearch className="owl-session-search-dialog-search-icon" />
					<input
						ref={inputRef}
						type="text"
						className="owl-sidebar-search-input owl-session-search-dialog-input"
						aria-label={placeholder ?? text("placeholder")}
						placeholder={placeholder ?? text("placeholder")}
						autoComplete="off"
						spellCheck={false}
						value={query}
						onInput={(event) => onQueryChange(event.currentTarget.value)}
					/>
					{query && (
						<button
							type="button"
							className="owl-session-search-dialog-icon owl-session-search-dialog-clear"
							aria-label={text("clear")}
							title={text("clear")}
							onClick={() => {
								onQueryChange("");
								inputRef.current?.focus();
							}}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
								<path d="m6 6 12 12M18 6 6 18" />
							</svg>
						</button>
					)}
				</div>
				<div className="owl-session-search-dialog-results">
					{query.trim() ? (
						<SessionSearchPanel {...panelProps} query={query} />
					) : (
						<p className="owl-session-search-dialog-empty">{text("start")}</p>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
