/**
 * 任务管理 tab —— 对应 dsh-better-sidebar 的 subagent/任务页在 owl 的对等实现：
 * owl 桥暂无子智能体/后台任务 API，这里监控当前会话的真实运行面：轮次分隔、
 * 工具调用时间线（实时状态）、汇总数字。数据走 feed 外部 store（流式 delta
 * 只重渲染本组件），不经过 Workbench 的 props 链。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { InlineSummary } from "../../components/ChatStream.tsx";
import { fmtDuration, fmtTime } from "../../components/context/context-model.ts";
import type { ToolCard, ToolStatus } from "../../hooks/transcript.ts";
import { type TextKey, useT } from "../../i18n/index.ts";
import { useSessionFeed } from "../feed.ts";
import { IconLoader } from "../icons.tsx";
import { IconLayers } from "../quick.tsx";

type ToolRow = Pick<ToolCard, "id" | "name" | "summary" | "status" | "startedAt" | "finishedAt">;

const TOOL_STATES: Record<ToolStatus, { label: TextKey; dot: string; text: string }> = {
	pending: { label: "tasks.pending", dot: "bg-owl-faint/50", text: "text-owl-faint" },
	running: { label: "tasks.running", dot: "animate-pulse bg-owl-accent", text: "text-owl-accent" },
	ok: { label: "tasks.ok", dot: "bg-emerald-500", text: "text-emerald-500" },
	error: { label: "tasks.error", dot: "bg-red-400", text: "text-red-400" },
	cancelled: { label: "tasks.cancelled", dot: "bg-owl-faint/50", text: "text-owl-faint" },
};

type TimelineItem =
	| { type: "round"; index: number; prompt: string }
	| { type: "queued"; prompt: string }
	| { type: "tool"; round: number; row: ToolRow }
	| { type: "result"; round: number; toolName: string; ok: boolean; brief: string };

function firstLine(text: string, max = 160): string {
	const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function validTime(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime())
		? value
		: undefined;
}

function useTimeline(): { items: TimelineItem[]; rounds: number; toolCalls: number } {
	const feed = useSessionFeed();
	return useMemo(() => {
		const items: TimelineItem[] = [];
		let round = 0;
		let toolCalls = 0;
		for (const entry of feed.entries) {
			if (entry.kind === "user") {
				if (entry.queued) {
					items.push({ type: "queued", prompt: firstLine(entry.text, 80) });
					continue;
				}
				round += 1;
				items.push({ type: "round", index: round, prompt: firstLine(entry.text, 80) });
				continue;
			}
			if (entry.kind === "assistant") {
				for (const tool of entry.tools) {
					toolCalls += 1;
					items.push({ type: "tool", round, row: tool });
				}
				continue;
			}
			items.push({ type: "result", round, toolName: entry.toolName, ok: entry.ok, brief: firstLine(entry.brief) });
		}
		return { items, rounds: round, toolCalls };
	}, [feed.entries]);
}

export function TasksTab(): React.JSX.Element {
	const t = useT();
	const feed = useSessionFeed();
	const { items, rounds, toolCalls } = useTimeline();
	const scroller = useRef<HTMLDivElement>(null);
	const [now, setNow] = useState(() => Date.now());
	const liveTools =
		feed.running &&
		items.some(
			(item) =>
				item.type === "tool" &&
				item.row.status === "running" &&
				validTime(item.row.startedAt) !== undefined &&
				validTime(item.row.finishedAt) === undefined,
		);
	useEffect(() => {
		if (!liveTools) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [liveTools]);

	// 新内容贴底跟随；用户上滚即让位（与 ChatStream 同规则）
	const stick = useRef(true);
	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [items]);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* 状态头：当前会话的运行面概览 */}
			<div className="flex shrink-0 items-center gap-2 border-b border-owl-border/40 px-3 py-2 text-xs">
				<IconLayers size={13} className="text-[#d29922]" />
				<span className="font-medium text-owl-text">{t("wb.tasks")}</span>
				{feed.running ? (
					<span role="status" className="flex items-center gap-1.5 text-owl-accent">
						<IconLoader size={11} className="animate-spin" />
						{t("chat.runningAria")}
					</span>
				) : (
					<span role="status" className="text-owl-faint">
						{t("tasks.idle")}
					</span>
				)}
				<span className="ml-auto text-owl-faint">{t("tasks.stats", { rounds, tools: toolCalls })}</span>
			</div>

			<div
				ref={scroller}
				onWheel={(e) => {
					if (e.deltaY < 0) stick.current = false;
				}}
				onScroll={() => {
					const el = scroller.current;
					if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
				}}
				className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
			>
				{items.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
						<IconLayers size={22} className="text-owl-faint opacity-60" />
						<p className="text-xs text-owl-faint">
							{t("tasks.empty")}
							<br />
							{t("tasks.emptyHint")}
						</p>
					</div>
				) : (
					<ol className="space-y-1.5">
						{items.map((item, index) => {
							if (item.type === "queued") {
								return (
									<li
										key={`q-${index}`}
										data-task-queued="true"
										className="flex items-center gap-2 pt-2 pb-0.5 first:pt-0 text-owl-faint"
									>
										<span className="shrink-0 rounded bg-owl-hover px-1.5 py-0.5 text-[10px]">
											{t("tasks.queued")}
										</span>
										<span className="min-w-0 truncate text-xs">{item.prompt}</span>
									</li>
								);
							}
							if (item.type === "round") {
								return (
									<li key={`r-${index}`} className="flex items-center gap-2 pt-2 pb-0.5 first:pt-0">
										<span className="rounded bg-owl-hover px-1.5 py-0.5 text-[10px] text-owl-muted">
											{t("tasks.round", { n: item.index })}
										</span>
										<span className="min-w-0 truncate text-xs text-owl-muted">{item.prompt}</span>
									</li>
								);
							}
							if (item.type === "tool") {
								const state = TOOL_STATES[item.row.status];
								const startedAt = validTime(item.row.startedAt);
								const finishedAt = validTime(item.row.finishedAt);
								const live = feed.running && item.row.status === "running" && finishedAt === undefined;
								const end = live ? now : finishedAt;
								const elapsed =
									item.row.status !== "pending" &&
									startedAt !== undefined &&
									end !== undefined &&
									end >= startedAt
										? end - startedAt
										: undefined;
								return (
									<li
										key={item.row.id || `t-${index}`}
										data-tool-id={item.row.id}
										data-status={item.row.status}
										className="rounded-lg border border-owl-border/40 bg-owl-panel/60 px-2.5 py-1.5"
									>
										<div className="flex items-center gap-2 text-xs">
											<span
												aria-hidden="true"
												className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.dot}`}
											/>
											<span
												className={`min-w-0 flex-1 truncate ${item.row.status === "error" ? "text-red-400" : "text-owl-muted"}`}
											>
												<InlineSummary text={item.row.summary} />
											</span>
											<span
												aria-label={t("tasks.toolState", { name: item.row.name, status: t(state.label) })}
												className={`shrink-0 ${state.text}`}
											>
												{t(state.label)}
											</span>
										</div>
										{(startedAt !== undefined || finishedAt !== undefined) && (
											<div
												aria-live="off"
												className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-[10px] tabular-nums text-owl-faint"
											>
												{startedAt !== undefined && (
													<time
														dateTime={new Date(startedAt).toISOString()}
														title={new Date(startedAt).toLocaleString()}
													>
														{t("tasks.startedAt", { time: fmtTime(startedAt) })}
													</time>
												)}
												{finishedAt !== undefined && (
													<time
														dateTime={new Date(finishedAt).toISOString()}
														title={new Date(finishedAt).toLocaleString()}
													>
														{t("tasks.finishedAt", { time: fmtTime(finishedAt) })}
													</time>
												)}
												{elapsed !== undefined && (
													<span data-elapsed-ms={elapsed}>
														{t(live ? "tasks.elapsed" : "tasks.duration", { time: fmtDuration(elapsed) })}
													</span>
												)}
											</div>
										)}
									</li>
								);
							}
							return (
								<li key={`s-${index}`} className="px-2.5 text-[11px] text-owl-faint">
									<span
										className={item.ok ? "text-emerald-500" : "text-red-400"}
										aria-label={t("tasks.toolState", {
											name: item.toolName,
											status: t(item.ok ? "tasks.ok" : "tasks.error"),
										})}
									>
										<span aria-hidden="true">{item.ok ? "✓" : "✗"}</span>{" "}
										{t(item.ok ? "tasks.ok" : "tasks.error")}
									</span>{" "}
									<span className="font-mono">{item.toolName}</span> {item.brief}
								</li>
							);
						})}
					</ol>
				)}
			</div>
		</div>
	);
}
