import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import type { AssistantSegment, ChatEntry, ToolCard, ToolResultImage, ToolStatus } from "../hooks/transcript.ts";
import { parseTodoArgs } from "../hooks/todo.ts";
import { toolRunLabel } from "../hooks/summarize.ts";
import { getUiLanguage, t, useT } from "../i18n/index.ts";
import { IconAlert, IconCheck, IconChevron, IconClock, IconLightbulb, IconTerminal } from "./icons.tsx";
import { StartPage } from "./StartPage.tsx";
import { workspaceArtifactPath } from "../hooks/artifacts.ts";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 工具输出默认只预览末尾几行（结论/报错多在尾部），展开才看全文。 */
const OUTPUT_PREVIEW_LINES = 10;

export function renderMarkdown(text: string): string {
	return md.render(text);
}

/**
 * 聊天流 —— 用户提问与 agent 回答收进同一条居中内容列（响应式：窄窗满宽、宽窗封顶
 * 阅读宽度居中）。公开说明、工具调用与答案保留消息中的先后顺序。
 *
 * 过程采用「渐进披露」：工具调用默认收成一行人话摘要，连续的工具调用（名称可不同，
 * 如浏览器套件）合并成一组（「运行了 4 条命令」「浏览器操作 × 3」），点击逐级展开
 * 参数与输出；失败行自动展开标红。答案正文永远是主角，思考过程整轮合并成一条轻量折叠行。
 */

/** 内容流的一行；提问行带 questionIndex 作跳转锚点。 */
type TimelineRow = {
	key: string;
	content: React.JSX.Element;
	questionIndex?: number;
};

