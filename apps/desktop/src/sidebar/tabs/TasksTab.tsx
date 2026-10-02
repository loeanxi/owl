/**
 * 任务管理 tab —— 对应 dsh-better-sidebar 的 subagent/任务页在 owl 的对等实现：
 * owl 桥暂无子智能体/后台任务 API，这里监控当前会话的真实运行面：轮次分隔、
 * 工具调用时间线（实时状态）、汇总数字。数据走 feed 外部 store（流式 delta
 * 只重渲染本组件），不经过 Workbench 的 props 链。
 */
import { useEffect, useMemo, useRef } from "react";
import { useSessionFeed } from "../feed.ts";
import { IconLayers } from "../quick.tsx";
import { IconLoader } from "../icons.tsx";

interface ToolRow {
	id: string;
	name: string;
	brief: string;
	status: "running" | "done";
}

type TimelineItem =
	| { type: "round"; index: number; prompt: string }
	| { type: "tool"; round: number; row: ToolRow }
	| { type: "result"; round: number; toolName: string; ok: boolean; brief: string };

function firstLine(text: string, max = 160): string {
	const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function useTimeline(): { items: TimelineItem[]; rounds: number; toolCalls: number } {
	const feed = useSessionFeed();
	return useMemo(() => {
		const items: TimelineItem[] = [];
		let round = 0;
		let toolCalls = 0;
		for (const entry of feed.entries) {
			if (entry.kind === "user") {
				round += 1;
				items.push({ type: "round", index: round, prompt: firstLine(entry.text, 80) });
				continue;
			}
			if (entry.kind === "assistant") {
				for (const tool of entry.tools) {
					toolCalls += 1;
					const brief = tool.args ? firstLine(tool.args.replace(/^{\s*"[\s\S]*?"\s*:\s*/, "").replace(/"\s*}\s*$/, "").replace(/\\/g, "")) : "";
					items.push({ type: "tool", round, row: { id: tool.id, name: tool.name, brief, status: tool.status } });
				}
				continue;
			}
			items.push({ type: "result", round, toolName: entry.toolName, ok: entry.ok, brief: firstLine(entry.brief) });
		}
		return { items, rounds: round, toolCalls };
	}, [feed.entries]);
}

export function TasksTab(): React.JSX.Element {
	const feed = useSessionFeed();
	const { items, rounds, toolCalls } = useTimeline();
	const scroller = useRef<HTMLDivElement>(null);

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
				<span className="font-medium text-owl-text">任务管理</span>
				{feed.running ? (
					<span className="flex items-center gap-1.5 text-owl-accent">
						<IconLoader size={11} className="animate-spin" />
						运行中
					</span>
				) : (
					<span className="text-owl-faint">空闲</span>
				)}
				<span className="ml-auto text-owl-faint">
					{rounds} 轮 · {toolCalls} 次工具调用
				</span>
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
							当前会话还没有运行记录。
							<br />
							发消息后，这里的工具调用时间线会实时滚动。
						</p>
					</div>
				) : (
					<ol className="space-y-1.5">
						{items.map((item, index) => {
							if (item.type === "round") {
								return (
									<li key={`r-${index}`} className="flex items-center gap-2 pt-2 pb-0.5 first:pt-0">
										<span className="rounded bg-owl-hover px-1.5 py-0.5 text-[10px] text-owl-muted">第 {item.index} 轮</span>
										<span className="min-w-0 truncate text-xs text-owl-muted">{item.prompt}</span>
									</li>
								);
							}
							if (item.type === "tool") {
								return (
									<li key={item.row.id || `t-${index}`} className="rounded-lg border border-owl-border/40 bg-owl-panel/60 px-2.5 py-1.5">
										<div className="flex items-center gap-2 text-xs">
											<span
												className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.row.status === "running" ? "animate-pulse bg-owl-accent" : "bg-owl-faint"}`}
											/>
											<span className="font-mono text-owl-accent">{item.row.name}</span>
											<span className={item.row.status === "running" ? "text-owl-accent" : "text-owl-faint"}>
												{item.row.status === "running" ? "运行中…" : "已完成"}
											</span>
										</div>
										{item.row.brief && <p className="mt-0.5 truncate font-mono text-[10px] text-owl-faint">{item.row.brief}</p>}
									</li>
								);
							}
							return (
								<li key={`s-${index}`} className="px-2.5 text-[11px] text-owl-faint">
									<span className={item.ok ? "text-emerald-500" : "text-red-400"}>{item.ok ? "✓" : "✗"}</span>{" "}
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
