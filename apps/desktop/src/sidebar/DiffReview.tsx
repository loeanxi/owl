import { useContext, useEffect, useRef, useState } from "react";
import { getUiLanguage, useT } from "../i18n/index.ts";
import type { SidebarApi } from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { ExecutionContext } from "./execution-context.tsx";
import { formatDiffFeedback, type DiffReviewComment, type DiffReviewMode, type DiffReviewTarget } from "./diff-review-model.ts";
import { useDiffReviewText } from "./diff-review-copy.ts";
import { IconChevronDown, IconLoader, IconX } from "./icons.tsx";

export function DiffReview({ api, cwd, selected, diff, loading, error, expanded, onExpand, onClose, onOpenFile }: {
	api: SidebarApi;
	cwd: string;
	selected?: { path: string; staged: boolean };
	diff?: string;
	loading: boolean;
	error?: string;
	expanded: boolean;
	onExpand: () => void;
	onClose: () => void;
	onOpenFile: (path: string) => void;
}): React.JSX.Element | null {
	const t = useT();
	const copy = useDiffReviewText();
	const execution = useContext(ExecutionContext);
	const [mode, setMode] = useState<DiffReviewMode>("diff");
	const [comments, setComments] = useState<DiffReviewComment[]>([]);
	const [editing, setEditing] = useState<{ target: DiffReviewTarget; snapshot: string; path: string; staged: boolean }>();
	const [draft, setDraft] = useState("");
	const [sendError, setSendError] = useState<string>();
	const [sent, setSent] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const sequence = useRef(0);
	const lifecycle = useRef(0);
	useEffect(() => { lifecycle.current += 1; return () => { lifecycle.current += 1; }; }, []);
	const editingCurrent = editing && selected && editing.path === selected.path && editing.staged === selected.staged && editing.snapshot === diff && !loading ? editing : undefined;
	if (!selected && comments.length === 0) return null;

	const cancelEdit = (): void => { setEditing(undefined); setDraft(""); trigger.current?.focus({ preventScroll: true }); };
	const send = async (): Promise<void> => {
		if (busyRef.current || comments.length === 0 || !execution.onSubmitFeedback || !execution.sessionId) return;
		busyRef.current = true;
		setBusy(true);
		setSendError(undefined);
		const revision = lifecycle.current;
		const pending = [...comments];
		try {
			const unique = new Map(pending.map((comment) => [JSON.stringify([comment.requestPath, comment.staged]), comment]));
			const current = await Promise.all([...unique.values()].map(async (comment) => ({ comment, diff: await api.gitDiff(cwd, comment.requestPath, comment.staged) })));
			if (lifecycle.current !== revision) return;
			if (current.some((item) => pending.some((comment) => comment.requestPath === item.comment.requestPath && comment.staged === item.comment.staged && comment.snapshot !== item.diff))) throw new Error(copy("changed"));
			const accepted = await execution.onSubmitFeedback(formatDiffFeedback(pending, getUiLanguage() === "en"));
			if (lifecycle.current !== revision) return;
			if (!accepted) throw new Error(copy("failed"));
			const ids = new Set(pending.map((comment) => comment.id));
			setComments((value) => value.filter((comment) => !ids.has(comment.id)));
			setSent(true);
		} catch (failure) {
			if (lifecycle.current === revision) setSendError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			busyRef.current = false;
			if (lifecycle.current === revision) setBusy(false);
		}
	};

	return <section className={`owl-diff-review ${selected ? expanded ? "is-expanded" : "" : "comments-only"}`}>
		<header className="owl-diff-review-header">
			<span className="min-w-0 flex-1 truncate" title={selected?.path}>{selected?.path ?? copy("draft")}</span>
			{selected && <><button type="button" className="owl-diff-quiet" title={copy("openFile")} onClick={() => onOpenFile(selected.path)}>{copy("openFile")}</button><button type="button" className="owl-diff-quiet" aria-label={expanded ? t("common.collapse") : t("common.expand")} onClick={onExpand}><IconChevronDown size={13} className={expanded ? "rotate-180" : ""} /></button><button type="button" className="owl-diff-quiet" aria-label={t("window.close")} onClick={onClose}><IconX size={13} /></button></>}
		</header>
		{selected && <div className="owl-diff-review-modes" role="group" aria-label={copy("diff")}>{(["diff", "before", "after"] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value} onClick={() => { setMode(value); cancelEdit(); }}>{copy(value)}</button>)}<span>{copy("fragments")}</span></div>}
		<div className="owl-diff-review-body">
			{loading ? <div className="owl-diff-review-message"><IconLoader size={13} className="animate-spin" />{t("changes.readingDiff")}</div> : error ? <div role="alert" className="owl-diff-review-error">{error}</div> : selected && diff !== undefined ? <DiffView text={diff} mode={mode} comments={comments} onComment={busy ? undefined : (target, element) => { trigger.current = element; setEditing({ target, snapshot: diff, path: selected.path, staged: selected.staged }); setDraft(""); setSent(false); }} /> : null}
			{editingCurrent && <div className="owl-diff-comment-editor">
				<label><span>{editingCurrent.target.path} · {copy(editingCurrent.target.side === "old" ? "oldLine" : "newLine", { n: editingCurrent.target.line })}</span><textarea autoFocus disabled={busy} aria-label={copy("comment")} placeholder={copy("placeholder")} value={draft} maxLength={4000} onChange={(event) => setDraft(event.target.value)} /></label>
				<div><button type="button" className="owl-diff-quiet" onClick={cancelEdit}>{copy("cancel")}</button><button type="button" className="owl-diff-action" disabled={busy || !draft.trim()} onClick={() => { setComments((value) => [...value, { id: ++sequence.current, target: editingCurrent.target, text: draft.trim(), staged: editingCurrent.staged, requestPath: editingCurrent.path, snapshot: editingCurrent.snapshot }]); setSent(false); cancelEdit(); }}>{copy("add")}</button></div>
			</div>}
			{comments.length > 0 && <ul className="owl-diff-comment-list">{comments.map((comment) => <li key={comment.id}><div><strong>{comment.target.path} · {copy(comment.target.side === "old" ? "oldLine" : "newLine", { n: comment.target.line })}</strong><p>{comment.text}</p></div><button type="button" className="owl-diff-quiet" disabled={busy} aria-label={copy("remove")} onClick={() => setComments((value) => value.filter((item) => item.id !== comment.id))}><IconX size={12} /></button></li>)}</ul>}
		</div>
		{(comments.length > 0 || sent || sendError) && <footer className="owl-diff-review-footer"><span role="status">{sent ? copy("sent") : busy ? copy("checking") : copy("count", { n: comments.length })}</span><button type="button" className="owl-diff-action" disabled={busy || comments.length === 0 || !execution.onSubmitFeedback || !execution.sessionId} title={!execution.sessionId ? copy("noSession") : undefined} onClick={() => void send()}>{busy ? copy("sending") : copy("send")}</button>{sendError && <p role="alert" className="owl-diff-review-error">{sendError}</p>}</footer>}
	</section>;
}
