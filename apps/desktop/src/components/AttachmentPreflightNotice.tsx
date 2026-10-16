import type { AttachmentIssue } from "../hooks/attachment-preflight.ts";
import { useAttachmentPreflightCopy } from "./attachment-preflight-copy.ts";
import "./attachment-preflight.css";
import "./composer-feedback.css";

export function AttachmentPreflightNotice({ checking, issues, onRemove, onRetry }: { checking: boolean; issues: readonly AttachmentIssue[]; onRemove: (path: string) => void; onRetry: () => void }): React.JSX.Element | null {
	const copy = useAttachmentPreflightCopy();
	if (!checking && issues.length === 0) return null;
	const records = issues.map((issue) => ({ ...issue, basename: issue.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || issue.path }));
	const first = records[0];
	const compactReason = first?.reason.replace(/\s+/g, " ").trim() ?? "";
	return <div className="owl-attachment-preflight" role={checking ? "status" : "alert"} aria-busy={checking}>
		<div className="owl-composer-notice-head">
			<div className="owl-composer-notice-summary">
				<strong>{checking ? copy.checking : records.length === 1 ? first?.basename : copy.failedCount.replace("{n}", String(records.length))}</strong>
				{first && <span>{checking ? `${copy.recheckCount.replace("{n}", String(records.length))} · ${first.basename}: ` : records.length > 1 ? `${first.basename}: ` : ""}{compactReason.length > 120 ? `${compactReason.slice(0, 120)}…` : compactReason}</span>}
			</div>
			{first && <div className="owl-composer-notice-actions">
				{records.length === 1 && <button type="button" disabled={checking} onClick={() => onRemove(first.path)}>{copy.remove}</button>}
				<button type="button" disabled={checking} onClick={onRetry}>{copy.retry}</button>
			</div>}
		</div>
		{first && <details className="owl-composer-notice-details">
			<summary>{copy.details.replace("{n}", String(records.length))}</summary>
			<div className="owl-composer-notice-body">
				<p>{copy.failed}</p>
				<ul>{records.map((issue) => <li key={issue.path}><div><code>{issue.path}</code><p>{issue.reason}</p></div>{records.length > 1 && <button type="button" disabled={checking} aria-label={`${copy.remove}: ${issue.basename}`} onClick={() => onRemove(issue.path)}>{copy.remove}</button>}</li>)}</ul>
				<p>{copy.hint}</p>
			</div>
		</details>}
	</div>;
}
