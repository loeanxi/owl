/**
 * 一段 unified diff 的只读渲染（红删绿增 + 行内字符级高亮）。
 *
 * 从 ChangesTab 抽出的共享组件：改动审批（ReviewTab）与文件变动（ChangesTab）
 * 共用同一套 diff 视觉（parseUnifiedDiff + annotateCharDiff，VS Code 同款）。
 */
import { useMemo } from "react";
import { t } from "../i18n/index.ts";
import { annotateCharDiff, parseUnifiedDiff, type DiffFile } from "./diff.ts";

export function DiffView({ text }: { text: string }): React.JSX.Element {
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
	return (
		<div className="font-mono text-[11.5px] leading-[1.5]">
			{files.map((file) => (
				<div key={`${file.path}-${file.isNew ? "n" : ""}${file.isDeleted ? "d" : ""}`} className="mb-3">
					<div className="sticky top-0 z-10 flex items-center gap-2 border-y border-owl-border/40 bg-owl-panel/95 px-3 py-1 backdrop-blur">
						<span className="truncate text-[11px] text-owl-text" title={file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}>
							{file.isNew && <span className="mr-1.5 rounded bg-emerald-500/20 px-1 text-emerald-300">{t("changes.new")}</span>}
							{file.isDeleted && <span className="mr-1.5 rounded bg-red-500/20 px-1 text-red-300">{t("changes.deleted")}</span>}
							{file.isRename && <span className="mr-1.5 rounded bg-sky-500/20 px-1 text-sky-300">{t("changes.renamed")}</span>}
							{file.path}
						</span>
					</div>
					{file.hunks.map((hunk, hunkIndex) => (
						<div key={hunkIndex}>
							<div className="bg-owl-panel/60 px-3 py-0.5 text-owl-faint">{hunk.header}</div>
							{hunk.lines.map((line, lineIndex) => (
								<div
									key={lineIndex}
									className={`flex ${line.type === "add" ? "bg-emerald-500/10" : line.type === "del" ? "bg-red-500/10" : ""}`}
								>
									<span className="w-10 shrink-0 pr-1 text-right text-owl-faint/60 select-none">{line.oldNo ?? ""}</span>
									<span className="w-10 shrink-0 pr-1 text-right text-owl-faint/60 select-none">{line.newNo ?? ""}</span>
									<span className={`w-4 shrink-0 select-none ${line.type === "add" ? "text-emerald-400" : line.type === "del" ? "text-red-400" : "text-transparent"}`}>
										{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
									</span>
									<span className="whitespace-pre-wrap break-all">
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
							))}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
