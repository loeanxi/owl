import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import type { ChatEntry, ToolCard, ToolStatus } from "../hooks/transcript.ts";
import { parseTodoArgs } from "../hooks/todo.ts";
import { toolRunLabel } from "../hooks/summarize.ts";
import { IconAlert, IconChat, IconCheck, IconChevron, IconLightbulb, IconList, IconTerminal } from "./icons.tsx";
import { StartPage } from "./StartPage.tsx";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 提问导航展开/收起偏好的 localStorage 键。 */
const QNAV_KEY = "owl.qnav.open";

/** 工具输出默认只预览末尾几行（结论/报错多在尾部），展开才看全文。 */
const OUTPUT_PREVIEW_LINES = 10;

export function renderMarkdown(text: string): string {
	return md.render(text);
}

/**
 * 聊天流 —— 用户提问与 agent 回答收进同一条居中内容列（响应式：窄窗满宽、宽窗封顶
 * max-w-3xl 居中）。左缘是提问追踪节点轨：每次提问是带序号的强调节点，其后的思考 /
 * 工具 / 回答依次成节点，纵向连线串成一条可扫读的执行链。
 *
 * 过程采用「渐进披露」：工具调用默认收成一行人话摘要，连续的工具调用（名称可不同，
 * 如浏览器套件）合并成一组（「运行了 4 条命令」「浏览器操作 × 3」），点击逐级展开
 * 参数与输出；失败行自动展开标红。答案正文永远是主角，思考过程整轮合并成一条轻量折叠行。
 */