/** 渲染含 `code` 反引号的摘要行（工具摘要里的命令/路径/模式）。 */
export function InlineSummary({ text }: { text: string }): React.JSX.Element {
	const parts = text.split(/`([^`]*)`/);
	return (
		<>
			{parts.map((part, index) =>
				index % 2 === 1 ? (
					<code key={index} className="owl-tool-inline-code">
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
	if (status === "pending") return <IconClock className="h-3.5 w-3.5 shrink-0 text-owl-faint" />;
	if (status === "cancelled") return <span className="h-3.5 w-3.5 shrink-0 text-center text-owl-faint" aria-label={t("chat.cancelled")}>—</span>;
	if (status === "running") {
		return (
			<span
				aria-label={t("chat.runningAria")}
				className="owl-tool-spinner"
			/>
		);
	}
	if (status === "error") return <IconAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />;
	return <IconCheck className="h-3.5 w-3.5 shrink-0 text-owl-faint" />;
}

/** 思考过程：整轮合并成一条轻量折叠行，默认收起，不再一段一个全宽条。 */
function ThinkingRow({ thinking }: { thinking: string }): React.JSX.Element {
	const lines = useMemo(
		() => thinking.split("\n").filter((line) => line.trim() !== "").length,
		[thinking],
	);
	return (
		<details className="owl-thinking group">
			<summary className="flex cursor-pointer select-none list-none items-center gap-1.5 py-0.5 [&::-webkit-details-marker]:hidden">
				<IconLightbulb className="h-3.5 w-3.5" />
				<IconChevron className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
				{t("chat.thinkingLines", { n: lines })}
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
function ToolRowView({ card, expanded = false }: { card: ToolCard; expanded?: boolean }): React.JSX.Element {
	const [open, setOpen] = useState(expanded || card.status === "error");
	useEffect(() => setOpen(expanded || card.status === "error"), [expanded, card.status === "error"]);
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
		<div className="owl-tool-row" data-status={card.status}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="owl-tool-summary"
			>
				<StatusIcon status={card.status} />
				<span
					className={`min-w-0 flex-1 truncate ${card.status === "error" ? "text-red-400" : "text-owl-muted"}`}
				>
					<InlineSummary text={card.summary} />
				</span>
				{card.status === "cancelled" && <span className="text-xs text-owl-faint">{t("chat.cancelled")}</span>}
				<IconChevron
					className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{open && (
				<div className="owl-tool-detail">
					{card.detail && (
						<pre className="owl-tool-command">
							{card.detail}
						</pre>
					)}
					{output && output.text !== "" && (
						<>
							<pre className="owl-tool-output">
								{fullOutput || !hasMore ? output.text : `${t("chat.outputTruncated", { n: dropped })}\n${preview}`}
							</pre>
							{hasMore && (
								<button
									type="button"
									onClick={() => setFullOutput((value) => !value)}
									className="text-[11px] text-owl-accent transition-colors hover:text-owl-accent-hover"
								>
									{fullOutput ? t("chat.collapseOutput") : t("chat.expandOutput", { n: output.totalLines })}
								</button>
							)}
						</>
					)}
					{/* 服务端 50KB 截断后全文在临时文件里；文本里没带路径时补一行提示 */}
					{output?.fullPath && !output.text.includes(output.fullPath) && (
						<p className="truncate font-mono text-[11px] text-owl-faint" title={output.fullPath}>
							{t("chat.fullOutputPath", { path: output.fullPath })}
						</p>
					)}
					{images.length > 0 && (
						<div className="space-y-2">
							{images.map((image, index) => (
								<img
									key={index}
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={t("chat.toolScreenshot", { name: card.name, i: index + 1 })}
									className={`w-full cursor-zoom-in rounded-lg border border-owl-border ${zoomed ? "" : "max-h-72 object-contain object-top"}`}
									onClick={() => setZoomed((value) => !value)}
								/>
							))}
							<button
								type="button"
								onClick={() => setZoomed((value) => !value)}
								className="text-[11px] text-owl-accent transition-colors hover:text-owl-accent-hover"
							>
								{zoomed ? t("common.collapse") : t("chat.viewFullImage")}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** 连续工具调用的合组（名称可不同）：失败自动展开，展开后每行再各自展开。 */
function ToolGroupView({ label, cards, expanded = false }: { label: string; cards: ToolCard[]; expanded?: boolean }): React.JSX.Element {
	const [open, setOpen] = useState(() => expanded || cards.some((card) => card.status === "error"));
	useEffect(() => setOpen(expanded), [expanded]);
	const errorCount = cards.filter((card) => card.status === "error").length;
	const running = cards.some((card) => card.status === "running");
	useEffect(() => {
		if (errorCount > 0) setOpen(true);
	}, [errorCount]);

	return (
		<div className={`owl-tool-group ${open ? "is-open" : ""}`}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="owl-tool-summary owl-tool-group-summary"
			>
				<IconTerminal className="h-3.5 w-3.5 shrink-0 text-owl-faint" />
				<IconChevron
					className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<span className="min-w-0 flex-1 truncate text-owl-muted">{label}</span>
				{running ? (
					<span className="flex shrink-0 items-center gap-1.5 text-owl-accent">
						{t("chat.groupRunning")}
					</span>
				) : errorCount > 0 ? (
					<span className="shrink-0 text-red-400">
						{t("chat.groupFailed", { n: errorCount })}
					</span>
				) : null}
			</button>
			{open && (
				<div className="owl-tool-group-body">
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
				<span className="font-medium text-owl-text">{t("todo.title")}</span>
				<span className="text-owl-faint">
					{t("todo.progress", { done, total: items.length })}{card.status === "running" ? t("todo.updating") : ""}
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
			className="owl-answer"
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

/** 用户提问行：随消息附的图片缩略图（点击放大）+ 文本气泡。 */
function UserRowView({ entry }: { entry: Extract<ChatEntry, { kind: "user" }> }): React.JSX.Element {
	const [zoomed, setZoomed] = useState(false);
	const images = entry.images ?? [];
	return (
		<div className="owl-user-row">
			<div className="owl-user-bubble">
				{images.length > 0 && (
					<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
						{images.map((image, index) => (
							<img
								key={index}
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={t("chat.attachment", { n: index + 1 })}
								className="max-h-44 max-w-56 cursor-zoom-in rounded-lg border border-owl-border object-contain"
								onClick={() => setZoomed(true)}
							/>
						))}
					</div>
				)}
				{entry.text}
			</div>
			{zoomed && images.length > 0 && (
				<div
					className="fixed inset-0 z-50 flex flex-wrap items-center justify-center gap-3 overflow-auto bg-black/80 p-6"
					onClick={() => setZoomed(false)}
				>
					{images.map((image, index) => (
						<img
							key={index}
							src={`data:${image.mimeType};base64,${image.data}`}
							alt={t("chat.attachment", { n: index + 1 })}
							className="max-h-full max-w-full rounded-lg border border-owl-border shadow-2xl"
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** Keep prose and tool groups in the order emitted by the assistant. */
function buildRows(entries: ChatEntry[], expandedTools: boolean): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let turn = 0;
	let pendingTools: ToolCard[] = [];
	const flushTools = (): void => {
		if (pendingTools.length === 0) return;
		const cards = pendingTools;
		pendingTools = [];
		rows.push({
			key: "tools-" + cards[0]!.id,
			content: cards.length === 1
				? <ToolRowView card={cards[0]!} expanded={expandedTools} />
				: <ToolGroupView label={toolRunLabel(cards.map((card) => card.name), cards.length)} cards={cards} expanded={expandedTools} />,
		});
	};
	entries.forEach((entry, index) => {
		if (entry.kind === "user") {
			flushTools();
			turn += 1;
			rows.push({
				key: "q" + turn,
				questionIndex: turn,
				content: <UserRowView entry={entry} />,
			});
			return;
		}
		if (entry.kind === "toolResult") {
			flushTools();
			rows.push({ key: "result-" + index, content: <OrphanResultRow entry={entry} /> });
			return;
		}
		const seenTools = new Set<string>();
		const segments: AssistantSegment[] = entry.segments ?? [
			...(entry.thinking ? [{ kind: "thinking" as const, text: entry.thinking }] : []),
			...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []),
			...entry.tools.map((tool) => ({ kind: "tool" as const, toolId: tool.id })),
		];
		const appendTool = (card: ToolCard): void => {
			seenTools.add(card.id);
			if (card.name === "todo") {
				flushTools();
				rows.push({ key: "todo-" + card.id, content: <TodoCardView card={card} /> });
			} else if (card.name === "ask_user_question") {
				flushTools();
				rows.push({ key: "question-tool-" + card.id, content: <ToolRowView card={card} expanded={expandedTools} /> });
			} else pendingTools.push(card);
		};
		segments.forEach((segment, segmentIndex) => {
			if (segment.kind === "tool") {
				const card = entry.tools.find((tool) => tool.id === segment.toolId);
				if (card && !seenTools.has(card.id)) appendTool(card);
				return;
			}
			if (!segment.text.trim()) return;
			flushTools();
			rows.push({
				key: "message-" + index + "-" + segmentIndex,
				content: segment.kind === "thinking"
					? <ThinkingRow thinking={segment.text} />
					: <AnswerCard text={segment.text} />,
			});
		});
		for (const card of entry.tools) if (!seenTools.has(card.id)) appendTool(card);
		if (entry.error) {
			flushTools();
			rows.push({ key: "error-" + index, content: <div className="owl-chat-error" role="alert">{entry.error}</div> });
		}
	});
	flushTools();
	return rows;
}

type QuestionMark = { n: number; text: string; preview: string };

function buildQuestions(entries: ChatEntry[]): QuestionMark[] {
	return entries.filter((entry) => entry.kind === "user").map((entry, index) => {
		const preview = entry.text.trim() || (entry.images?.length
			? t("chat.questionImages", { n: entry.images.length })
			: t("chat.questionFallback", { n: index + 1 }));
		return { n: index + 1, text: preview.split("\n")[0], preview };
	});
}

/** 常驻提问短线；预览置于滚动列表外，长会话也不会裁掉浮层。 */
function QuestionMinimap({ questions, active, onJump }: {
	questions: QuestionMark[];
	active: number;
	onJump: (n: number) => void;
}): React.JSX.Element {
	const t = useT();
	const root = useRef<HTMLElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [preview, setPreview] = useState<{ n: number; top: number } | null>(null);
	const question = questions.find((item) => item.n === preview?.n);

	useEffect(() => {
		const el = list.current;
		const mark = el?.querySelector<HTMLElement>(`[data-question-index="${active}"]`);
		if (!el || !mark) return;
		const top = mark.offsetTop;
		if (top < el.scrollTop) el.scrollTop = top;
		else if (top + mark.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + mark.offsetHeight - el.clientHeight;
	}, [active, questions.length]);

	const showPreview = (n: number, button: HTMLButtonElement): void => {
		const bounds = root.current?.getBoundingClientRect();
		if (!bounds) return;
		const mark = button.getBoundingClientRect();
		const margin = Math.min(88, bounds.height / 2);
		setPreview({ n, top: Math.max(margin, Math.min(bounds.height - margin, mark.top + mark.height / 2 - bounds.top)) });
	};

	return (
		<nav ref={root} className="owl-chat-minimap" aria-label={t("chat.questionNavigation")} onMouseLeave={() => setPreview(null)} onBlur={(event) => {
			if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null);
		}} onKeyDown={(event) => { if (event.key === "Escape") setPreview(null); }}>
			<div ref={list} className="owl-chat-minimap-marks" onScroll={() => {
				const focused = document.activeElement;
				if (focused instanceof HTMLButtonElement && list.current?.contains(focused)) showPreview(Number(focused.dataset.questionIndex), focused);
				else setPreview(null);
			}}>
				{questions.map((item) => (
					<button key={item.n} type="button" data-question-index={item.n}
						aria-label={t("chat.jumpToQuestion", { n: item.n, text: item.text })}
						aria-current={active === item.n ? "location" : undefined}
						onMouseEnter={(event) => showPreview(item.n, event.currentTarget)}
						onFocus={(event) => showPreview(item.n, event.currentTarget)}
						onClick={() => { setPreview(null); onJump(item.n); }}>
						<span className="owl-chat-minimap-mark" aria-hidden="true" />
					</button>
				))}
			</div>
			{question && preview && (
				<div className="owl-chat-minimap-preview" style={{ top: preview.top }} aria-hidden="true">
					<span className="owl-chat-minimap-preview-label">{t("chat.questionFallback", { n: question.n })}</span>
					<p>{question.preview}</p>
				</div>
			)}
		</nav>
	);
}

function QuestionNavigator({ questions, active, onJump, onClose }: {
	questions: QuestionMark[];
	active: number;
	onJump: (n: number) => void;
	onClose: () => void;
}): React.JSX.Element {
	return (
		<aside id="owl-chat-directory" className="owl-chat-directory" aria-label={t("chat.directoryAria")}>
			<header><span>{t("chat.directoryTitle", { n: questions.length })}</span><button type="button" className="owl-chrome-button" aria-label={t("chat.directoryCollapse")} onClick={onClose}><IconChevron className="h-4 w-4" /></button></header>
			<nav>
				{questions.map((question) => <button key={question.n} type="button" aria-current={active === question.n ? "location" : undefined} onClick={() => onJump(question.n)}><span>{question.n}</span><span title={question.text}>{question.text}</span></button>)}
			</nav>
		</aside>
	);
}

export type ChatActivity = "idle" | "working" | "waiting" | "disconnected";

function ResponseActivity({ entries, activity }: { entries: ChatEntry[]; activity: ChatActivity }): React.JSX.Element | null {
	if (activity === "idle") return null;
	let executing = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.kind === "user") break;
		if (entry.kind === "assistant" && entry.tools.some((tool) => tool.status === "running")) executing = true;
	}
	const label = activity === "waiting" ? t("chat.activityWaiting") : activity === "disconnected" ? t("chat.activityDisconnected") : executing ? t("chat.activityExecuting") : t("chat.activityGenerating");
	return <div className="owl-response-activity" data-state={activity} role="status"><img src="/owl.svg" alt="" aria-hidden="true" className="owl-response-mark" /><span>{label}</span></div>;
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
					<img src={src} alt={t("chat.fullScreenshot")} className="max-h-full max-w-full rounded-lg border border-owl-border shadow-2xl" />
				</div>
			)}
			<div className="owl-screenshot-dock absolute bottom-2 left-2 z-20 w-56 overflow-hidden rounded-xl border border-owl-border bg-owl-panel/95 shadow-xl shadow-black/30 backdrop-blur-sm">
				<header className="flex items-center justify-between px-2 py-1">
					<span className="text-[11px] font-medium text-owl-muted">{t("chat.latestScreenshot")}</span>
					<button
						type="button"
						title={t("window.close")}
						aria-label={t("chat.closeLatest")}
						onClick={onClose}
						className="flex h-5 w-5 items-center justify-center rounded text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
					>
						✕
					</button>
				</header>
				<img src={src} alt={t("chat.latestScreenshot")} className="w-full cursor-zoom-in" onClick={() => setZoom(true)} />
			</div>
		</>
	);
}

export function ChatStream({
	entries,
	onQuickAction,
	onPromptExample,
	onOpenDeveloper,
	artifacts,
	cwd,
	onOpenFile,
	activity = "idle",
	navigationOpen = false,
	onNavigationClose,
}: {
	entries: ChatEntry[];
	activity?: ChatActivity;
	navigationOpen?: boolean;
	onNavigationClose?: () => void;
	/** 空会话开始页的菜单卡回调（打开工作台对应面板）。 */
	onQuickAction?: (kind: string) => void;
	onPromptExample?: (text: string) => void;
	onOpenDeveloper?: () => void;
	artifacts?: React.ReactNode;
	cwd?: string;
	onOpenFile?: (path: string) => void;
}): React.JSX.Element {
	const t = useT();
	const container = useRef<HTMLElement>(null);
	// 跟随新内容滚动的开关。用户的向上滚动意图（滚轮/触控板/拖滚动条/翻页键）立即关闭，
	// 只有视口真正回到贴底位置才重新打开——流式输出期间翻历史不会被拽回底部。
	const stick = useRef(true);
	const navigationTarget = useRef<number | null>(null);
	const prevEntries = useRef<ChatEntry[]>([]);
	const [showLatest, setShowLatest] = useState(false);

	const onWheel = (event: React.WheelEvent<HTMLElement>): void => {
		navigationTarget.current = null;
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

	const [expandedTools, setExpandedTools] = useState(() => document.documentElement.dataset.owlToolRecords === "expanded");
	useEffect(() => {
		const update = (): void => setExpandedTools(document.documentElement.dataset.owlToolRecords === "expanded");
		update();
		window.addEventListener("owl-chat-appearance-change", update);
		return () => window.removeEventListener("owl-chat-appearance-change", update);
	}, []);
	const rows = useMemo(() => buildRows(entries, expandedTools), [entries, expandedTools]);

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
	const uiLanguage = getUiLanguage();
	const questions = useMemo(() => buildQuestions(entries), [entries, uiLanguage]);
	const [activeQuestion, setActiveQuestion] = useState(0);

	const updateActiveQuestion = (): void => {
		const el = container.current;
		if (!el || questions.length === 0 || navigationTarget.current !== null) return;
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
		let active = questions[0].n;
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
		setActiveQuestion(n);
		const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
		const top = Math.max(0, Math.min(maxTop, node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16));
		navigationTarget.current = Math.abs(el.scrollTop - top) > 1 ? top : null;
		if (navigationTarget.current === null) stick.current = maxTop - top < 24;
		el.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
		setShowLatest(maxTop - top >= 24);
		if ((el.parentElement?.clientWidth ?? 1000) < 700) onNavigationClose?.();
	};

	// 会话切换/恢复后立即校准高亮，不等首次滚动
	useEffect(() => {
		updateActiveQuestion();
	}, [questions]); // eslint-disable-line react-hooks/exhaustive-deps

	const onScrollWithTracking = (): void => {
		const el = container.current;
		if (!el) return;
		// 平滑跳转第一帧仍靠近底部，抵达目标前不能重新开启贴底跟随。
		if (navigationTarget.current !== null) {
			if (Math.abs(el.scrollTop - navigationTarget.current) > 1) return;
			navigationTarget.current = null;
		}
		// 离开底部（任何手段：滚动条拖动、键盘、触摸）即停跟随；回到贴底（<4px）才恢复。
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
		setShowLatest(!stick.current);
		updateActiveQuestion();
	};

	return (
		<div className="owl-chat-surface" data-activity={activity}>
			{questions.length > 0 && <QuestionMinimap questions={questions} active={activeQuestion} onJump={jumpToQuestion} />}
			<div className="owl-chat-layout">
				<main ref={container} onWheel={onWheel} onScroll={onScrollWithTracking} onScrollEnd={() => { navigationTarget.current = null; onScrollWithTracking(); }} onPointerDown={() => { navigationTarget.current = null; }} onTouchStart={() => { navigationTarget.current = null; }} onKeyDown={() => { navigationTarget.current = null; }} className="owl-chat-scroll" aria-label={t("chat.messagesAria")} onClick={(event) => {
					if (!cwd || !onOpenFile || !(event.target instanceof Element)) return;
					const anchor = event.target.closest<HTMLAnchorElement>(".owl-answer a[href]");
					const href = anchor?.getAttribute("href");
					if (!href || href.startsWith("#")) return;
					const path = workspaceArtifactPath(href.split("#")[0].replace(/:\d+$/, ""), cwd, { encoded: true });
					if (!path) return;
					event.preventDefault();
					onOpenFile(path);
				}}>
					<div className="owl-chat-column">
						{entries.length === 0 && (onQuickAction && onPromptExample && onOpenDeveloper ? <StartPage onAction={onQuickAction} onPrompt={onPromptExample} onOpenDeveloper={onOpenDeveloper} /> : <div className="mt-[22vh] flex flex-col items-center"><img src="/owl.svg" alt="" className="h-12 w-12 opacity-90" /><p className="mt-5 text-2xl text-owl-text">{t("chat.emptyGreeting")}</p></div>)}
						{rows.map((row) => <div key={row.key} data-qidx={row.questionIndex} className={row.questionIndex ? "owl-chat-question" : "owl-chat-row"}>{row.content}</div>)}
						<ResponseActivity entries={entries} activity={activity} />
						{artifacts}
					</div>
				</main>
				{navigationOpen && questions.length > 0 && <QuestionNavigator questions={questions} active={activeQuestion} onJump={jumpToQuestion} onClose={() => onNavigationClose?.()} />}
			</div>
			{showLatest && <button className="owl-chat-latest" type="button" onClick={() => { navigationTarget.current = null; stick.current = true; const el = container.current; if (el) el.scrollTop = el.scrollHeight; setShowLatest(false); }}>{t("chat.backToLatest")} <span aria-hidden="true">↓</span></button>}
			{showShotDock && latestShot && <ScreenshotDock shot={latestShot} onClose={() => setDismissedShotKey(latestShot.key)} />}
		</div>
	);
}
