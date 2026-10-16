import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { AttachmentReceipt as Receipt } from "../hooks/attachment-receipts.ts";
import { attachmentProbeTarget } from "../hooks/attachment-preflight.ts";
import { useAttachmentReceiptCopy } from "./attachment-receipt-copy.ts";
import "./attachment-receipt.css";

export function AttachmentReceipt({ receipt, cwd, sessionId, client, onOpenFile, onLocate }: { receipt: Receipt; cwd?: string; sessionId?: string; client?: BridgeClient; onOpenFile?: (path: string) => void | Promise<void>; onLocate?: (toolId: string, ownerIndex?: number) => void }): React.JSX.Element {
	const copy = useAttachmentReceiptCopy();
	const [expanded, setExpanded] = useState(false);
	const [feedback, setFeedback] = useState<{ scope: object; pending?: boolean; error?: string }>();
	const key = JSON.stringify([cwd, sessionId, receipt.path]);
	const scope = useRef({ key, client, live: true });
	if (scope.current.key !== key || scope.current.client !== client) scope.current = { key, client, live: true };
	useEffect(() => { const instance = scope.current; instance.live = true; return () => { instance.live = false; }; }, [key, client]);
	const lock = useRef<{ scope: object } | undefined>(undefined);
	const target = cwd ? attachmentProbeTarget(receipt.path, cwd) : undefined;
	const visible = feedback?.scope === scope.current ? feedback : undefined;
	const open = async (): Promise<void> => {
		const instance = scope.current;
		if (lock.current?.scope === instance || !target || !client || (target.withinWorkspace && !onOpenFile)) return;
		const token = { scope: instance }; lock.current = token;
		setFeedback({ scope: instance, pending: true });
		try {
			const response = await client.request<{ isFile: boolean }>({ type: "fs.stat", cwd: target.cwd, path: target.path }); if (!response.ok) throw new Error(response.error); if (!response.result?.isFile) throw new Error(copy.notFile);
			if (scope.current !== instance || !instance.live) return;
			if (target.withinWorkspace) await onOpenFile!(target.path);
			else { const opened = await client.request({ type: "open.external", action: "url", target: target.fileUrl }); if (!opened.ok) throw new Error(opened.error); }
			if (scope.current === instance && instance.live) setFeedback(undefined);
		} catch (error) { if (scope.current === instance && instance.live) setFeedback({ scope: instance, error: error instanceof Error ? error.message : String(error) }); }
		finally { if (lock.current === token) lock.current = undefined; }
	};
	return <div className="owl-attachment-receipt" data-read-status={receipt.status}>
		<button type="button" className="owl-mention-chip owl-user-file" title={receipt.path} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span className="owl-mention-chip__label">{receipt.path.split(/[\\/]/).filter(Boolean).at(-1) ?? receipt.path}</span><span className="owl-attachment-state">{copy[receipt.status]}</span></button>
		{expanded && <div className="owl-attachment-receipt-detail">
			<p className="owl-attachment-path">{receipt.path}</p><p>{receipt.evidence.some((item) => item.status === "returned" || item.status === "partial") ? copy.noFull : receipt.evidence.length ? copy.recordOnly : copy.noEvidence}</p>
			<button type="button" disabled={!target || !client || (target.withinWorkspace && !onOpenFile) || visible?.pending} onClick={() => void open()}>{visible?.pending ? copy.opening : copy.open}</button>
			{!target && <p>{copy.outside}</p>}
			{visible?.error && <div role="alert">{visible.error} <button type="button" onClick={() => void open()}>{copy.retry}</button></div>}
			<ul>{receipt.evidence.map((evidence) => <li key={evidence.toolId}>
				<span>{copy[evidence.status]}</span>{evidence.note && <p>{copy[evidence.note]}</p>}
				{evidence.range && <p>{evidence.range.end !== undefined ? copy.range : copy.requested}: {evidence.range.start}{evidence.range.end !== undefined ? `–${evidence.range.end}` : ` ${copy.onward}`} {copy.lines}{evidence.range.limit ? ` · ${copy.limit} ${evidence.range.limit}` : ""}{evidence.range.total ? ` / ${evidence.range.total}` : ""}</p>}
				{evidence.error && <p className="owl-attachment-error">{evidence.error}</p>}
				{onLocate && <button type="button" onClick={() => onLocate(evidence.toolId, evidence.ownerIndex)}>{copy.locate} · {evidence.toolName}</button>}
			</li>)}</ul>
		</div>}
	</div>;
}