/** 时间轴上的一行：node 是左轨节点，content 是右侧内容；提问行带 questionIndex 作跳转锚点。 */
type TimelineRow = {
	key: string;
	node: React.JSX.Element;
	content: React.JSX.Element;
	questionIndex?: number;
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

/** 渲染含 `code` 反引号的摘要行（工具摘要里的命令/路径/模式）。 */
export function InlineSummary({ text }: { text: string }): React.JSX.Element {
	const parts = text.split(/`([^`]*)`/);
	return (
		<>
			{parts.map((part, index) =>
				index % 2 === 1 ? (
					<code key={index} className="rounded bg-owl-bg/70 px-1 font-mono text-[11px] text-owl-text">
						{part}
					</code>
				) : part ? (
					<span key={index}>{part}</span>
				) : null,
			)}
		</>
	);
}

/** 工具状态图标：运行中转圈 / 成功绿勾 / 失败红叹号。 */
function StatusIcon({ status }: { status: ToolStatus }): React.JSX.Element {
	if (status === "running") {
		return (
			<span
				aria-label="运行中"
				className="h-3 w-3 shrink-0 animate-spin rounded-full border border-owl-accent/30 border-t-owl-accent"
			/>
		);
	}
	if (status === "error") return <IconAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />;
	return <IconCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
}

/** 思考过程：整轮合并成一条轻量折叠行，默认收起，不再一段一个全宽条。 */
function ThinkingRow({ thinking }: { thinking: string }): React.JSX.Element {
	const lines = useMemo(
		() => thinking.split("\n").filter((line) => line.trim() !== "").length,
		[thinking],
	);
	return (
		<details className="group text-xs text-owl-faint">
			<summary className="flex cursor-pointer select-none list-none items-center gap-1.5 py-0.5 [&::-webkit-details-marker]:hidden">
				<IconChevron className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
				思考过程 · {lines} 行
			</summary>
			<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-owl-sidebar/50 px-3 py-2 text-[11px] leading-relaxed">
				{thinking}
			</pre>
		</details>
	);
}

function tailLines(text: string, count: number): { preview: string; dropped: number } {
	const lines = text.split("\n");
	if (lines.length <= count) return { preview: text, dropped: 0 };
	return { preview: lines.slice(-count).join("\n"), dropped: lines.length - count };
}

/**
 * 单个工具调用行：一行人话摘要（状态图标 + 摘要 + 展开箭头），展开看参数细节与
 * 输出（默认末 10 行，可看全文）；失败自动展开标红。
 */
function ToolRowView({ card }: { card: ToolCard }): React.JSX.Element {
	const [open, setOpen] = useState(card.status === "error");
	const [fullOutput, setFullOutput] = useState(false);
	const [zoomed, setZoomed] = useState(false);
	// 失败时弹开（含流式中 running→error 的转变）；用户随后手动收起不再打扰
	useEffect(() => {
		if (card.status === "error") setOpen(true);
	}, [card.status]);

	const output = card.output;
	const { preview, dropped } = output ? tailLines(output.text, OUTPUT_PREVIEW_LINES) : { preview: "", dropped: 0 };
	const hasMore = (output?.totalLines ?? 0) > OUTPUT_PREVIEW_LINES;
	const images = output?.images ?? [];

	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition-colors hover:bg-owl-hover/50"
			>
				<StatusIcon status={card.status} />
				<span
					className={`min-w-0 flex-1 truncate ${card.status === "error" ? "text-red-400" : "text-owl-muted"}`}
				>
					<InlineSummary text={card.summary} />
				</span>
				<IconChevron
					className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{open && (
				<div className="mb-1 ml-3 space-y-1.5 border-l border-owl-border/50 pl-3 pt-0.5">
					{card.detail && (
						<pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-owl-bg/60 px-2.5 py-1.5 font-mono text-[11px] text-owl-muted">
							{card.detail}
						</pre>
					)}
					{output && output.text !== "" && (
						<>
							<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-owl-bg/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-owl-muted">
								{fullOutput || !hasMore ? output.text : `…（前 ${dropped} 行已省略）\n${preview}`}
							</pre>
							{hasMore && (
								<button
									type="button"
									onClick={() => setFullOutput((value) => !value)}
									className="text-[11px] text-owl-accent transition-colors hover:text-owl-accent-hover"
								>
									{fullOutput ? "收起输出" : `查看完整输出（共 ${output.totalLines} 行）`}
								</button>
							)}
						</>
					)}
					{/* 服务端 50KB 截断后全文在临时文件里；文本里没带路径时补一行提示 */}
					{output?.fullPath && !output.text.includes(output.fullPath) && (
						<p className="truncate font-mono text-[11px] text-owl-faint" title={output.fullPath}>
							完整输出：{output.fullPath}
						</p>
					)}
					{images.length > 0 && (
						<div className="space-y-2">
							{images.map((image, index) => (
								<img
									key={index}
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={`${card.name} 截图 ${index + 1}`}
									className={`w-full cursor-zoom-in rounded-lg border border-owl-border ${zoomed ? "" : "max-h-72 object-contain object-top"}`}
									onClick={() => setZoomed((value) => !value)}
								/>
							))}
							<button
								type="button"
								onClick={() => setZoomed((value) => !value)}
								className="text-[11px] text-owl-accent transition-colors hover:text-owl-accent-hover"
							>
								{zoomed ? "收起" : "查看完整大图"}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** 连续工具调用的合组（名称可不同）：失败自动展开，展开后每行再各自展开。 */
function ToolGroupView({ label, cards }: { label: string; cards: ToolCard[] }): React.JSX.Element {
	const [open, setOpen] = useState(() => cards.some((card) => card.status === "error"));
	const errorCount = cards.filter((card) => card.status === "error").length;
	const running = cards.some((card) => card.status === "running");
	useEffect(() => {
		if (errorCount > 0) setOpen(true);
	}, [errorCount]);

	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition-colors hover:bg-owl-hover/50"
			>
				<IconChevron
					className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<span className="min-w-0 flex-1 truncate text-owl-muted">{label}</span>
				{running ? (
					<span className="flex shrink-0 items-center gap-1.5 text-owl-accent">
						<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-owl-accent" />
						运行中…
					</span>
				) : errorCount > 0 ? (
					<span className="shrink-0 text-red-400">
						{errorCount} 个失败
					</span>
				) : null}
			</button>
			{open && (
				<div className="mt-0.5 space-y-0.5">
					{cards.map((card) => (
						<ToolRowView key={card.id} card={card} />
					))}
				</div>
			)}
		</div>
	);
}

/** todo 工具专属卡片：勾选态清单 + 完成进度条；解析不了参数时退回通用工具行。 */
function TodoCardView({ card }: { card: ToolCard }): React.JSX.Element {
	const items = parseTodoArgs(card.args);
	if (!items) return <ToolRowView card={card} />;
	const done = items.filter((item) => item.status === "completed").length;
	const pct = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
	return (
		<div className="rounded-lg border border-owl-border bg-owl-sidebar/70 p-2.5 text-xs">
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-owl-text">任务清单</span>
				<span className="text-owl-faint">
					{done}/{items.length} 完成{card.status === "running" ? " · 更新中…" : ""}
				</span>
			</div>
			<div className="mt-2 h-1 overflow-hidden rounded-full bg-owl-hover">
				<div className="h-full rounded-full bg-owl-accent transition-all duration-300" style={{ width: `${pct}%` }} />
			</div>
			<ul className="mt-2 space-y-1">
				{items.map((item, index) => (
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
										? "text-owl-text font-medium"
										: "text-owl-muted"
							}`}
						>
							{item.content}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function AnswerCard({ text }: { text: string }): React.JSX.Element {
	return (
		<div
			className="break-words space-y-2 font-serif leading-relaxed [&_code]:rounded [&_code]:bg-owl-sidebar [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-owl-border [&_pre]:bg-owl-sidebar [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs"
			// markdown-it with html:false escapes raw HTML; tool content is data, not markup
			dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
		/>
	);
}

