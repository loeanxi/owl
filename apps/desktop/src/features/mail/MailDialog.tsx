import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";

/** Local modal with focus containment and restoration for keyboard users. */
export function MailDialog({ title, children, onClose, busy = false }: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	busy?: boolean;
}): React.JSX.Element {
	const t = useT();
	const label = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	const busyRef = useRef(busy);
	closeRef.current = onClose;
	busyRef.current = busy;
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const root = dialog.current;
		if (!root) return;
		const focusable = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
		(focusable()[0] ?? root).focus();
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !busyRef.current) {
				event.preventDefault();
				event.stopPropagation();
				closeRef.current();
			} else if (event.key === "Tab") {
				const targets = focusable();
				const first = targets[0] ?? root;
				const last = targets.at(-1) ?? root;
				if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
					event.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	return <div className="owl-mail-modal">
		<div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={label} className="owl-mail-dialog">
			<div className="owl-mail-dialog-heading"><h2 id={label}>{title}</h2><button type="button" className="owl-mail-icon-button" aria-label={t("mail.close")} onClick={onClose} disabled={busy}>×</button></div>
			{children}
		</div>
	</div>;
}
