/**
 * 一段 unified diff 的只读渲染（红删绿增 + 行内字符级高亮）。
 *
 * 从 ChangesTab 抽出的共享组件：改动审批（ReviewTab）与文件变动（ChangesTab）
 * 共用同一套 diff 视觉（parseUnifiedDiff + annotateCharDiff，VS Code 同款）。
 */
import { useMemo } from "react";
import { t } from "../i18n/index.ts";
import { annotateCharDiff, parseUnifiedDiff, type DiffFile } from "./diff.ts";
import { diffCommentKey, type DiffReviewComment, type DiffReviewMode, type DiffReviewTarget } from "./diff-review-model.ts";
import { useDiffReviewText } from "./diff-review-copy.ts";
import "./diff-review.css";

export function DiffView({ text, mode = "diff", comments = [], onComment }: {
	text: string;
	mode?: DiffReviewMode;
	comments?: readonly DiffReviewComment[];
	onComment?: (target: DiffReviewTarget, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
	const copy = useDiffReviewText();
	const files = useMemo<DiffFile[]>(() => {
		const parsed = parseUnifiedDiff(text);
		for (const file of parsed) {
			for (const hunk of file.hunks) annotateCharDiff(hunk);
		}
		return parsed;
	}, [text]);
	if (files.length === 0) {
		return <div className="px-3 py-2 text-xs text-owl-faint">{t("changes.noDiff")}</div>;
	}
	// 变更块序号在渲染期顺序递增（JSX 求值深度优先，text+mode 不变则序号稳定），
	// 供审查面板做 Alt+↑/↓ 跳转与 n/m 计数；只标每段连续增删行的第一行。
	let changeRun = 0;
	return (
		<div className="font-mono text-[11.5px] leading-[1.5]">
			{files.map((file) => (
				<div key={`${file.path}-${file.isNew ? "n" : ""}${file.isDeleted ? "d" : ""}`} className="mb-3">
					<div className="sticky top-0 z-10 flex items-center gap-2 border-y border-owl-border/40 bg-owl-panel/95 px-3 py-1 backdrop-blur">
						<span className="truncate text-[11px] text-owl-text" title={file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}>
							{file.isNew && <span className="mr-1.5 rounded bg-emerald-500/20 px-1 text-status-added">{t("changes.new")}</span>}
							{file.isDeleted && <span className="mr-1.5 rounded bg-red-500/20 px-1 text-status-deleted">{t("changes.deleted")}</span>}
							{file.isRename && <span className="mr-1.5 rounded bg-sky-500/20 px-1 text-status-renamed">{t("changes.renamed")}</span>}
							{file.path}
						</span>
					</div>
					{file.hunks.map((hunk, hunkIndex) => (
						<div key={hunkIndex}>
							<div className="bg-owl-panel/60 px-3 py-0.5 text-owl-faint">{hunk.header}</div>
							{hunk.lines.filter((line) => mode === "diff" || (mode === "before" ? line.type !== "add" : line.type !== "del")).map((line, lineIndex, visible) => {
								const side = mode === "before" || line.newNo === undefined ? "old" : "new";
								const number = side === "old" ? line.oldNo : line.newNo;
								const target: DiffReviewTarget | undefined = number === undefined ? undefined : { path: side === "old" ? file.oldPath ?? file.path : file.path, side, line: number };
								const notes = target ? comments.filter((comment) => comment.snapshot === text && diffCommentKey(comment.target) === diffCommentKey(target)) : [];
								const runStart = (line.type === "add" || line.type === "del") && (lineIndex === 0 || (visible[lineIndex - 1]!.type !== "add" && visible[lineIndex - 1]!.type !== "del"));
								return <div key={lineIndex} data-diff-target={target ? diffCommentKey(target) : undefined} data-diff-change={runStart ? changeRun++ : undefined}>
								<div
									key={lineIndex}
									className={`flex ${line.type === "add" ? "bg-emerald-500/10" : line.type === "del" ? "bg-red-500/10" : ""}`}
								>
									{onComment && target && <button type="button" className="owl-diff-comment-line" title={copy("comment")} aria-label={`${copy("comment")} · ${target.path} · ${copy(target.side === "old" ? "oldLine" : "newLine", { n: target.line })}`} onClick={(event) => onComment(target, event.currentTarget)}>+</button>}
									<span className="w-10 shrink-0 pr-1 text-right text-owl-faint/60 select-none">{line.oldNo ?? ""}</span>
									<span className="w-10 shrink-0 pr-1 text-right text-owl-faint/60 select-none">{line.newNo ?? ""}</span>
									<span className={`w-4 shrink-0 select-none ${line.type === "add" ? "text-status-added" : line.type === "del" ? "text-status-deleted" : "text-transparent"}`}>
										{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
									</span>
									<span className="min-w-0 whitespace-pre-wrap break-all">
										{line.spans === undefined
											? line.text
											: line.spans.map((span, spanIndex) => (
													<span
														key={spanIndex}
														className={
															span.mark === 1
																? line.type === "add"
																	? "rounded-sm bg-emerald-500/25"
																	: "rounded-sm bg-red-500/30"
																: undefined
														}
													>
														{span.text}
													</span>
												))}
									</span>
								</div>
								{notes.map((note) => <div key={note.id} className="owl-diff-saved-comment">{note.text}</div>)}
								</div>;
							})}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
