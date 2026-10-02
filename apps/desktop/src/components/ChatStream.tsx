import { useEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";
import type { ChatEntry } from "../hooks/transcript.ts";
import { IconAlert, IconChat, IconCheck, IconLightbulb, IconTerminal } from "./icons.tsx";
import { StartPage } from "./StartPage.tsx";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdown(text: string): string {
	return md.render(text);
}

/**
 * 聊天流 —— 用户提问与 agent 回答收进同一条居中内容列（响应式：窄窗满宽、宽窗封顶
 * max-w-3xl 居中）。左缘是提问追踪节点轨：每次提问是带序号的强调节点，其后的思考 /
 * 工具调用 / 调用结果 / 回答依次成节点，纵向连线串成一条可扫读的执行链；顺着轨道
 * 数节点即可回溯每一轮「问 → 做 → 答」。
 */

/** 时间轴上的一行：node 是左轨节点，content 是右侧内容。 */
type TimelineRow = {
	key: string;
	node: React.JSX.Element;
	content: React.JSX.Element;
};

/** 提问节点：accent 实心圆 + 提问序号，整条链上唯一的大号节点，承担「提问追踪」锚点。 */
function QuestionNode({ index, title }: { index: number; title: string }): React.JSX.Element {
	return (
		<span
			title={`提问 ${index}：${title}`}
			className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-owl-accent text-[11px] font-semibold text-white ring-4 ring-owl-accent/15"
		>
			{index}
		</span>
	);
}

/** 过程节点：小号圆片，tone 决定配色（思考 / 工具 / 回答 / 结果 / 出错）。 */
const STEP_TONES = {
	muted: "border-owl-border bg-owl-panel text-owl-muted",
	running: "border-owl-accent/60 bg-owl-accent/10 text-owl-accent animate-pulse",
	answer: "border-owl-accent/50 bg-owl-accent/15 text-owl-accent",
	ok: "border-emerald-600/40 bg-emerald-500/10 text-emerald-500",
	error: "border-red-500/40 bg-red-500/10 text-red-400",
} as const;

function StepNode({
	tone,
	title,
	children,
}: {
	tone: keyof typeof STEP_TONES;
	title: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<span
			title={title}
			className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${STEP_TONES[tone]}`}
		>
			{children}
		</span>
	);
}

function ThinkingCard({ thinking }: { thinking: string }): React.JSX.Element {
	return (
		<details className="rounded-lg border border-owl-border bg-owl-sidebar/70 px-3 py-2 text-xs text-owl-faint">
			<summary className="cursor-pointer">思考过程</summary>
			<pre className="mt-2 whitespace-pre-wrap">{thinking}</pre>
		</details>
	);
}

function ToolCardView({
	name,
	args,
	status,
}: {
	name: string;
	args: string;
	status: "running" | "done";
}): React.JSX.Element {
	return (
		<div className="rounded-lg border border-owl-border bg-owl-sidebar/70 p-2 text-xs">
			<div className="flex items-center gap-2">
				<span className="font-mono text-owl-accent">{name}</span>
				<span className={status === "running" ? "text-owl-accent" : "text-owl-faint"}>
					{status === "running" ? "运行中…" : "已完成"}
				</span>
			</div>
			{args && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-owl-muted">{args}</pre>}
		</div>
	);
}

function AnswerCard({ text }: { text: string }): React.JSX.Element {
	return (
		<div
			className="space-y-2 font-serif leading-relaxed [&_code]:rounded [&_code]:bg-owl-sidebar [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-owl-border [&_pre]:bg-owl-sidebar [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs"
			// markdown-it with html:false escapes raw HTML; tool content is data, not markup
			dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
		/>
	);
}

/** 把扁平转录拆成时间轴行：一条 assistant 消息按 思考/各工具/回答/报错 拆成多行，各自成节点。 */
function buildRows(entries: ChatEntry[]): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let turn = 0;
	entries.forEach((entry, index) => {
		if (entry.kind === "user") {
			turn += 1;
			const firstLine = entry.text.split("\n").find((part) => part.trim() !== "") ?? "";
			rows.push({
				key: `q${index}`,
				node: <QuestionNode index={turn} title={firstLine} />,
				// 提问气泡右对齐，但收在内容列以内（列本身封顶 max-w-3xl），不再贴窗口右缘
				content: (
					<div className="flex justify-end">
						<div className="max-w-[85%] rounded-2xl bg-owl-bubble px-4 py-2.5 text-sm whitespace-pre-wrap">
							{entry.text}
						</div>
					</div>
				),
			});
			return;
		}
		if (entry.kind === "assistant") {
			if (entry.thinking) {
				rows.push({
					key: `a${index}-thinking`,
					node: (
						<StepNode tone="muted" title="思考过程">
							<IconLightbulb className="h-3 w-3" />
						</StepNode>
					),
					content: <ThinkingCard thinking={entry.thinking} />,
				});
			}
			for (const tool of entry.tools) {
				rows.push({
					key: `a${index}-tool-${tool.id}`,
					node: (
						<StepNode tone={tool.status === "running" ? "running" : "muted"} title={`工具调用：${tool.name}`}>
							<IconTerminal className="h-3 w-3" />
						</StepNode>
					),
					content: <ToolCardView name={tool.name} args={tool.args} status={tool.status} />,
				});
			}
			if (entry.text) {
				rows.push({
					key: `a${index}-text`,
					node: (
						<StepNode tone="answer" title="回答">
							<IconChat className="h-3 w-3" />
						</StepNode>
					),
					content: <AnswerCard text={entry.text} />,
				});
			}
			if (entry.error) {
				rows.push({
					key: `a${index}-error`,
					node: (
						<StepNode tone="error" title="出错了">
							<IconAlert className="h-3 w-3" />
						</StepNode>
					),
					content: <div className="text-xs text-red-400">{entry.error}</div>,
				});
			}
			return;
		}
		rows.push({
			key: `r${index}`,
			node: (
				<StepNode tone={entry.ok ? "ok" : "error"} title={entry.ok ? "调用结果" : "调用失败"}>
					{entry.ok ? <IconCheck className="h-3 w-3" /> : <IconAlert className="h-3 w-3" />}
				</StepNode>
			),
			content: (
				<div className="rounded-lg border border-owl-border/60 px-3 py-1.5 font-mono text-xs text-owl-faint">
					<span className={entry.ok ? "text-emerald-600" : "text-red-500"}>{entry.toolName}</span> {entry.brief}
				</div>
			),
		});
	});
	return rows;
}

export function ChatStream({
	entries,
	onQuickAction,
}: {
	entries: ChatEntry[];
	/** 空会话开始页的菜单卡回调（打开工作台对应面板）。 */
	onQuickAction?: (kind: string) => void;
}): React.JSX.Element {
	const container = useRef<HTMLElement>(null);
	// 跟随新内容滚动的开关。用户的向上滚动意图（滚轮/触控板/拖滚动条/翻页键）立即关闭，
	// 只有视口真正回到贴底位置才重新打开——流式输出期间翻历史不会被拽回底部。
	const stick = useRef(true);
	const prevEntries = useRef<ChatEntry[]>([]);

	const onWheel = (event: React.WheelEvent<HTMLElement>): void => {
		// 向上滚（deltaY<0）是明确的用户意图，先于滚动发生：直接停跟随。
		// 触控板/高精度滚轮单次位移很小，靠位移阈值判断会漏，必须在 wheel 上拦。
		if (event.deltaY < 0) stick.current = false;
	};

	const onScroll = (): void => {
		const el = container.current;
		if (!el) return;
		// 离开底部（任何手段：滚动条拖动、键盘、触摸）即停跟随；回到贴底（<4px）才恢复。
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
	};

	useEffect(() => {
		const last = entries[entries.length - 1];
		const prevLast = prevEntries.current[prevEntries.current.length - 1];
		const userJustSent = last?.kind === "user" && last !== prevLast;
		prevEntries.current = entries;
		if (!stick.current && !userJustSent) return;
		// 直接设 scrollTop：瞬时定位，不与用户滚动抢平滑动画队列。
		const el = container.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [entries]);

	const rows = useMemo(() => buildRows(entries), [entries]);

	return (
		<main ref={container} onWheel={onWheel} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-5 sm:px-6">
			{/* 统一内容列：宽窗封顶居中、窄窗满宽，提问与回答同列 */}
			<div className="mx-auto w-full max-w-3xl">
				{entries.length === 0 && (onQuickAction ? <StartPage onAction={onQuickAction} /> : (
					<div className="mt-[22vh] flex flex-col items-center">
						<img src="/owl.svg" alt="" className="h-12 w-12 opacity-90" />
						<p className="mt-5 font-serif text-2xl text-owl-text">✳ 有什么可以帮你的？</p>
						<p className="mt-2 text-sm text-owl-faint">比 pi 更轻的 coding agent · 发消息开始</p>
					</div>
				))}
				{rows.map((row, i) => {
					const isLast = i === rows.length - 1;
					return (
						<div key={row.key} className="flex gap-2 sm:gap-3">
							{/* 节点轨：节点 + 纵向连线，行间无空隙保证链路连续 */}
							<div className="flex w-6 shrink-0 flex-col items-center">
								{row.node}
								{!isLast && <div className="w-px flex-1 bg-owl-border/50" aria-hidden="true" />}
							</div>
							<div className={`min-w-0 flex-1 ${isLast ? "" : "pb-4"}`}>{row.content}</div>
						</div>
					);
				})}
			</div>
		</main>
	);
}
