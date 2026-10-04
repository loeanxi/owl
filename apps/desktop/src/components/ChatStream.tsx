import { useEffect, useId, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import type { AssistantSegment, ChatEntry, MessageUsage, ToolCard, ToolResultImage, ToolStatus } from "../hooks/transcript.ts";
import { parseTodoArgs } from "../hooks/todo.ts";
import { toolRunLabel } from "../hooks/summarize.ts";
import { getUiLanguage, t, useT } from "../i18n/index.ts";
import { IconAlert, IconBranch, IconCheck, IconChevron, IconClock, IconCopy, IconCompose, IconLightbulb, IconRefresh, IconTerminal, IconThumbDown, IconThumbUp } from "./icons.tsx";
import { GenuiAnswerCard, GenuiToolCardView, useGenuiSession } from "./Genui.tsx";
import { collectHistoricalArtifacts, workspaceArtifactPath, type FileArtifact } from "../hooks/artifacts.ts";
import { Artifacts } from "./Artifacts.tsx";
import { TurnArtifacts } from "./ReviewChangesCard.tsx";
import { UsageOverview } from "./UsageOverview.tsx";
import type { BridgeClient } from "../bridge/client.ts";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 工具输出默认只预览末尾几行（结论/报错多在尾部），展开才看全文。 */
const OUTPUT_PREVIEW_LINES = 10;

export function renderMarkdown(text: string): string {
	return md.render(text);
}

/** token 计数的紧凑展示：832 / 45.3k / 2.9M（对话操作栏「用量」用）。 */
function compactNumber(value: number): string {
	if (value >= 100) return String(Math.round(value));
	return value.toFixed(1).replace(/\.0$/, "");
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${compactNumber(count / 1_000_000)}M`;
	if (count >= 1_000) return `${compactNumber(count / 1_000)}k`;
	return String(count);
}

/** 用量聚合：一轮多次 LLM 调用的成本相加（操作栏的「用量」展示整轮总量）。 */
function addUsage(base: MessageUsage | undefined, add: MessageUsage | undefined): MessageUsage | undefined {
	if (!add) return base;
	if (!base) return { ...add };
	return {
		input: base.input + add.input,
		output: base.output + add.output,
		cacheRead: base.cacheRead + add.cacheRead,
		cacheWrite: base.cacheWrite + add.cacheWrite,
	};
}

/** 消息时间戳的 HH:MM 展示（当天与否都不带日期，与参考实现一致保持轻量）。 */
function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 时长的紧凑展示（对照参考实现的「耗时 46m 24s」）。 */
function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * 每轮处理耗时（对照 Codex 的「耗时 …」）：用户消息时间戳 → 该轮最晚的
 * assistant 消息/工具完成时间。旧会话缺时间戳的轮不产出；流式中的最后一轮
 * 还在增长，也不产出（生成中有 ResponseActivity 兜底）。
 */
function turnDurationsOf(entries: ChatEntry[], streaming: boolean): Map<number, number> {
	const durations = new Map<number, number>();
	let lastAssistantIndex = -1;
	if (streaming) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]!.kind === "assistant") {
				lastAssistantIndex = i;
				break;
			}
		}
	}
	let userTs: number | undefined;
	let firstAssistant = -1;
	let endTs = 0;
	let turnLastIndex = -1;
	const finalize = (): void => {
		const inStreamingTurn = streaming && lastAssistantIndex !== -1 && turnLastIndex >= lastAssistantIndex;
		if (userTs !== undefined && firstAssistant !== -1 && endTs > userTs && !inStreamingTurn) {
			durations.set(firstAssistant, endTs - userTs);
		}
	};
	entries.forEach((entry, index) => {
		if (entry.kind === "user") {
			finalize();
			userTs = entry.timestamp;
			firstAssistant = -1;
			endTs = 0;
			turnLastIndex = index;
			return;
		}
		if (entry.kind !== "assistant") return;
		if (firstAssistant === -1) firstAssistant = index;
		turnLastIndex = index;
		// endedAt 是 message_end 的本地时刻（真实结束点）；timestamp 只是响应开始时刻，
		// 缺 endedAt 的旧会话（重启后）才回退用它，此时耗时会偏短
		if (entry.timestamp !== undefined) endTs = Math.max(endTs, entry.timestamp);
		if (entry.endedAt !== undefined) endTs = Math.max(endTs, entry.endedAt);
		for (const tool of entry.tools) {
			if (tool.finishedAt !== undefined) endTs = Math.max(endTs, tool.finishedAt);
		}
	});
	finalize();
	return durations;
}

/**
 * 消息反馈（赞/踩）的本地记忆：键 = `<会话>:msg<消息时间戳|下标>`，写 localStorage
 * 重启保留。没有任何服务端回传通道，纯 UI 态；写失败（配额/隐私模式）可接受。
 */
const FEEDBACK_STORAGE_KEY = "owl-chat-feedback";
const FEEDBACK_MAX_ENTRIES = 2000;
type FeedbackValue = "up" | "down";
const feedbackByMessage = new Map<string, FeedbackValue>();
let feedbackLoaded = false;

function loadFeedback(): void {
	if (feedbackLoaded) return;
	feedbackLoaded = true;
	try {
		const raw = localStorage.getItem(FEEDBACK_STORAGE_KEY);
		if (!raw) return;
		for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
			if (value === "up" || value === "down") feedbackByMessage.set(key, value);
		}
	} catch {
		// 损坏的本地数据直接当没有
	}
}

function saveFeedback(): void {
	// 只留最近的一批，避免长年累月无限膨胀
	while (feedbackByMessage.size > FEEDBACK_MAX_ENTRIES) {
		const oldest = feedbackByMessage.keys().next().value;
		if (oldest === undefined) break;
		feedbackByMessage.delete(oldest);
	}
	try {
		localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(Object.fromEntries(feedbackByMessage)));
	} catch {
		// 写失败可接受：反馈只是界面态
	}
}

/**
 * 聊天流 —— 用户提问与 agent 回答收进同一条居中内容列（响应式：窄窗满宽、宽窗封顶
 * 阅读宽度居中）。公开说明、工具调用与答案保留消息中的先后顺序。
 *
 * 过程采用「渐进披露」：工具调用默认收成一行人话摘要，连续的工具调用（名称可不同，
 * 如浏览器套件）合并成一组（「运行了 4 条命令」「浏览器操作 × 3」），点击逐级展开
 * 参数与输出；失败行自动展开标红。答案正文永远是主角，思考过程整轮合并成一条轻量折叠行。
 */

/** 内容流的一行；提问行带 questionIndex 作跳转锚点，操作栏行用更紧凑的包装。 */
type TimelineRow = {
	key: string;
	content: React.JSX.Element;
	questionIndex?: number;
	compact?: boolean;
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
	const [fullOutput, setFullOutput] = useState(false);
	const [zoomed, setZoomed] = useState(false);
	// 有图的结果(生图产物、浏览器截图)默认展开——图是这条工具调用的主要内容,
	// 折叠成一行摘要等于把产物藏起来;失败时也弹开(含流式中 running→error 转变)。
	const hasImages = (card.output?.images?.length ?? 0) > 0;
	const [open, setOpen] = useState(expanded || card.status === "error" || hasImages);
	useEffect(
		() => setOpen(expanded || card.status === "error" || (card.output?.images?.length ?? 0) > 0),
		[expanded, card.status, card.output?.images],
	);

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
					{(output?.text || card.detail) && (
						<div className="owl-tool-meta">
							{(card.finishedAt ?? card.startedAt) !== undefined && (
								<span>{formatClock(card.finishedAt ?? card.startedAt!)}</span>
							)}
							<CopyButton
								text={output?.text || card.detail || ""}
								label={t("chat.toolCopy")}
								className="owl-msg-action owl-tool-meta-copy"
							/>
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

/** 小型复制按钮：成功后短暂变 ✓；剪贴板不可用（权限/失焦）时静默。 */
function CopyButton({ text, label, className = "owl-msg-action" }: { text: string; label: string; className?: string }): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className={className}
			title={copied ? t("chat.msgCopied") : label}
			aria-label={copied ? t("chat.msgCopied") : label}
			onClick={async (event) => {
				event.stopPropagation();
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				} catch {
					// 打不开剪贴板就算了：不打断阅读
				}
			}}
		>
			{copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
		</button>
	);
}

/**
 * 回答底部操作栏（对照参考实现）：复制 / 赞 / 踩 / 在新对话中分支 /（仅最新一轮）
 * 重新生成 + 用量与时间元信息。一轮回答含多次 LLM 调用时只在最后一条下挂一条，
 * usage 传整轮聚合值。
 */
function AssistantFooter({ entry, storageKey, usage: usageOverride, canRegenerate, onRegenerate, canBranch, onBranch }: {
	entry: Extract<ChatEntry, { kind: "assistant" }>;
	storageKey: string;
	/** 整轮聚合用量；缺省退回本条消息自己的用量 */
	usage?: MessageUsage;
	canRegenerate: boolean;
	onRegenerate?: () => void;
	canBranch: boolean;
	onBranch?: () => void;
}): React.JSX.Element {
	const [feedback, setFeedback] = useState<FeedbackValue | undefined>(() => {
		loadFeedback();
		return feedbackByMessage.get(storageKey);
	});
	useEffect(() => setFeedback(feedbackByMessage.get(storageKey)), [storageKey]);
	const toggle = (value: FeedbackValue): void => {
		loadFeedback();
		const next = feedbackByMessage.get(storageKey) === value ? undefined : value;
		if (next) feedbackByMessage.set(storageKey, next);
		else feedbackByMessage.delete(storageKey);
		saveFeedback();
		setFeedback(next);
	};
	const usage = usageOverride ?? entry.usage;
	const totalTokens = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
	const usageTitle = usage
		? t("chat.msgUsageTitle", {
				input: formatTokenCount(usage.input),
				output: formatTokenCount(usage.output),
				cacheRead: formatTokenCount(usage.cacheRead),
				cacheWrite: formatTokenCount(usage.cacheWrite),
			})
		: undefined;
	return (
		<div className="owl-msg-actions">
			<CopyButton text={entry.text} label={t("chat.msgCopy")} />
			<button
				type="button"
				className="owl-msg-action"
				aria-pressed={feedback === "up"}
				title={t("chat.msgLike")}
				aria-label={t("chat.msgLike")}
				onClick={() => toggle("up")}
			>
				<IconThumbUp className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				className="owl-msg-action"
				aria-pressed={feedback === "down"}
				title={t("chat.msgDislike")}
				aria-label={t("chat.msgDislike")}
				onClick={() => toggle("down")}
			>
				<IconThumbDown className="h-3.5 w-3.5" />
			</button>
			{canBranch && onBranch && (
				<button
					type="button"
					className="owl-msg-action"
					title={t("chat.msgBranch")}
					aria-label={t("chat.msgBranch")}
					onClick={onBranch}
				>
					<IconBranch className="h-3.5 w-3.5" />
				</button>
			)}
			{canRegenerate && onRegenerate && (
				<button
					type="button"
					className="owl-msg-action"
					title={t("chat.msgRegenerate")}
					aria-label={t("chat.msgRegenerate")}
					onClick={onRegenerate}
				>
					<IconRefresh className="h-3.5 w-3.5" />
				</button>
			)}
			{usage && totalTokens > 0 && (
				<span className="owl-msg-meta" title={usageTitle}>
					{t("chat.msgUsage", { n: formatTokenCount(totalTokens) })}
				</span>
			)}
			{entry.timestamp !== undefined && <span className="owl-msg-meta">{formatClock(entry.timestamp)}</span>}
		</div>
	);
}

/** 用户提问行：随消息附的图片缩略图（点击放大）+ 文本气泡 + 悬停浮现的 编辑/复制/回退 按钮。 */
function UserRowView({
	entry,
	busy,
	onRewind,
	onEditMessage,
}: {
	entry: Extract<ChatEntry, { kind: "user" }>;
	busy: boolean;
	onRewind?: (entryId: string) => void;
	onEditMessage?: (entryId: string, text: string, images?: ToolResultImage[]) => void;
}): React.JSX.Element {
	const [zoomed, setZoomed] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(entry.text);
	const images = entry.images ?? [];
	const canRewind = Boolean(entry.entryId && onRewind);
	// 编辑=重发：回退到这条消息再发新文本（会截断其后对话），必须带 entryId 且会话空闲
	const canEdit = Boolean(entry.entryId && onEditMessage) && !busy;
	if (editing) {
		const submit = (): void => {
			const text = draft.trim();
			setEditing(false);
			if (!text || text === entry.text.trim() || !entry.entryId) return;
			onEditMessage?.(entry.entryId, text, images.length > 0 ? images : undefined);
		};
		return (
			<div className="owl-user-row">
				<div className="owl-user-editor">
					<textarea
						className="owl-user-editor-input"
						value={draft}
						rows={Math.min(12, Math.max(2, draft.split("\n").length))}
						autoFocus
						aria-label={t("chat.msgEditAria")}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								setEditing(false);
							} else if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						}}
					/>
					<div className="owl-user-editor-actions">
						<button type="button" className="owl-user-editor-button" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
						<button type="button" className="owl-user-editor-button is-primary" disabled={draft.trim() === ""} onClick={submit}>
							{t("chat.msgEditSend")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="owl-user-row">
			{canEdit && (
				<button
					type="button"
					className="owl-user-quick"
					title={t("chat.msgEdit")}
					aria-label={t("chat.msgEdit")}
					onClick={() => {
						setDraft(entry.text);
						setEditing(true);
					}}
				>
					<IconCompose className="h-3.5 w-3.5" />
				</button>
			)}
			<CopyButton text={entry.text} label={t("chat.msgCopy")} className="owl-user-quick" />
			{canRewind && (
				<button
					type="button"
					className="owl-rewind-trigger"
					title={t("rewind.buttonTitle")}
					aria-label={t("rewind.buttonTitle")}
					onClick={() => entry.entryId && onRewind?.(entry.entryId)}
				>
					↶
				</button>
			)}
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

/** buildRows 的上下文：渲染回调 + 消息操作（编辑/分支/重新生成）的可用性。 */
type RowOptions = {
	entries: ChatEntry[];
	expandedTools: boolean;
	onRewind?: (entryId: string) => void;
	cwd?: string;
	onOpenFile?: (path: string) => void;
	turnCard?: (artifacts: FileArtifact[]) => React.JSX.Element | null;
	/** 最新一轮回答还在流式：最后一条 assistant 不渲染操作栏。 */
	streaming: boolean;
	/** 赞/踩反馈的命名空间（sessionId；无会话上下文用固定值）。 */
	sessionKey: string;
	/** 会话空闲且最后一条用户消息带 entryId：最后一条回答可「重新生成」。 */
	canRegenerate: boolean;
	onRegenerate?: () => void;
	onEditMessage?: (entryId: string, text: string, images?: ToolResultImage[]) => void;
	/** 「在新对话中分支」：以该条回答为末梢复制新会话并切换。 */
	onBranch?: (entryId: string) => void;
	/** 会话忙（运行/提交中）：暂停用户消息的编辑重发。 */
	busy: boolean;
};

/** Keep prose and tool groups in the order emitted by the assistant. */
function buildRows({ entries, expandedTools, onRewind, cwd, onOpenFile, turnCard, streaming, sessionKey, canRegenerate, onRegenerate, onEditMessage, onBranch, busy }: RowOptions): TimelineRow[] {
	const rows: TimelineRow[] = [];
	// 改动卡要含代码文件（includeCode），与「成果文件」卡的默认口径不同
	const historicalArtifacts = cwd && onOpenFile ? collectHistoricalArtifacts(entries, cwd, { includeCode: true }) : undefined;
	// owl-genui：流式中的回答（最后一条 assistant）不带持久化身份，settled 后才有
	let lastAssistantIndex = -1;
	if (streaming) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]!.kind === "assistant") {
				lastAssistantIndex = i;
				break;
			}
		}
	}
	// 最后一条回答的操作栏：循环结束后若允许「重新生成」，换上带回调的版本
	let lastFooter: { row: TimelineRow; index: number; entry: Extract<ChatEntry, { kind: "assistant" }>; usage?: MessageUsage } | undefined;
	// 轮内操作栏收集：一轮（两条用户消息之间）可能含多次 LLM 调用（中间说明 + 最终回答），
	// 操作栏只保留轮内最后一条有正文的调用并把整轮用量聚到它身上，其余从行列表剔除
	let turnFooters: Array<{ row: TimelineRow; index: number; entry: Extract<ChatEntry, { kind: "assistant" }> }> = [];
	let turnUsage: MessageUsage | undefined;
	// 流式中的进行轮（最后一条用户消息之后的条目）还没定型，整轮操作栏等 agent_end 重建后再出现
	let lastUserIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.kind === "user") {
			lastUserIndex = i;
			break;
		}
	}
	// 操作栏工厂：分支按钮要求该条回答已带条目 id 且会话空闲；重新生成只在末条开启
	const assistantFooter = (entry: Extract<ChatEntry, { kind: "assistant" }>, index: number, allowRegenerate: boolean, usage?: MessageUsage): React.JSX.Element => (
		<AssistantFooter
			entry={entry}
			usage={usage}
			storageKey={`${sessionKey}:msg${entry.timestamp ?? index}`}
			canRegenerate={allowRegenerate}
			onRegenerate={allowRegenerate ? onRegenerate : undefined}
			canBranch={!busy && entry.entryId !== undefined && onBranch !== undefined}
			onBranch={entry.entryId !== undefined && onBranch ? () => onBranch(entry.entryId!) : undefined}
		/>
	);
	const finishTurnFooters = (): void => {
		const totalUsage = turnUsage;
		turnUsage = undefined;
		if (turnFooters.length === 0) return;
		const keep = turnFooters[turnFooters.length - 1]!;
		for (const item of turnFooters) {
			if (item === keep) continue;
			const position = rows.indexOf(item.row);
			if (position >= 0) rows.splice(position, 1);
		}
		// 幸存的操作栏按整轮聚合用量重渲染（push 时的值可能缺其后纯工具调用的用量）
		keep.row.content = assistantFooter(keep.entry, keep.index, false, totalUsage);
		lastFooter = { ...keep, usage: totalUsage };
		turnFooters = [];
	};
	// 每轮处理耗时：键 = 该轮第一条 assistant 的下标（Owl 标题行的位置）
	const turnDurations = turnDurationsOf(entries, streaming);
	let turn = 0;
	let assistantStarted = false;
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
				finishTurnFooters();
				flushTools();
				assistantStarted = false;
				const artifacts = historicalArtifacts?.get(index);
				if (artifacts && onOpenFile) {
					const node = turnCard ? turnCard(artifacts) : <Artifacts artifacts={artifacts} onOpenFile={onOpenFile} />;
					if (node) rows.push({ key: "artifacts-" + index, content: node });
				}
				turn += 1;
				rows.push({
					key: "q" + turn,
					questionIndex: turn,
					content: <UserRowView entry={entry} busy={busy} onRewind={onRewind} onEditMessage={onEditMessage} />,
				});
				return;
			}
		if (entry.kind === "toolResult") {
			flushTools();
			rows.push({ key: "result-" + index, content: <OrphanResultRow entry={entry} /> });
			return;
		}
		const seenTools = new Set<string>();
		// 整轮用量累计：纯工具调用的 LLM 轮没有正文、不上屏操作栏，但同样是整轮成本
		turnUsage = addUsage(turnUsage, entry.usage);
		const segments: AssistantSegment[] = entry.segments ?? [
			...(entry.thinking ? [{ kind: "thinking" as const, text: entry.thinking }] : []),
			...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []),
			...entry.tools.map((tool) => ({ kind: "tool" as const, toolId: tool.id })),
		];
		if (!assistantStarted && (entry.tools.length > 0 || entry.error || segments.some((segment) => segment.kind !== "tool" && segment.text.trim()))) {
			assistantStarted = true;
			const turnDuration = turnDurations.get(index);
			rows.push({
				key: "assistant-" + index,
				content: (
					<div className="owl-assistant-heading" data-fd-id="assistant-heading">
						<img src="/owl.svg" alt="" aria-hidden="true" className="owl-assistant-mark" draggable={false} />
						<span>Owl</span>
						{turnDuration !== undefined && (
							<span className="owl-turn-duration">{t("chat.turnDuration", { n: formatDuration(turnDuration) })}</span>
						)}
					</div>
				),
			});
		}
		const appendTool = (card: ToolCard): void => {
			seenTools.add(card.id);
			if (card.name === "todo") {
				flushTools();
				rows.push({ key: "todo-" + card.id, content: <TodoCardView card={card} /> });
			} else if (card.name === "ask_user_question") {
				flushTools();
				rows.push({ key: "question-tool-" + card.id, content: <ToolRowView card={card} expanded={expandedTools} /> });
			} else if (card.name === "render_ui" && card.output?.genuiSpec !== undefined) {
				// owl-genui：render_ui 完成后渲染为工具行交互卡片（运行中先走普通工具行）
				flushTools();
				rows.push({ key: "genui-" + card.id, content: <GenuiToolCardView card={card} /> });
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
					: <GenuiAnswerCard
							text={segment.text}
							identity={`msg${index}-seg${segmentIndex}`}
							settled={index !== lastAssistantIndex}
							renderMarkdown={renderMarkdown}
						/>,
			});
		});
		for (const card of entry.tools) if (!seenTools.has(card.id)) appendTool(card);
		if (entry.error) {
			flushTools();
			rows.push({ key: "error-" + index, content: <div className="owl-chat-error" role="alert">{entry.error}</div> });
		}
		// 回答底部操作栏：只挂在有正文的 assistant 上（纯工具调用不上屏）。一轮多次调用
		// 时先各自挂上，轮结束时 finishTurnFooters 只留最后一条；流式中的进行轮整轮不上屏
		// （等 agent_end 重建后一次性出现，避免中途闪现又消失）。
		if (
			segments.some((segment) => segment.kind === "text" && segment.text.trim() !== "") &&
			(lastAssistantIndex === -1 || index !== lastAssistantIndex) &&
			!(streaming && lastUserIndex !== -1 && index > lastUserIndex)
		) {
			flushTools();
			const row: TimelineRow = {
				key: "footer-" + index,
				compact: true,
				content: assistantFooter(entry, index, false, turnUsage),
			};
			rows.push(row);
			turnFooters.push({ row, index, entry });
		}
	});
	flushTools();
	finishTurnFooters();
	// 重新生成只出现在最后一条回答的操作栏上：对最后一条用户消息整轮「仅回退对话」后重发
	if (lastFooter && canRegenerate && onRegenerate) {
		lastFooter.row.content = assistantFooter(lastFooter.entry, lastFooter.index, true, lastFooter.usage);
	}
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

export type ChatActivity = "idle" | "working" | "waiting" | "disconnected";

function ResponseActivity({ entries, activity }: { entries: ChatEntry[]; activity: ChatActivity }): React.JSX.Element | null {
	// 实时已耗时：从本轮用户消息发出时刻起跳（旧会话消息缺时间戳则不显示）。
	// 每秒走一次状态更新，驱动文案跳动；组件只在会话忙时挂载，空闲自动卸载。
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	if (activity === "idle") return null;
	let executing = false;
	let userTs: number | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.kind === "user") {
			userTs = entry.timestamp;
			break;
		}
		if (entry.kind === "assistant" && entry.tools.some((tool) => tool.status === "running")) executing = true;
	}
	const label = activity === "waiting" ? t("chat.activityWaiting") : activity === "disconnected" ? t("chat.activityDisconnected") : executing ? t("chat.activityExecuting") : t("chat.activityGenerating");
	const elapsed = userTs !== undefined ? formatDuration(Math.max(0, now - userTs)) : undefined;
	return (
		<div className="owl-response-activity" data-state={activity} role="status">
			<img src="/owl.svg" alt="" aria-hidden="true" className="owl-response-mark" />
			<span>{label}</span>
			{elapsed && <span className="owl-turn-duration">{t("chat.turnDuration", { n: elapsed })}</span>}
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
	artifacts,
	cwd,
	onOpenFile,
	activity = "idle",
	onRewind,
	client,
	onOpenReview,
	onRegenerate,
	onEditMessage,
	onBranch,
}: {
	entries: ChatEntry[];
	activity?: ChatActivity;
	/** 空会话开始页的菜单卡回调（打开工作台对应面板）。 */
	onQuickAction?: (kind: string) => void;
	onPromptExample?: (text: string) => void;
	onOpenDeveloper?: () => void;
	artifacts?: React.ReactNode;
	cwd?: string;
	onOpenFile?: (path: string) => void;
	/** 用户消息 ↶ 回退（owl-rewind）：传了才渲染按钮，未带 entryId 的行不渲染。 */
	onRewind?: (entryId: string) => void;
	/** 桥客户端：历史轮的改动卡（diffApproval.*）需要；缺省回退旧「成果文件」卡。 */
	client?: BridgeClient;
	/** 历史轮改动卡的「工作台审查」跳转（带聚焦路径）。 */
	onOpenReview?: (focusPath: string) => void;
	/** 回答操作栏的「重新生成」：对最后一条用户消息整轮仅回退对话后重发。 */
	onRegenerate?: () => void;
	/** 用户消息的「编辑重发」：回退到该条消息（仅对话）后发送新文本。 */
	onEditMessage?: (entryId: string, text: string, images?: ToolResultImage[]) => void;
	/** 回答操作栏的「在新对话中分支」：以该条回答为末梢复制新会话并切换。 */
	onBranch?: (entryId: string) => void;
}): React.JSX.Element {
	const t = useT();
	const emptyHeadingId = useId();
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
	const turnCard = useMemo(() => {
		if (cwd === undefined || client === undefined || onOpenReview === undefined) return undefined;
		return (turnArtifacts: FileArtifact[]): React.JSX.Element | null => (
			<TurnArtifacts artifacts={turnArtifacts} cwd={cwd} client={client} onOpenFile={onOpenFile ?? (() => undefined)} onOpenReview={onOpenReview} />
		);
	}, [cwd, client, onOpenFile, onOpenReview]);
	// 会话忙（生成/工具执行/提交中）：暂停重新生成与用户消息编辑，避免与运行中的轮次互相踩
	const busy = activity !== "idle";
	// 重新生成的目标 = 最后一条用户消息；它还没有 entryId（乐观行未确认）时无从回退，先不挂按钮
	const canRegenerate = useMemo(() => {
		if (busy || !onRegenerate) return false;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			if (entry.kind === "user") return Boolean(entry.entryId);
		}
		return false;
	}, [busy, onRegenerate, entries]);
	const { sessionId } = useGenuiSession();
	const rows = useMemo(
		() =>
			buildRows({
				entries,
				expandedTools,
				onRewind,
				cwd,
				onOpenFile,
				turnCard,
				streaming: activity === "working",
				sessionKey: sessionId ?? "shared",
				canRegenerate,
				onRegenerate,
				onEditMessage,
				onBranch,
				busy,
			}),
		[entries, expandedTools, onRewind, cwd, onOpenFile, turnCard, activity, sessionId, canRegenerate, onRegenerate, onEditMessage, onBranch, busy],
	);

	// -- 最新截图 Dock：转录里最后一张**浏览器截图**，贴底展示（ZCode 同款）-----
	// 只收浏览器/页面截图类工具：生图类工具（owl-image 的 generate/edit_image）的
	// 产物属于会话内容,已内嵌渲染在各自工具卡片里,不进 Dock 浮窗。
	const SCREENSHOT_TOOL_PATTERN = /^(browser_screenshot|mcp_playwright_\w*screenshot\w*|iab_screenshot)$/i;
	const latestShot = useMemo(() => {
		let latest: { key: string; image: ToolResultImage } | undefined;
		entries.forEach((entry, index) => {
			if (entry.kind !== "assistant") return;
			for (const tool of entry.tools) {
				if (!SCREENSHOT_TOOL_PATTERN.test(tool.name)) continue;
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

	useEffect(() => {
		const el = container.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			if (el.clientHeight === 0 || el.clientWidth === 0) return;
			// 提问卡展开或收起会改变聊天视口：贴底时跟随，翻历史或导航时保留位置。
			const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
			if (stick.current && navigationTarget.current === null && Math.abs(el.scrollTop - bottom) > 1) {
				el.scrollTop = bottom;
			}
			onScrollWithTracking();
		});
		observer.observe(el);
		// 内容列也要观察：面板/卡片异步加载改变内容高度时容器自身并不 resize，
		// 不补这个观察，「回到最新」会停在内容变化前的过期状态（如空态面板加载完
		// 成后按钮误显示并盖住面板底部）。
		const content = el.firstElementChild;
		if (content) observer.observe(content);
		return () => observer.disconnect();
	}, [questions]); // eslint-disable-line react-hooks/exhaustive-deps

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
						{/* 空会话开始页：问候语 + 使用概览面板（Claude Desktop 同款，桥的 usage.get 供数） */}
						{entries.length === 0 && <section className="owl-chat-empty" data-fd-id="chat-empty" aria-labelledby={emptyHeadingId}><img src="/owl.svg" alt="" aria-hidden="true" className="owl-chat-empty-mark" draggable={false} /><h1 id={emptyHeadingId}>{t("chat.emptyGreeting")}</h1>{client && <UsageOverview client={client} />}</section>}
						{rows.map((row) => <div key={row.key} data-qidx={row.questionIndex} className={row.questionIndex ? "owl-chat-question" : row.compact ? "owl-chat-row owl-chat-row-compact" : "owl-chat-row"}>{row.content}</div>)}
						<ResponseActivity entries={entries} activity={activity} />
						{artifacts}
					</div>
				</main>
			</div>
			{showLatest && <button className="owl-chat-latest" type="button" onClick={() => { navigationTarget.current = null; stick.current = true; const el = container.current; if (el) el.scrollTop = el.scrollHeight; setShowLatest(false); }}>{t("chat.backToLatest")} <span aria-hidden="true">↓</span></button>}
			{showShotDock && latestShot && <ScreenshotDock shot={latestShot} onClose={() => setDismissedShotKey(latestShot.key)} />}
		</div>
	);
}
