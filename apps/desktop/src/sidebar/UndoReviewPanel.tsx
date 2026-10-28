import { DiffView } from "./DiffView.tsx";
import { useUndoCopy } from "./undo-copy.ts";
import type { UndoReview } from "./use-undo-review.ts";
import "./undo-review.css";

export function UndoReviewPanel({
	review,
	disabled = false,
}: {
	review: UndoReview;
	disabled?: boolean;
}): React.JSX.Element | null {
	const copy = useUndoCopy();
	if (review.preview === undefined && review.outcome === undefined && !review.busy) return null;
	const ready = review.preview?.files.some((file) => file.canRevert) ?? false;
	return (
		<div className="owl-undo-panel">
			{review.busy && <p role="status">{review.preview ? copy.applying : copy.loading}</p>}
			{review.preview !== undefined && (
				<section aria-label={copy.title}>
					<strong>{copy.title}</strong>
					<p>{copy.scope}</p>
					<ul className="owl-undo-files">
						{review.preview.files.map((file) => (
							<li key={file.path}>
								<div className="owl-undo-file">
									<code>{file.displayPath}</code>
									<span className={file.canRevert ? "is-ready" : "is-conflict"}>
										{file.canRevert ? copy.ready : copy.conflict}
									</span>
								</div>
								{file.reason && <p className="is-conflict">{file.reason}</p>}
								{file.canRevert && (
									<details>
										<summary>{copy.preview}</summary>
										{file.truncated && <p>{copy.truncated}</p>}
										<DiffView text={file.diff} />
									</details>
								)}
							</li>
						))}
					</ul>
					{!ready && <p className="is-conflict">{copy.noReady}</p>}
					<div className="owl-undo-actions">
						<button
							type="button"
							disabled={disabled || review.busy || !ready}
							onClick={() => void review.confirm()}
						>
							{copy.confirm}
						</button>
						{review.preview.files.some((file) => !file.canRevert) && (
							<button
								type="button"
								disabled={disabled || review.busy}
								onClick={() => void review.retryPreview()}
							>
								{copy.retry}
							</button>
						)}
						<button type="button" disabled={review.busy} onClick={review.dismiss}>
							{copy.cancel}
						</button>
					</div>
				</section>
			)}
			{review.outcome !== undefined && (
				<div role={review.outcome.failed.length > 0 || review.outcome.error ? "alert" : "status"}>
					<strong>
						{review.outcome.failed.length > 0 || review.outcome.error
							? copy.failed
							: review.outcome.action === "keep"
								? copy.kept
								: copy.success}
					</strong>
					<p>
						{copy.result}: {review.outcome.resolved}
					</p>
					{review.outcome.error && (
						<>
							<p className="is-conflict">{review.outcome.error}</p>
							<p>{copy.network}</p>
						</>
					)}
					{review.outcome.failed.length > 0 && (
						<ul>
							{review.outcome.failed.map((file, index) => (
								<li className="is-conflict" key={`${file.path}:${index}`}>
									<code>{file.path}</code>: {file.reason}
								</li>
							))}
						</ul>
					)}
					{review.outcome.warnings && review.outcome.warnings.length > 0 && (
						<div role="alert">
							<strong>{copy.warning}</strong>
							<ul>
								{review.outcome.warnings.map((file, index) => (
									<li key={`${file.path}:${index}`}>
										<code>{file.path}</code>: {file.reason}
									</li>
								))}
							</ul>
						</div>
					)}
					{review.outcome.retryIds.length > 0 && (
						<button type="button" disabled={disabled || review.busy} onClick={() => void review.retry()}>
							{copy.retry}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