/** 孤立结果行（找不到所属工具卡的防御兜底，如会话恢复失败）。 */
function OrphanResultRow({ entry }: { entry: Extract<ChatEntry, { kind: "toolResult" }> }): React.JSX.Element {
	return (
		<div className="flex items-center gap-2 text-xs">
			<span className={entry.ok ? "text-emerald-500" : "text-red-400"}>{entry.ok ? "✓" : "✗"}</span>
			<span className="font-mono text-owl-accent">{entry.toolName}</span>
			<span className="min-w-0 flex-1 text-owl-faint">{entry.brief}</span>
		</div>
	);
}

/** 工具节点配色：运行中脉冲 / 失败红 / 其余绿。 */
function toolTone(status: ToolStatus): "running" | "ok" | "error" {
	return status === "running" ? "running" : status === "error" ? "error" : "ok";
}

function toolNode(card: ToolCard): React.JSX.Element {
	return (
		<StepNode tone={toolTone(card.status)} title={`工具调用：${card.name}`}>
			<IconTerminal className="h-3 w-3" />
		</StepNode>
	);
}

function toolRow(key: string, card: ToolCard): TimelineRow {
	return {
		key,
		node: toolNode(card),
		content: card.name === "todo" ? <TodoCardView card={card} /> : <ToolRowView card={card} />,
	};
}

/** 一轮提问聚合出的内容（同一轮可能有多条 assistant 消息：工具调用把它们隔开）。 */
type TurnAcc = { thinking: string[]; tools: ToolCard[]; texts: string[]; error?: string };

/**
 * 独立呈现、不进合组的工具：todo 有专属清单卡，ask_user 是等用户输入的轮次边界，
 * 都值得常驻可见；其余连续工具（名称可不同）收进一个可折叠组。
 */
const STANDALONE_TOOLS = new Set(["todo", "ask_user_question"]);

