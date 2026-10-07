import { useEffect, useState } from "react";
import type { ChatEntry } from "../hooks/transcript.ts";
import { latestTodoState } from "../hooks/todo.ts";
import { useT } from "../i18n/index.ts";
import { IconCheck, IconChevron } from "./icons.tsx";

/** 收起态偏好键：0 = 上次手动收起（新清单到来时仍会自动展开提醒）。 */
const TODO_PIN_KEY = "owl.todopin.open";

/**
 * 任务清单常驻条：贴在输入框上方，实时反映会话当前任务状态——
 * 收起时一行（进度条 + 进行中的任务），展开后是完整清单；
 * 用户点 × 收下后，清单下一次更新会重新弹出提醒。
 */
export function TodoPin({ entries, onVisibleChange }: { entries: ChatEntry[]; onVisibleChange?: (visible: boolean) => void }): React.JSX.Element | null {
	const t = useT();
	const todos = latestTodoState(entries);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [open, setOpen] = useState(() => localStorage.getItem(TODO_PIN_KEY) !== "0");

	// 用户收下 → 记下当前清单快照并整条隐藏；清单再变化（模型更新了任务）→ 重新弹出
	const snapshot = todos ? JSON.stringify(todos) : "";
	useEffect(() => {
		if (snapshot && dismissed !== null && dismissed !== snapshot) {
			setDismissed(null);
			setOpen(true);
		}
	}, [snapshot, dismissed]);

	const visible = Boolean(todos && todos.length > 0 && dismissed === null);
	useEffect(() => {
		onVisibleChange?.(visible);
		return () => onVisibleChange?.(false);
	}, [visible, onVisibleChange]);

	if (!visible || !todos) return null;

	const done = todos.filter((item) => item.status === "completed").length;
	const pct = Math.round((done / todos.length) * 100);
	const allDone = done === todos.length;
	const current = todos.find((item) => item.status === "in_progress");

	const dismiss = (): void => {
		setDismissed(snapshot);
	};

	return (
		<div className="mx-auto w-full max-w-3xl shrink-0 px-4">
			<div className="mb-1.5 rounded-xl border border-owl-border bg-owl-sidebar/80 px-3 py-2 text-xs shadow-lg shadow-black/25 backdrop-blur-sm">
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
					{/* 进行中的一项是用户最关心的：收起态也常驻展示 */}
					{!open && current && (
						<span className="max-w-[36%] shrink-0 truncate text-owl-muted">
							<span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-owl-accent align-middle" />
							{current.content}
						</span>
					)}
					<button
						type="button"
						title={open ? t("todo.collapse") : t("todo.expand")}
						aria-label={open ? t("todo.collapse") : t("todo.expand")}
						onClick={() => setOpen((v) => !v)}
						className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
					>
						<IconChevron className={`h-3.5 w-3.5 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
					</button>
					<button
						type="button"
						title={t("todo.dismissTip")}
						aria-label={t("todo.dismiss")}
						onClick={dismiss}
						className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
					>
						×
					</button>
				</div>
				{open && (
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
				)}
			</div>
		</div>
	);
}
