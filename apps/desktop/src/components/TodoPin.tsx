import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "../hooks/transcript.ts";
import { latestTodoState } from "../hooks/todo.ts";
import { useT } from "../i18n/index.ts";
import { IconCheck } from "./icons.tsx";

/**
 * 任务清单入口：会话有清单时在对话区右上角露出一个小图标，点开浮出完整清单；
 * 没有清单时整块隐藏。定位依赖最近的 position: relative 祖先（对话主体区）。
 */
export function TodoPin({ entries }: { entries: ChatEntry[] }): React.JSX.Element | null {
	const t = useT();
	const todos = latestTodoState(entries);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const visible = Boolean(todos && todos.length > 0);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		if (!visible) setOpen(false);
	}, [visible]);

	if (!visible || !todos) return null;

	const done = todos.filter((item) => item.status === "completed").length;
	const pct = Math.round((done / todos.length) * 100);
	const allDone = done === todos.length;
	const current = todos.find((item) => item.status === "in_progress");
	const summary = `${t("todo.title")} ${done}/${todos.length}${allDone ? t("todo.allDone") : ""}`;

	return (
		<div className="owl-todo-anchor" ref={rootRef}>
			<button
				type="button"
				className="owl-todo-trigger"
				data-state={allDone ? "done" : current ? "active" : "idle"}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={open ? t("todo.collapse") : t("todo.expand")}
				title={summary}
				onClick={() => setOpen((value) => !value)}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
					<path d="M4 6.5 5.5 8 8 5.5M4 12.5 5.5 14 8 11.5M4 18.5 5.5 20 8 17.5M11 7h9M11 13h9M11 19h9" />
				</svg>
				{!allDone && current && <span className="owl-todo-trigger__dot" aria-hidden="true" />}
			</button>
			{open && (
				<div className="owl-todo-pin owl-todo-popover" role="dialog" aria-label={t("todo.title")}>
					<div className="flex items-center gap-2.5">
						<span className={`shrink-0 font-medium ${allDone ? "text-emerald-500" : "text-owl-text"}`}>
							{t("todo.title")}
						</span>
						<span className="shrink-0 text-owl-faint">
							{done}/{todos.length}
							{allDone ? t("todo.allDone") : ""}
						</span>
						<div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-owl-hover">
							<div
								className={`h-full rounded-full transition-all duration-300 ${allDone ? "bg-emerald-500" : "bg-owl-accent"}`}
								style={{ width: `${pct}%` }}
							/>
						</div>
						<button
							type="button"
							title={t("todo.collapse")}
							aria-label={t("todo.collapse")}
							onClick={() => setOpen(false)}
							className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
						>
							×
						</button>
					</div>
					<ul className="mt-2 space-y-1 border-t border-owl-border/50 pt-2">
						{todos.map((item, index) => (
							<li key={index} className="flex items-start gap-1.5">
								<span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
									{item.status === "completed" ? (
										<IconCheck className="h-3 w-3 text-emerald-500" />
									) : item.status === "in_progress" ? (
										<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-owl-accent" />
									) : (
										<span className="h-2.5 w-2.5 rounded-full border border-owl-border" />
									)}
								</span>
								<span
									className={`min-w-0 break-words ${
										item.status === "completed"
											? "text-owl-faint line-through"
											: item.status === "in_progress"
												? "font-medium text-owl-text"
												: "text-owl-muted"
									}`}
								>
									{item.content}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