/** 把一轮的聚合内容排成时间轴行：思考一条 → 连续工具收成一组 → 回答正文 → 报错。 */
function turnRows(acc: TurnAcc, turn: number): TimelineRow[] {
	const rows: TimelineRow[] = [];
	const thinking = acc.thinking.join("\n\n").trim();
	if (thinking) {
		rows.push({
			key: `t${turn}-thinking`,
			node: (
				<StepNode tone="muted" title="思考过程">
					<IconLightbulb className="h-3 w-3" />
				</StepNode>
			),
			content: <ThinkingRow thinking={thinking} />,
		});
	}
	let index = 0;
	let groupIndex = 0;
	while (index < acc.tools.length) {
		const tool = acc.tools[index]!;
		if (STANDALONE_TOOLS.has(tool.name)) {
			rows.push(toolRow(`t${turn}-tool-${tool.id}`, tool));
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < acc.tools.length && !STANDALONE_TOOLS.has(acc.tools[end]!.name)) end += 1;
		const group = acc.tools.slice(index, end);
		if (group.length === 1) {
			rows.push(toolRow(`t${turn}-tool-${tool.id}`, tool));
		} else {
			const tone = group.some((card) => card.status === "running")
				? "running"
				: group.some((card) => card.status === "error")
					? "error"
					: "ok";
			rows.push({
				key: `t${turn}-group-${groupIndex}`,
				node: (
					<StepNode tone={tone} title={`工具调用 × ${group.length}`}>
						<IconTerminal className="h-3 w-3" />
					</StepNode>
				),
				content: <ToolGroupView label={toolRunLabel(group.map((card) => card.name), group.length)} cards={group} />,
			});
		}
		groupIndex += 1;
		index = end;
	}
	if (acc.texts.length > 0) {
		rows.push({
			key: `t${turn}-text`,
			node: (
				<StepNode tone="answer" title="回答">
					<IconChat className="h-3 w-3" />
				</StepNode>
			),
			content: <AnswerCard text={acc.texts.join("\n\n")} />,
		});
	}
	if (acc.error) {
		rows.push({
			key: `t${turn}-error`,
			node: (
				<StepNode tone="error" title="出错了">
					<IconAlert className="h-3 w-3" />
				</StepNode>
			),
			content: <div className="break-words text-xs text-red-400">{acc.error}</div>,
		});
	}
	return rows;
}

/** 把扁平转录拆成时间轴行：按提问分轮，每轮内 思考/工具组/回答 各自成节点。 */
function buildRows(entries: ChatEntry[]): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let turn = 0;
	let acc: TurnAcc = { thinking: [], tools: [], texts: [] };
	const flush = (): void => {
		rows.push(...turnRows(acc, turn));
		acc = { thinking: [], tools: [], texts: [] };
	};
	entries.forEach((entry, index) => {
		if (entry.kind === "user") {
			flush();
			turn += 1;
			const firstLine = entry.text.split("\n").find((part) => part.trim() !== "") ?? "";
			rows.push({
				key: `q${turn}`,
				questionIndex: turn,
				node: <QuestionNode index={turn} title={firstLine} />,
				// 提问气泡右对齐，但收在内容列以内（列本身封顶 max-w-3xl），不再贴窗口右缘
				content: (
					<div className="flex justify-end">
						<div className="max-w-[85%] rounded-2xl bg-owl-bubble px-4 py-2.5 text-sm break-words whitespace-pre-wrap">
							{entry.text}
						</div>
					</div>
				),
			});
			return;
		}
		if (entry.kind === "assistant") {
			if (entry.thinking.trim()) acc.thinking.push(entry.thinking);
			acc.tools.push(...entry.tools);
			if (entry.text) acc.texts.push(entry.text);
			if (entry.error) acc.error = entry.error;
			return;
		}
		// 孤立工具结果（防御）：收尾当前轮后单独成行
		flush();
		rows.push({ key: `r${index}`, node: (
			<StepNode tone={entry.ok ? "ok" : "error"} title={entry.ok ? "调用结果" : "调用失败"}>
				{entry.ok ? <IconCheck className="h-3 w-3" /> : <IconAlert className="h-3 w-3" />}
			</StepNode>
		), content: <OrphanResultRow entry={entry} /> });
	});
	flush();
	return rows;
}

/** 提问导航的一项：提问序号 + 提问首行 + 本轮回答首行（预览）。 */
type QuestionMark = { n: number; text: string; preview: string };

