import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getUiLanguage, useT } from "../i18n/index.ts";
import type { SidebarApi } from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { useDiffReviewText } from "./diff-review-copy.ts";
import {
	type DiffReviewComment,
	type DiffReviewMode,
	type DiffReviewTarget,
	diffCommentKey,
	formatDiffFeedback,
} from "./diff-review-model.ts";
import { ExecutionContext } from "./execution-context.tsx";
import { IconChevronDown, IconLoader, IconX } from "./icons.tsx";

export function DiffReview({
	api,
	cwd,
	selected,
	diff,
	loading,
	error,
	expanded,
	focusLine,
	onFocusLineHandled,
	onExpand,
	onClose,
	onOpenFile,
	onSelectFile,
}: {
	api: SidebarApi;
	cwd: string;
	selected?: { path: string; staged: boolean };
	diff?: string;
	loading: boolean;
	error?: string;
	expanded: boolean;
	/** 模型点名要看的差异行（sidebar_show action=diff 带行号）：差异载入后落到那一行。 */
	focusLine?: number;
	/** 这一行已经处理完（无论找到没有），由上层清掉请求。 */
	onFocusLineHandled?: () => void;
	onExpand: () => void;
	onClose: () => void;
	onOpenFile: (path: string) => void;
	/** 意见跨文件核对用：把面板切到另一个文件（ChangesTab 传 openDiff）。缺省时只能定位当前文件的意见。 */
	onSelectFile?: (path: string, staged: boolean) => void;
}): React.JSX.Element | null {
	const t = useT();
	const copy = useDiffReviewText();
	const execution = useContext(ExecutionContext);
	const [mode, setMode] = useState<DiffReviewMode>("diff");
	const [comments, setComments] = useState<DiffReviewComment[]>([]);
	const [editing, setEditing] = useState<{
		target: DiffReviewTarget;
		snapshot: string;
		path: string;
		staged: boolean;
	}>();
	const [draft, setDraft] = useState("");
	const [sendError, setSendError] = useState<string>();
	const [sent, setSent] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const sequence = useRef(0);
	const lifecycle = useRef(0);
	const rootRef = useRef<HTMLElement>(null);
	const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pendingJump = useRef<string | undefined>(undefined);
	const [changeCursor, setChangeCursor] = useState(-1);
	const [changeTotal, setChangeTotal] = useState(0);
	useEffect(() => {
		lifecycle.current += 1;
		return () => {
			lifecycle.current += 1;
		};
	}, []);
	// 滚动到目标行并闪一次强调色：评论回跳与 Alt+↑/↓ 变更块导航共用。
	const flash = (element: HTMLElement | undefined | null): void => {
		if (!element) return;
		if (typeof element.scrollIntoView === "function")
			element.scrollIntoView({ block: "center", behavior: "instant" });
		element.classList.remove("owl-diff-flash");
		// 强制重排后再挂类：连续跳转同一行也能重启动画。
		void element.offsetWidth;
		element.classList.add("owl-diff-flash");
		clearTimeout(flashTimer.current);
		flashTimer.current = setTimeout(() => element.classList.remove("owl-diff-flash"), 1000);
	};
	const findByTargetKey = (key: string): HTMLElement | undefined =>
		[...(rootRef.current?.querySelectorAll<HTMLElement>("[data-diff-target]") ?? [])].find(
			(node) => node.dataset.diffTarget === key,
		);
	const jumpToComment = (comment: DiffReviewComment): void => {
		const key = diffCommentKey(comment.target);
		if (selected !== undefined && (comment.requestPath !== selected.path || comment.staged !== selected.staged)) {
			// 跨文件意见：先切文件，diff 装载完成后由 pendingJump 落到那一行。
			if (!onSelectFile) return;
			pendingJump.current = key;
			onSelectFile(comment.requestPath, comment.staged);
			return;
		}
		flash(findByTargetKey(key));
	};
	useLayoutEffect(() => {
		if (pendingJump.current === undefined || loading || diff === undefined) return;
		const node = findByTargetKey(pendingJump.current);
		pendingJump.current = undefined;
		// 目标行不存在（意见指向的行已不在）就安静放弃，不打断阅读。
		flash(node);
	}, [selected?.path, selected?.staged, diff, loading]);
	// 模型点名要看的差异行：差异载入后落到那一行并闪一下（找不到就安静放弃）。
	useLayoutEffect(() => {
		if (focusLine === undefined || loading || diff === undefined || selected === undefined) return;
		const newKey = diffCommentKey({ path: selected.path, side: "new", line: focusLine });
		const oldKey = diffCommentKey({ path: selected.path, side: "old", line: focusLine });
		const node = findByTargetKey(newKey) ?? findByTargetKey(oldKey);
		onFocusLineHandled?.();
		flash(node);
	}, [focusLine, diff, loading, selected?.path, selected?.staged]);
	// 变更块计数与光标跟随当前 diff 与视图模式；Alt+↑/↓ 在块之间循环跳转。
	useLayoutEffect(() => {
		setChangeTotal(rootRef.current?.querySelectorAll("[data-diff-change]").length ?? 0);
		setChangeCursor(-1);
	}, [selected?.path, diff, loading, mode]);
	const navigate = (delta: 1 | -1): void => {
		const marks = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-diff-change]") ?? [])];
		if (marks.length === 0) return;
		setChangeCursor((current) => {
			const next = (current + delta + marks.length) % marks.length;
			flash(marks[next]!);
			return next;
		});
	};
	const editingCurrent =
		editing &&
		selected &&
		editing.path === selected.path &&
		editing.staged === selected.staged &&
		editing.snapshot === diff &&
		!loading
			? editing
			: undefined;
	// 意见按文件分组（保持首次出现顺序），组头点击切到那个文件并落到第一条意见。
	const commentGroups = useMemo<[string, DiffReviewComment[]][]>(() => {
		const map = new Map<string, DiffReviewComment[]>();
		for (const comment of comments) {
			const group = map.get(comment.requestPath) ?? [];
			group.push(comment);
			map.set(comment.requestPath, group);
		}
		return [...map.entries()];
	}, [comments]);
	if (!selected && comments.length === 0) return null;

	const cancelEdit = (): void => {
		setEditing(undefined);
		setDraft("");
		trigger.current?.focus({ preventScroll: true });
	};
	const send = async (): Promise<void> => {
		if (busyRef.current || comments.length === 0 || !execution.onSubmitFeedback || !execution.sessionId) return;
		busyRef.current = true;
		setBusy(true);
		setSendError(undefined);
		const revision = lifecycle.current;
		const pending = [...comments];
		try {
			const unique = new Map(
				pending.map((comment) => [JSON.stringify([comment.requestPath, comment.staged]), comment]),
			);
			const current = await Promise.all(
				[...unique.values()].map(async (comment) => ({
					comment,
					diff: await api.gitDiff(cwd, comment.requestPath, comment.staged),
				})),
			);
			if (lifecycle.current !== revision) return;
			if (
				current.some((item) =>
					pending.some(
						(comment) =>
							comment.requestPath === item.comment.requestPath &&
							comment.staged === item.comment.staged &&
							comment.snapshot !== item.diff,
					),
				)
			)
				throw new Error(copy("changed"));
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

	return (
		<section
			ref={rootRef}
			className={`owl-diff-review ${selected ? (expanded ? "is-expanded" : "") : "comments-only"}`}
			onKeyDown={(event) => {
				if (!event.altKey || event.nativeEvent.isComposing || event.repeat) return;
				if (event.key === "ArrowDown") {
					event.preventDefault();
					event.stopPropagation();
					navigate(1);
				} else if (event.key === "ArrowUp") {
					event.preventDefault();
					event.stopPropagation();
					navigate(-1);
				}
			}}
		>
			<header className="owl-diff-review-header">
				<span className="min-w-0 flex-1 truncate" title={selected?.path}>
					{selected?.path ?? copy("draft")}
				</span>
				{selected && (
					<>
						<button
							type="button"
							className="owl-diff-quiet"
							title={copy("openFile")}
							onClick={() => onOpenFile(selected.path)}
						>
							{copy("openFile")}
						</button>
						<button
							type="button"
							className="owl-diff-quiet"
							aria-label={expanded ? t("common.collapse") : t("common.expand")}
							onClick={onExpand}
						>
							<IconChevronDown size={13} className={expanded ? "rotate-180" : ""} />
						</button>
						<button type="button" className="owl-diff-quiet" aria-label={t("window.close")} onClick={onClose}>
							<IconX size={13} />
						</button>
					</>
				)}
			</header>
			{selected && (
				<div className="owl-diff-review-modes" role="group" aria-label={copy("diff")}>
					{(["diff", "before", "after"] as const).map((value) => (
						<button
							type="button"
							key={value}
							aria-pressed={mode === value}
							onClick={() => {
								setMode(value);
								cancelEdit();
							}}
						>
							{copy(value)}
						</button>
					))}
					<span>{copy("fragments")}</span>
					{changeTotal > 0 && (
						<span className="owl-diff-change-count" title="Alt+↓/↑">
							{changeCursor >= 0 ? `${changeCursor + 1}/${changeTotal}` : String(changeTotal)}
						</span>
					)}
				</div>
			)}
			<div className="owl-diff-review-body">
				{loading ? (
					<div className="owl-diff-review-message">
						<IconLoader size={13} className="animate-spin" />
						{t("changes.readingDiff")}
					</div>
				) : error ? (
					<div role="alert" className="owl-diff-review-error">
						{error}
					</div>
				) : selected && diff !== undefined ? (
					<DiffView
						text={diff}
						mode={mode}
						comments={comments}
						onComment={
							busy
								? undefined
								: (target, element) => {
										trigger.current = element;
										setEditing({ target, snapshot: diff, path: selected.path, staged: selected.staged });
										setDraft("");
										setSent(false);
									}
						}
					/>
				) : null}
				{editingCurrent && (
					<div className="owl-diff-comment-editor">
						<label>
							<span>
								{editingCurrent.target.path} ·{" "}
								{copy(editingCurrent.target.side === "old" ? "oldLine" : "newLine", {
									n: editingCurrent.target.line,
								})}
							</span>
							<textarea
								autoFocus
								disabled={busy}
								aria-label={copy("comment")}
								placeholder={copy("placeholder")}
								value={draft}
								maxLength={4000}
								onChange={(event) => setDraft(event.target.value)}
							/>
						</label>
						<div>
							<button type="button" className="owl-diff-quiet" onClick={cancelEdit}>
								{copy("cancel")}
							</button>
							<button
								type="button"
								className="owl-diff-action"
								disabled={busy || !draft.trim()}
								onClick={() => {
									setComments((value) => [
										...value,
										{
											id: ++sequence.current,
											target: editingCurrent.target,
											text: draft.trim(),
											staged: editingCurrent.staged,
											requestPath: editingCurrent.path,
											snapshot: editingCurrent.snapshot,
										},
									]);
									setSent(false);
									cancelEdit();
								}}
							>
								{copy("add")}
							</button>
						</div>
					</div>
				)}
				{comments.length > 0 && (
					<ul className="owl-diff-comment-list">
						{commentGroups.map(([path, items]) => (
							<li key={path} className="owl-diff-comment-group">
								<button
									type="button"
									className="owl-diff-comment-group-head"
									title={copy("locate")}
									onClick={() => jumpToComment(items[0]!)}
								>
									<span className="min-w-0 flex-1 truncate text-left">{path}</span>
									<span aria-hidden="true">{items.length}</span>
								</button>
								<ul>
									{items.map((comment) => (
										<li key={comment.id}>
											<button
												type="button"
												className="owl-diff-comment-locate"
												title={copy("locate")}
												onClick={() => jumpToComment(comment)}
											>
												<strong>
													{comment.target.path} ·{" "}
													{copy(comment.target.side === "old" ? "oldLine" : "newLine", {
														n: comment.target.line,
													})}
												</strong>
												<p>{comment.text}</p>
											</button>
											<button
												type="button"
												className="owl-diff-quiet"
												disabled={busy}
												aria-label={copy("remove")}
												onClick={() =>
													setComments((value) => value.filter((item) => item.id !== comment.id))
												}
											>
												<IconX size={12} />
											</button>
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				)}
			</div>
			{(comments.length > 0 || sent || sendError) && (
				<footer className="owl-diff-review-footer">
					<span role="status">
						{sent ? copy("sent") : busy ? copy("checking") : copy("count", { n: comments.length })}
					</span>
					<button
						type="button"
						className="owl-diff-action"
						disabled={busy || comments.length === 0 || !execution.onSubmitFeedback || !execution.sessionId}
						title={!execution.sessionId ? copy("noSession") : undefined}
						onClick={() => void send()}
					>
						{busy ? copy("sending") : copy("send")}
					</button>
					{sendError && (
						<p role="alert" className="owl-diff-review-error">
							{sendError}
						</p>
					)}
				</footer>
			)}
		</section>
	);
}
