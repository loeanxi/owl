import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { PermissionRequest } from "../bridge/protocol.ts";
import { usePendingResponses } from "../bridge/pending-responses.ts";
import { useT } from "../i18n/index.ts";
import { describeToolInput } from "../hooks/summarize.ts";
import { PendingResponseNotice } from "./PendingResponseNotice.tsx";
import { usePendingRequestCopy } from "./pending-request-copy.ts";
import { usePermissionDialogText } from "./permission-dialog-copy.ts";
import { permissionActionTitle } from "./permission-presentation.ts";
import "./pending-request.css";
import "./permission-dialog.css";

export function PermissionDialog({
	request,
	contextLabel,
	workspace,
	onLater,
	onDecide,
}: {
	request: PermissionRequest;
	contextLabel?: string;
	workspace?: string;
	onLater?: () => void;
	onDecide: (approved: boolean) => void;
}): React.JSX.Element {
	const t = useT();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const sourceRef = useRef<HTMLDetailsElement>(null);
	const openerRef = useRef<HTMLElement | null>(null);
	const submitting = useRef(false);
	const copy = usePendingRequestCopy();
	const dialogCopy = usePermissionDialogText();
	const { controller, feedback } = usePendingResponses();
	const responseFeedback = feedback.get(request.requestId);
	const busy = responseFeedback?.phase === "pending";
	const workspacePath = workspace?.trim() ? workspace : undefined;
	const workspaceName = workspacePath?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || workspacePath;
	const rawInput = JSON.stringify(request.input, null, 2) ?? String(request.input);
	useLayoutEffect(() => {
		const previous = document.activeElement;
		if (previous instanceof HTMLElement && !dialogRef.current?.contains(previous)) openerRef.current = previous;
		return () => { if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true }); };
	}, []);
	useLayoutEffect(() => {
		if (bodyRef.current) bodyRef.current.scrollTop = 0;
		if (sourceRef.current) sourceRef.current.open = false;
		submitting.current = false;
		dialogRef.current?.focus({ preventScroll: true });
	}, [request.requestId, request.sessionId]);
	useLayoutEffect(() => {
		if (responseFeedback?.phase && bodyRef.current) bodyRef.current.scrollTop = 0;
	}, [request.requestId, responseFeedback?.phase, responseFeedback?.error]);
	useEffect(() => { if (!busy) submitting.current = false; }, [busy]);
	const decide = (approved: boolean): void => {
		if (busy || submitting.current || controller?.getSnapshot().get(request.requestId)?.phase === "pending") return;
		submitting.current = true;
		// Keep keyboard focus in the reading area before the clicked action becomes disabled.
		bodyRef.current?.focus({ preventScroll: true });
		try { onDecide(approved); }
		finally { if (controller?.getSnapshot().get(request.requestId)?.phase !== "pending") submitting.current = false; }
	};
	return (
		<div className="owl-permission-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50" onKeyDown={(event) => { if (event.key === "Escape" && onLater) { event.preventDefault(); event.stopPropagation(); onLater(); } }}>
			<div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} className="owl-permission-dialog owl-permission-review" onKeyDown={(event) => {
				if (event.key !== "Tab") return;
				const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')].filter((element) => {
					if (element.matches(':disabled, [aria-disabled="true"], input[type="hidden"]') || element.closest('[hidden], [inert]') || (element.hasAttribute("tabindex") && element.tabIndex < 0)) return false;
					let ancestor = element.parentElement;
					while (ancestor && ancestor !== event.currentTarget) {
						if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) {
							const summary = [...ancestor.children].find((child) => child.tagName === "SUMMARY");
							if (!summary?.contains(element)) return false;
						}
						ancestor = ancestor.parentElement;
					}
					return true;
				});
				const first = focusable[0]; const last = focusable.at(-1);
				if (document.activeElement === event.currentTarget || !event.currentTarget.contains(document.activeElement)) {
					event.preventDefault(); (event.shiftKey ? last : first)?.focus();
				} else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
			}}>
				<header className="owl-permission-head">
					<h2 id={titleId} className="owl-permission-title">{permissionActionTitle(request.toolName, request.input)}</h2>
					<div className="owl-permission-scope">
						<span className="owl-permission-workspace-label">{copy.workspace}</span>
						<strong className="owl-permission-workspace-name">{workspaceName ?? copy.unknownWorkspace}</strong>
						{workspacePath && <span className="owl-permission-workspace-path" title={workspacePath}>{workspacePath}</span>}
					</div>
				</header>
				<div ref={bodyRef} className="owl-permission-body" tabIndex={0} role="region" aria-label={dialogCopy("readingRegion")}>
					<PendingResponseNotice requestId={request.requestId} />
					<section className="owl-permission-input">
						<h3 className="owl-permission-input-label">{dialogCopy(request.toolName === "edit" ? "changePreview" : "input")}</h3>
						<pre className="owl-permission-input-text">{describeToolInput(request.toolName, request.input)}</pre>
					</section>
					<details ref={sourceRef} className="owl-permission-source">
						<summary>{dialogCopy("source")}</summary>
						<dl className="owl-permission-source-fields">
							<dt>{dialogCopy("tool")}</dt><dd>{request.toolName}</dd>
							<dt>{copy.workspace}</dt><dd>{workspacePath ?? copy.unknownWorkspace}</dd>
							<dt>{copy.session}</dt><dd>{contextLabel && <span>{contextLabel} · </span>}<code>{request.sessionId}</code></dd>
						</dl>
						<h3 className="owl-permission-input-label">{dialogCopy("fullInput")}</h3>
						<pre className="owl-permission-raw-input">{rawInput}</pre>
					</details>
				</div>
				<footer className="owl-permission-foot">
					{onLater && <button type="button" className="owl-permission-action later" onClick={onLater}>{copy.later}</button>}
					{busy && <button type="button" disabled className="owl-permission-action sending">{copy.sending}</button>}
					<button
						type="button"
						disabled={busy}
						className="owl-permission-action deny"
						onClick={() => decide(false)}
					>
						{t("perm.deny")}
					</button>
					<button
						type="button"
						disabled={busy}
						className="owl-permission-action allow"
						onClick={() => decide(true)}
					>
						{t("perm.allow")}
					</button>
				</footer>
			</div>
		</div>
	);
}