function firstLineOf(text: string): string {
	return text.split("\n").find((part) => part.trim() !== "") ?? "";
}

/** 从转录提取全部提问及其回答预览，供提问导航浮层使用。 */
function buildQuestions(entries: ChatEntry[]): QuestionMark[] {
	const questions: QuestionMark[] = [];
	let current: QuestionMark | undefined;
	for (const entry of entries) {
		if (entry.kind === "user") {
			current = { n: questions.length + 1, text: firstLineOf(entry.text), preview: "" };
			questions.push(current);
		} else if (current && !current.preview && entry.kind === "assistant" && entry.text) {
			current.preview = firstLineOf(entry.text);
		}
	}
	return questions;
}

/**
 * 提问导航浮层：贴聊天区左缘的悬浮卡，列出本会话全部提问（带回答首行预览）。
 * 点击项平滑滚动到对应提问；当前视口所在提问高亮；可收起成一个小按钮，偏好持久化。
 */
function QuestionNavigator({
	questions,
	active,
	onJump,
}: {
	questions: QuestionMark[];
	active: number;
	onJump: (n: number) => void;
}): React.JSX.Element | null {
	const [open, setOpen] = useState(() => localStorage.getItem(QNAV_KEY) !== "0");
	const toggle = (): void => {
		setOpen((value) => {
			localStorage.setItem(QNAV_KEY, value ? "0" : "1");
			return !value;
		});
	};
	if (questions.length === 0) return null;
	if (!open) {
		return (
			<button
				type="button"
				title={`提问导航（${questions.length} 个提问）`}
				aria-label="提问导航"
				aria-expanded={false}
				onClick={toggle}
				className="owl-chrome-button owl-question-nav-toggle absolute left-2 top-1/2 z-20 -translate-y-1/2"
			>
				<IconList className="h-3.5 w-3.5" />
			</button>
		);
	}
	return (
		<div className="owl-question-nav absolute left-2 top-1/2 z-20 flex max-h-[72vh] w-60 -translate-y-1/2 flex-col overflow-hidden rounded-xl border" role="navigation" aria-label="提问列表">
			<header className="flex shrink-0 items-center justify-between border-b border-owl-sidebar-border py-1.5 pl-3 pr-1.5">
				<span className="text-xs font-medium text-owl-sidebar-muted">提问导航 · {questions.length}</span>
				<button
					type="button"
					title="收起提问导航"
					aria-label="收起提问导航"
					aria-expanded
					onClick={toggle}
					className="owl-chrome-button"
				>
					<IconChevron className="h-3.5 w-3.5 rotate-180" />
				</button>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{questions.map((question) => (
					<button
						key={question.n}
						type="button"
						onClick={() => onJump(question.n)}
						aria-current={question.n === active ? "location" : undefined}
						className={`owl-question-nav-item flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${question.n === active ? "is-active" : ""}`}
					>
						<span
							className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-owl-sidebar-hover text-[10px] font-semibold text-owl-sidebar-muted"
						>
							{question.n}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs text-owl-sidebar-text">{question.text}</span>
							{question.preview && (
								<span className="block truncate text-[11px] leading-4 text-owl-sidebar-faint">{question.preview}</span>
							)}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

/**
 * 最新截图 Dock（ZCode 同款）：贴在聊天底部的小缩略图，免翻时间轴直接看
 * agent 刚截的图。点缩略图弹出完整大图（浮层），✕ 关闭后同一张不再出现，
 * agent 截了新图会重新弹出。
 */
function ScreenshotDock({
	shot,
	onClose,
}: {
	shot: { key: string; image: ToolResultImage };
	onClose: () => void;
}): React.JSX.Element {
	const [zoom, setZoom] = useState(false);
	const src = `data:${shot.image.mimeType};base64,${shot.image.data}`;
	return (
		<>
			{zoom && (
				<div
					className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-6"
					onClick={() => setZoom(false)}
				>
					<img src={src} alt="完整截图" className="max-h-full max-w-full rounded-lg border border-owl-border shadow-2xl" />
				</div>
			)}
			<div className="absolute bottom-2 left-2 z-20 w-56 overflow-hidden rounded-xl border border-owl-border bg-owl-panel/95 shadow-xl shadow-black/30 backdrop-blur-sm">
				<header className="flex items-center justify-between px-2 py-1">
					<span className="text-[11px] font-medium text-owl-muted">最新截图</span>
					<button
						type="button"
						title="关闭"
						aria-label="关闭最新截图"
						onClick={onClose}
						className="flex h-5 w-5 items-center justify-center rounded text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
					>
						✕
					</button>
				</header>
				<img src={src} alt="最新截图" className="w-full cursor-zoom-in" onClick={() => setZoom(true)} />
			</div>
		</>
	);
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

	// -- 最新截图 Dock：转录里最后一张工具截图，贴底展示（ZCode 同款）---------
	const latestShot = useMemo(() => {
		let latest: { key: string; image: ToolResultImage } | undefined;
		entries.forEach((entry, index) => {
			if (entry.kind !== "assistant") return;
			for (const tool of entry.tools) {
				const images = tool.output?.images;
				if (images?.length) {
					latest = { key: `a${index}-tool-${tool.id}`, image: images[images.length - 1] };
				}
			}
		});
		return latest;
	}, [entries]);
	const [dismissedShotKey, setDismissedShotKey] = useState<string | undefined>(undefined);
	const showShotDock = latestShot !== undefined && latestShot.key !== dismissedShotKey;

	// -- 提问导航：视口所在的提问高亮，点击项平滑滚动到该提问 -------------------
	const questions = useMemo(() => buildQuestions(entries), [entries]);
	const [activeQuestion, setActiveQuestion] = useState(0);

	const updateActiveQuestion = (): void => {
		const el = container.current;
		if (!el || questions.length === 0) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
		if (atBottom) {
			// 贴底 = 正在读最后一个提问的回答（短回答时其节点不在顶部判定线内）
			setActiveQuestion((prev) => {
				const last = questions[questions.length - 1].n;
				return prev === last ? prev : last;
			});
			return;
		}
		const base = el.getBoundingClientRect().top;
		let active = 0;
		for (const question of questions) {
			const node = el.querySelector(`[data-qidx="${question.n}"]`);
			if (!node) break;
			// 顶部 140px 以内的最后一个提问 = 当前视口所在提问
			if (node.getBoundingClientRect().top - base <= 140) active = question.n;
			else break;
		}
		setActiveQuestion((prev) => (prev === active ? prev : active));
	};

	const jumpToQuestion = (n: number): void => {
		const el = container.current;
		const node = el?.querySelector(`[data-qidx="${n}"]`);
		if (!el || !node) return;
		// 导航跳转是明确的翻历史意图：关掉贴底跟随，避免流式输出把视图拽回去
		stick.current = false;
		const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16;
		el.scrollTo({ top, behavior: "smooth" });
	};

	// 会话切换/恢复后立即校准高亮，不等首次滚动
	useEffect(() => {
		updateActiveQuestion();
	}, [questions]); // eslint-disable-line react-hooks/exhaustive-deps

	const onScrollWithTracking = (): void => {
		const el = container.current;
		if (!el) return;
		// 离开底部（任何手段：滚动条拖动、键盘、触摸）即停跟随；回到贴底（<4px）才恢复。
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
		updateActiveQuestion();
	};

	return (
		<div className="relative min-h-0 flex-1">
			<main ref={container} onWheel={onWheel} onScroll={onScrollWithTracking} className="h-full overflow-y-auto px-3 py-5 sm:px-6">
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
							<div key={row.key} data-qidx={row.questionIndex} className="flex gap-2 sm:gap-3">
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
			<QuestionNavigator questions={questions} active={activeQuestion} onJump={jumpToQuestion} />
			{showShotDock && latestShot && (
				<ScreenshotDock shot={latestShot} onClose={() => setDismissedShotKey(latestShot.key)} />
			)}
		</div>
	);
}
