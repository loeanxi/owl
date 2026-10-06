import { useEffect, useId, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import type { AssistantSegment, ChatEntry, MessageUsage, ToolCard, ToolResultImage, ToolStatus } from "../hooks/transcript.ts";
import { toolRunLabel } from "../hooks/summarize.ts";
import { getUiLanguage, t, useT } from "../i18n/index.ts";
import { IconAlert, IconBranch, IconCheck, IconChevron, IconClock, IconCopy, IconCompose, IconLightbulb, IconRefresh, IconTerminal } from "./icons.tsx";
import { GenuiAnswerCard, GenuiToolCardView } from "./Genui.tsx";
import { collectHistoricalArtifacts, workspaceArtifactPath, type FileArtifact } from "../hooks/artifacts.ts";
import { Artifacts } from "./Artifacts.tsx";
import { TurnArtifacts } from "./ReviewChangesCard.tsx";
import { UsageOverview } from "./UsageOverview.tsx";
import { OwlMascot, useSessionOwlPose } from "./OwlMascot.tsx";
import type { BridgeClient } from "../bridge/client.ts";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 工具输出默认只预览末尾几行（结论/报错多在尾部），展开才看全文。 */
const OUTPUT_PREVIEW_LINES = 10;

/** 截图类工具：产物是「给用户看的屏幕画面」，进最新截图 Dock 与轮末截图条。 */
const SCREENSHOT_TOOL_PATTERN = /^(computer_screenshot|browser_screenshot|mcp_playwright_\w*screenshot\w*|iab_screenshot)$/i;

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
 * 聊天流 —— 用户提问与 agent 回答收进同一条居中内容列（响应式：窄窗满宽、宽窗封顶
 * 阅读宽度居中）。公开说明、工具调用与答案保留消息中的先后顺序。
 *
 * 过程采用「渐进披露」：一次提问到该轮最终回答之间的思考、工具调用与中间说明整轮
 * 收进一条「工作过程 · N 步」折叠行（回合进行中转圈并实时计数），所有层级统一默认
 * 收起，失败只标红计数，用户点击才逐级展开。提问卡、渲染卡与错误是里程碑，原位可见
 * 并把工作段切成数段；任务清单的实时状态由输入区上方的常驻组件（TodoPin）独占展示，
 * 时间轴不再重复上屏。答案正文与其操作栏永远展开。
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
 * 输出（默认末 10 行，可看全文）。autoOpen=false（工作过程折叠区内）时不因带图
 * 自动弹开。失败只标红、不自动展开：自动弹开会抢走用户当前注意力，展开交给用户。
 */
function ToolRowView({ card, expanded = false, autoOpen = true }: { card: ToolCard; expanded?: boolean; autoOpen?: boolean }): React.JSX.Element {
	const [fullOutput, setFullOutput] = useState(false);
	// 点击图片/「查看完整大图」打开屏幕居中灯箱（不再卡片内撑开把时间轴挤跳）。
	const [zoomIndex, setZoomIndex] = useState<number | null>(null);
	const hasImages = (card.output?.images?.length ?? 0) > 0;
	const [open, setOpen] = useState(expanded || (autoOpen && hasImages));
	useEffect(() => {
		// 只自动弹开、不自动收起：状态迁移时重算 open 会把用户手动点开的行 snap 关上
		if (expanded || (autoOpen && (card.output?.images?.length ?? 0) > 0)) setOpen(true);
	}, [expanded, autoOpen, card.output?.images]);

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
									className="max-h-72 w-full cursor-zoom-in rounded-lg border border-owl-border object-contain object-top"
									onClick={() => setZoomIndex(index)}
								/>
							))}
							<button
								type="button"
								onClick={() => setZoomIndex(0)}
								className="text-[11px] text-owl-accent transition-colors hover:text-owl-accent-hover"
							>
								{t("chat.viewFullImage")}
							</button>
						</div>
					)}
					{zoomIndex !== null && images[zoomIndex] !== undefined && (
						<ImageLightbox
							image={images[zoomIndex]!}
							alt={t("chat.toolScreenshot", { name: card.name, i: zoomIndex + 1 })}
							onClose={() => setZoomIndex(null)}
						/>
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

/** 连续工具调用的合组（名称可不同）：失败只标红计数，不自动弹开。 */
function ToolGroupView({ label, cards, expanded = false }: { label: string; cards: ToolCard[]; expanded?: boolean }): React.JSX.Element {
	const [open, setOpen] = useState(expanded);
	useEffect(() => setOpen(expanded), [expanded]);
	const errorCount = cards.filter((card) => card.status === "error").length;
	const running = cards.some((card) => card.status === "running");

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

/**
 * 整轮工作过程折叠行：一次提问到该轮最终回答之间的思考、工具调用与中间说明收进
 * 一条「工作过程 · N 步」，永远默认收起，用户点击才展开（失败也不例外，只在摘要行
 * 标红计数）；回合进行中显示实时步数。活动指示统一由底部 Owl 状态行承担，这里不再转圈。
 */
function WorkProcessRow({ items, steps, failed, running }: {
	items: Array<{ key: string; content: React.JSX.Element }>;
	steps: number;
	failed: number;
	running: boolean;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div className="owl-work-process">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="owl-tool-summary owl-tool-group-summary"
			>
				<IconTerminal className="h-3.5 w-3.5 shrink-0 text-owl-faint" />
				<IconChevron className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`} />
				<span className="min-w-0 flex-1 truncate text-owl-muted">
					{running ? t("chat.workRunning", { n: steps }) : t("chat.workProcess", { n: steps })}
				</span>
				{failed > 0 && <span className="shrink-0 text-red-400">{t("chat.groupFailed", { n: failed })}</span>}
			</button>
			{open && (
				<div className="owl-tool-group-body owl-work-process-body">
					{items.map((item) => (
						<div key={item.key} className="owl-work-process-item">{item.content}</div>
					))}
				</div>
			)}
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
 * 回答底部操作栏（对照参考实现）：复制 / 在新对话中分支 /（仅最新一轮）
 * 重新生成 + 用量与时间元信息。一轮回答含多次 LLM 调用时只在最后一条下挂一条，
 * usage 传整轮聚合值。
 */
function AssistantFooter({ entry, usage: usageOverride, requestCount, canRegenerate, onRegenerate, canBranch, onBranch }: {
	entry: Extract<ChatEntry, { kind: "assistant" }>;
	/** 整轮聚合用量；缺省退回本条消息自己的用量 */
	usage?: MessageUsage;
	requestCount: number;
	canRegenerate: boolean;
	onRegenerate?: () => void;
	canBranch: boolean;
	onBranch?: () => void;
}): React.JSX.Element {
	const usage = usageOverride ?? entry.usage;
	const totalTokens = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
	const usageTitle = usage
		? t("chat.msgUsageTitle", {
				calls: requestCount,
				input: formatTokenCount(usage.input),
				output: formatTokenCount(usage.output),
				cacheRead: formatTokenCount(usage.cacheRead),
				cacheWrite: formatTokenCount(usage.cacheWrite),
			})
		: undefined;
	return (
		<div className="owl-msg-actions flex-wrap">
			<CopyButton text={entry.text} label={t("chat.msgCopy")} />
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
					{t("chat.msgUsage", { n: formatTokenCount(totalTokens), calls: requestCount })}
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
function buildRows({ entries, expandedTools, onRewind, cwd, onOpenFile, turnCard, streaming, canRegenerate, onRegenerate, onEditMessage, onBranch, busy }: RowOptions): TimelineRow[] {
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
	let lastFooter: { row: TimelineRow; index: number; entry: Extract<ChatEntry, { kind: "assistant" }>; usage?: MessageUsage; requestCount: number } | undefined;
	// 轮内操作栏收集：一轮（两条用户消息之间）可能含多次 LLM 调用（中间说明 + 最终回答），
	// 操作栏只保留轮内最后一条有正文的调用并把整轮用量聚到它身上，其余从行列表剔除
	let turnFooters: Array<{ row: TimelineRow; index: number; entry: Extract<ChatEntry, { kind: "assistant" }> }> = [];
	let turnUsage: MessageUsage | undefined;
	let turnRequestCount = 0;
	// 流式中的进行轮（最后一条用户消息之后的条目）还没定型，整轮操作栏等 agent_end 重建后再出现
	let lastUserIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.kind === "user" && !entry.queued) {
			lastUserIndex = i;
			break;
		}
	}
	// 每轮（两条用户消息之间）的「最终回答」= 该轮最后一条带正文的 assistant：正文展开
	// 并挂操作栏；其余 LLM 调用（思考/中间说明/工具）全部收进整轮折叠行。轮内没有正文
	// （被停止/还在生成）时不标回答，工作段在轮末或里程碑处收口。
	const assistantHasText = (entry: ChatEntry): boolean => {
		if (entry.kind !== "assistant") return false;
		const segments: AssistantSegment[] = entry.segments ?? [
			...(entry.thinking ? [{ kind: "thinking" as const, text: entry.thinking }] : []),
			...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []),
		];
		return segments.some((segment) => segment.kind === "text" && segment.text.trim() !== "");
	};
	const answerEntries = new Set<number>();
	let turnAnswerIndex = -1;
	entries.forEach((entry, index) => {
		if (entry.kind === "user") {
			if (entry.queued) return;
			if (turnAnswerIndex >= 0) answerEntries.add(turnAnswerIndex);
			turnAnswerIndex = -1;
			return;
		}
		if (assistantHasText(entry)) turnAnswerIndex = index;
	});
	if (turnAnswerIndex >= 0) answerEntries.add(turnAnswerIndex);
	// 操作栏工厂：已落盘的历史回答随时可分支（会话正在跑也不收按钮，进行中的这一轮
	// 本来就没有操作栏）；重新生成只在末条、且会话空闲时开启。
	const assistantFooter = (entry: Extract<ChatEntry, { kind: "assistant" }>, index: number, allowRegenerate: boolean, usage: MessageUsage | undefined, requestCount: number): React.JSX.Element => (
		<AssistantFooter
			entry={entry}
			usage={usage}
			requestCount={requestCount}
			canRegenerate={allowRegenerate}
			onRegenerate={allowRegenerate ? onRegenerate : undefined}
			canBranch={entry.entryId !== undefined && onBranch !== undefined}
			onBranch={entry.entryId !== undefined && onBranch ? () => onBranch(entry.entryId!) : undefined}
		/>
	);
	const finishTurnFooters = (): void => {
		const totalUsage = turnUsage;
		const requestCount = turnRequestCount;
		turnUsage = undefined;
		turnRequestCount = 0;
		if (turnFooters.length === 0) return;
		const keep = turnFooters[turnFooters.length - 1]!;
		for (const item of turnFooters) {
			if (item === keep) continue;
			const position = rows.indexOf(item.row);
			if (position >= 0) rows.splice(position, 1);
		}
		// 幸存的操作栏按整轮聚合用量重渲染（push 时的值可能缺其后纯工具调用的用量）
		keep.row.content = assistantFooter(keep.entry, keep.index, false, totalUsage, requestCount);
		lastFooter = { ...keep, usage: totalUsage, requestCount };
		turnFooters = [];
	};
	let turn = 0;
	// 轮内截图（截图类工具的产物）：最终回答之后平铺成「本轮截图」条，免翻折叠行
	let turnShots: Array<{ key: string; image: ToolResultImage }> = [];
	// ── 整轮工作过程收纳（叠叠乐治理）：跨 LLM 调用累积思考/中间说明/普通工具调用，
	// 在里程碑（最终回答/提问卡/渲染卡/错误/下一问）处收成一条折叠行；todo 属过程，
	// 跟着进折叠区，不再把时间轴打成多段。
	let workRows: Array<{ key: string; content: React.JSX.Element }> = [];
	let workSteps = 0;
	let workFailed = 0;
	let workRunning = false;
	let workPendingTools: ToolCard[] = [];
	let workSeq = 0;
	const flushWorkTools = (): void => {
		if (workPendingTools.length === 0) return;
		const cards = workPendingTools;
		workPendingTools = [];
		workSteps += cards.length;
		workFailed += cards.filter((card) => card.status === "error").length;
		if (cards.some((card) => card.status === "running")) workRunning = true;
		workRows.push({
			key: "tools-" + cards[0]!.id,
			content: cards.length === 1
				? <ToolRowView card={cards[0]!} expanded={expandedTools} autoOpen={false} />
				: <ToolGroupView label={toolRunLabel(cards.map((card) => card.name), cards.length)} cards={cards} expanded={expandedTools} />,
		});
	};
	// 收口当前工作段；live 表示回合仍在进行（摘要行显示「正在工作」）
	const flushWork = (live = false): void => {
		flushWorkTools();
		if (workRows.length === 0) return;
		const items = workRows;
		const steps = workSteps;
		const failed = workFailed;
		const running = workRunning || live;
		workRows = [];
		workSteps = 0;
		workFailed = 0;
		workRunning = false;
		workSeq += 1;
		rows.push({
			key: "work-" + workSeq,
			content: <WorkProcessRow items={items} steps={steps} failed={failed} running={running} />,
		});
	};
		entries.forEach((entry, index) => {
			if (entry.kind === "user" && entry.queued) {
				flushWork(true);
				rows.push({
					key: "queued-" + index,
					content: (
						<div className="owl-user-queued">
							<div className="owl-user-bubble">{entry.text}</div>
							<span className="owl-user-queued-hint">{t("composer.queuedHint")}</span>
						</div>
					),
				});
				return;
			}
			if (entry.kind === "user") {
				finishTurnFooters();
				flushWork();
				turnShots = [];
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
			flushWork();
			rows.push({ key: "result-" + index, content: <OrphanResultRow entry={entry} /> });
			return;
		}
		const seenTools = new Set<string>();
		// 整轮用量累计：纯工具调用的 LLM 轮没有正文、不上屏操作栏，但同样是整轮成本
		turnUsage = addUsage(turnUsage, entry.usage);
		turnRequestCount += 1;
		const segments: AssistantSegment[] = entry.segments ?? [
			...(entry.thinking ? [{ kind: "thinking" as const, text: entry.thinking }] : []),
			...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []),
			...entry.tools.map((tool) => ({ kind: "tool" as const, toolId: tool.id })),
		];
		const appendTool = (card: ToolCard): void => {
			seenTools.add(card.id);
			// 截图类工具的产物同时进轮末截图条（key 带工具 id 保证稳定）
			if (SCREENSHOT_TOOL_PATTERN.test(card.name)) {
				for (const image of card.output?.images ?? []) {
					turnShots.push({ key: card.id + "-" + turnShots.length, image });
				}
			}
			// 任务清单的实时状态由输入区上方的常驻组件（TodoPin）独占展示：时间轴不再
			// 上屏 todo 卡片（更新频繁，且与常驻条内容完全重复），也不计入折叠区步数
			if (card.name === "todo") return;
			if (card.name === "ask_user_question") {
				// 提问必须原位可见：先收口当前工作段，再把问题卡挂上时间轴
				flushWork();
				rows.push({ key: "question-tool-" + card.id, content: <ToolRowView card={card} expanded={expandedTools} /> });
			} else if (card.name === "render_ui" && card.output?.genuiSpec !== undefined) {
				// owl-genui：render_ui 完成后渲染为工具行交互卡片（运行中先走普通工具行）
				flushWork();
				rows.push({ key: "genui-" + card.id, content: <GenuiToolCardView card={card} /> });
			} else {
				workPendingTools.push(card);
				if (card.status === "running") workRunning = true;
			}
		};
		const answerTextRow = (segmentIndex: number, text: string): TimelineRow => ({
			key: "message-" + index + "-" + segmentIndex,
			content: <GenuiAnswerCard
				text={text}
				identity={`msg${index}-seg${segmentIndex}`}
				settled={index !== lastAssistantIndex}
				renderMarkdown={renderMarkdown}
			/>,
		});
		segments.forEach((segment, segmentIndex) => {
			if (segment.kind === "tool") {
				const card = entry.tools.find((tool) => tool.id === segment.toolId);
				if (card && !seenTools.has(card.id)) appendTool(card);
				return;
			}
			if (!segment.text.trim()) return;
			if (segment.kind === "thinking") {
				// 思考进折叠区：不再打断工具聚合，也不再占独立整行
				flushWorkTools();
				workSteps += 1;
				workRows.push({ key: "think-" + index + "-" + segmentIndex, content: <ThinkingRow thinking={segment.text} /> });
				return;
			}
			if (!answerEntries.has(index)) {
				// 中间说明（轮内非最终回答的正文）进折叠区
				flushWorkTools();
				workSteps += 1;
				workRows.push(answerTextRow(segmentIndex, segment.text));
				return;
			}
			// 最终回答：先把工作过程收成一条折叠行，再展开正文
			flushWork();
			rows.push(answerTextRow(segmentIndex, segment.text));
		});
		for (const card of entry.tools) if (!seenTools.has(card.id)) appendTool(card);
		if (entry.error) {
			flushWork();
			rows.push({ key: "error-" + index, content: <div className="owl-chat-error" role="alert">{entry.error}</div> });
		} else if (entry.aborted) {
			// 用户暂停：只留一行置灰小字（provider 的中止报错不上屏），继续入口在输入框按钮上。
			flushWork();
			rows.push({ key: "paused-" + index, content: <div className="owl-chat-paused">{t("chat.pausedHint")}</div> });
		}
		// 回答底部操作栏：只挂在每轮最终回答上（纯工具调用与中间说明不上屏）。流式中的
		// 进行轮整轮不上屏（等 agent_end 重建后一次性出现，避免中途闪现又消失）。
		if (
			answerEntries.has(index) &&
			(lastAssistantIndex === -1 || index !== lastAssistantIndex) &&
			!(streaming && lastUserIndex !== -1 && index > lastUserIndex)
		) {
			flushWork();
			// 「本轮截图」条挂在最终回答之后、操作栏之前——聊天记录看完回答就见图
			if (turnShots.length > 0) {
				const shots = turnShots;
				turnShots = [];
				rows.push({ key: "turn-shots-" + index, compact: true, content: <TurnScreenshotStrip shots={shots} /> });
			}
			const row: TimelineRow = {
				key: "footer-" + index,
				compact: true,
				content: assistantFooter(entry, index, false, turnUsage, turnRequestCount),
			};
			rows.push(row);
			turnFooters.push({ row, index, entry });
		}
		});
	flushWork(streaming && lastUserIndex !== -1);
	finishTurnFooters();
	// 重新生成只出现在最后一条回答的操作栏上：对最后一条用户消息整轮「仅回退对话」后重发
	if (lastFooter && canRegenerate && onRegenerate) {
		lastFooter.row.content = assistantFooter(lastFooter.entry, lastFooter.index, true, lastFooter.usage, lastFooter.requestCount);
	}
	return rows;
}

type QuestionMark = { n: number; text: string; preview: string };

function buildQuestions(entries: ChatEntry[]): QuestionMark[] {
	return entries.filter((entry): entry is Extract<ChatEntry, { kind: "user" }> => entry.kind === "user" && !entry.queued).map((entry, index) => {
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
	// 实时状态行：流羽猫头鹰 + 「时长 · 本轮 tokens · 状态」。
	// 时长从本轮用户消息发出时刻起跳（旧会话消息缺时间戳则不显示），tokens 为本轮
	// 已回传用量之和。每秒走一次状态更新，驱动文案跳动；组件只在会话忙时挂载，空闲自动卸载。
	const pose = useSessionOwlPose(activity, entries);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	if (activity === "idle") return null;
	let executing = false;
	let userTs: number | undefined;
	let usage: MessageUsage | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.kind === "user") {
			userTs = entry.timestamp;
			break;
		}
		if (entry.kind === "assistant") {
			usage = addUsage(entry.usage, usage);
			if (entry.tools.some((tool) => tool.status === "running")) executing = true;
		}
	}
	const label = activity === "waiting" ? t("chat.activityWaiting") : activity === "disconnected" ? t("chat.activityDisconnected") : executing ? t("chat.activityExecuting") : t("chat.activityGenerating");
	const elapsed = userTs !== undefined ? formatDuration(Math.max(0, now - userTs)) : undefined;
	const totalTokens = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
	const parts = [
		elapsed,
		totalTokens > 0 ? t("chat.activityTokens", { n: formatTokenCount(totalTokens) }) : undefined,
		label,
	].filter((part): part is string => part !== undefined);
	return (
		<div className="owl-response-activity" data-state={activity} role="status">
			<OwlMascot pose={pose} inline />
			<span>{parts.join(" · ")}</span>
		</div>
	);
}

/**
 * 屏幕居中的看图灯箱：点遮罩或按 Esc 关闭。工具卡截图、轮末截图条、
 * 最新截图 Dock 共用——`fixed` 相对视口，图片始终居中在窗口正中。
 */
function ImageLightbox({ image, alt, onClose }: { image: ToolResultImage; alt: string; onClose: () => void }): React.JSX.Element {
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={onClose}>
			<img
				src={`data:${image.mimeType};base64,${image.data}`}
				alt={alt}
				className="max-h-full max-w-full rounded-lg border border-owl-border shadow-2xl"
			/>
		</div>
	);
}

/**
 * 轮末截图条：本轮 agent 截过的屏幕画面在最终回答之后平铺展示，不用翻
 * 工作过程折叠行找图；点缩略图开灯箱看全图。只收截图类工具（生图类工具的
 * 产物属于会话内容，已在各自卡片里渲染）。
 */
function TurnScreenshotStrip({ shots }: { shots: Array<{ key: string; image: ToolResultImage }> }): React.JSX.Element {
	const t = useT();
	const [zoom, setZoom] = useState<number | null>(null);
	return (
		<div className="owl-turn-shots space-y-1.5">
			<div className="text-[11px] font-medium text-owl-muted">{t("chat.turnScreenshots")}</div>
			<div className="flex flex-wrap gap-2">
				{shots.map((shot, index) => (
					<img
						key={shot.key}
						src={`data:${shot.image.mimeType};base64,${shot.image.data}`}
						alt={t("chat.latestScreenshot")}
						className="h-36 cursor-zoom-in rounded-lg border border-owl-border object-contain"
						onClick={() => setZoom(index)}
					/>
				))}
			</div>
			{zoom !== null && shots[zoom] !== undefined && (
				<ImageLightbox image={shots[zoom]!.image} alt={t("chat.fullScreenshot")} onClose={() => setZoom(null)} />
			)}
		</div>
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
			if (entry.kind === "user" && !entry.queued) return Boolean(entry.entryId);
		}
		return false;
	}, [busy, onRegenerate, entries]);
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
				canRegenerate,
				onRegenerate,
				onEditMessage,
				onBranch,
				busy,
			}),
		[entries, expandedTools, onRewind, cwd, onOpenFile, turnCard, activity, canRegenerate, onRegenerate, onEditMessage, onBranch, busy],
	);

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
		</div>
	);
}
