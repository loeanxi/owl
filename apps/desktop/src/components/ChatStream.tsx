import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { currentRunStartIndex, outputRate, type AssistantSegment, type ChatEntry, type MessageUsage, type ToolCard, type ToolResultImage, type ToolStatus } from "../hooks/transcript.ts";
import { errorKindOf, exitCodeOf } from "../hooks/summarize.ts";
import { getUiLanguage, t, useT } from "../i18n/index.ts";
import { IconAlert, IconCheck, IconChevron, IconClock, IconCompose, IconLightbulb, IconMore, IconRefresh, IconTerminal } from "./icons.tsx";
import { MessageCopyButton, MessageMoreMenu } from "./MessageActions.tsx";
import { useMessageActionsText } from "./message-actions-copy.ts";
import { GenuiAnswerCard, GenuiToolCardView } from "./Genui.tsx";
import { MarkdownAnswer } from "./MarkdownAnswer.tsx";
import { renderAnswerMarkdown, renderPlainMarkdown } from "./answer-markdown-renderer.ts";
import { collectHistoricalArtifacts, workspaceArtifactPath, type FileArtifact } from "../hooks/artifacts.ts";
import { pathCandidateFromCode } from "../utils/paths.ts";
import { parseSkillInvocation, userSourceText } from "../hooks/skill-invocation.ts";
import { Artifacts } from "./Artifacts.tsx";
import { TurnArtifacts } from "./ReviewChangesCard.tsx";
import { DeliverySummary } from "./DeliverySummary.tsx";
import { deliveryChecklist } from "../hooks/delivery.ts";
import { StartPage } from "./StartPage.tsx";
import type { StartRecentSession } from "../hooks/use-start-recent-sessions.ts";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionSearchMessageResult } from "../bridge/protocol.ts";
import { ScheduleDeliveryCard } from "../features/automation/ScheduleDeliveryCard.tsx";
import { parseScheduleDelivery } from "../features/automation/schedule-delivery.ts";
import { useSubagentText } from "./subagent-copy.ts";
import { highlightMessageMatches, messageElement, messageScrollTop, type MessageSearchTarget } from "./chat-message-navigation.ts";
import "./chat-message-navigation.css";
import "./chat-history-message.css";
import { collectAttachmentReceipts, type AttachmentReceipt as Receipt } from "../hooks/attachment-receipts.ts";
import { AttachmentReceipt } from "./AttachmentReceipt.tsx";
import { useWorkProcessText, workProcessText } from "./work-process-copy.ts";
import { enabledWorkEffectIds, useWorkEffects } from "./work-process-effects.ts";
import { workActionFacts, workActionPath, workActionStatus, workActionTitle, workLatestOutput, type WorkAction } from "./work-process-model.ts";
import type { ExecutionView } from "./execution-view.ts";
import "./chat-work-process.css";
import { ImageViewer } from "./ImageViewer.tsx";

const AttachmentToolContext = createContext<{ toolId: string; ownerIndex?: number; requestId: number } | undefined>(undefined);
const WorkToolFocusContext = createContext<{ toolId: string; ownerIndex?: number } | undefined>(undefined);
type WorkPresentation = {
	processes: Map<string, boolean>;
	tools: Map<string, boolean>;
	outputs: Map<string, boolean>;
	thoughts: Map<string, boolean>;
	focus?: { key: string; index: number; element: Element };
};
const WorkPresentationContext = createContext<WorkPresentation | undefined>(undefined);
const EMPTY_KEYS: ReadonlySet<string> = new Set();
/** 本次运行中才出现的工具行，键是 ToolRowView 用的 `ownerIndex:toolId`。会话恢复的老行不在其中。 */
const WorkArrivedContext = createContext<ReadonlySet<string>>(EMPTY_KEYS);
/** 过程区运行中的秒针（WorkProcessRow 的 now 状态）：运行中的行耗时跟着它每秒更新，收尾后冻结。 */
const WorkNowContext = createContext<number | undefined>(undefined);
const ExecutionViewContext = createContext<{ view: ExecutionView; onInspectTool?: (card: ToolCard, ownerIndex?: number) => void }>({ view: "normal" });

export type { MessageSearchTarget } from "./chat-message-navigation.ts";

/** 工具输出默认只预览末尾几行（结论/报错多在尾部），展开才看全文。 */
const OUTPUT_PREVIEW_LINES = 10;

/** 截图类工具：产物是「给用户看的屏幕画面」，进最新截图 Dock 与轮末截图条。 */
const SCREENSHOT_TOOL_PATTERN = /^(computer_screenshot|computer_observe|computer_act|browser_screenshot|mcp_playwright_\w*screenshot\w*|iab_screenshot)$/i;

/**
 * 行内容缓存：转录更新是不可变的（未动条目保持引用），流式 batch 之间据此复用
 * 同一元素引用——React 对相同引用的子树直接跳过调和，历史回答不再每个 batch
 * 重跑一次 markdown 解析。键值元素闭包里的回调必须传稳定身份（见 useStableOption）。
 */
type CachedItems = { scope: string; items: Map<string, React.JSX.Element> };
const assistantItemCache = new WeakMap<object, CachedItems>();

function cachedAssistantItem(entry: object, scope: string, key: string, build: () => React.JSX.Element): React.JSX.Element {
	let cache = assistantItemCache.get(entry);
	if (cache === undefined || cache.scope !== scope) {
		cache = { scope, items: new Map() };
		assistantItemCache.set(entry, cache);
	}
	const hit = cache.items.get(key);
	if (hit !== undefined) return hit;
	const element = build();
	cache.items.set(key, element);
	return element;
}

/** 桥客户端实例的稳定编号：缓存域要区分它（元素闭包里捕获了 client）。 */
const clientStamps = new WeakMap<object, number>();
let nextClientStamp = 1;
function clientStampOf(client: BridgeClient | undefined): string {
	if (client === undefined) return "-";
	let stamp = clientStamps.get(client);
	if (stamp === undefined) {
		stamp = nextClientStamp++;
		clientStamps.set(client, stamp);
	}
	return String(stamp);
}

/** 跨条目的工具批次元素缓存：一个批次可横跨多条 assistant 消息，不能按条目做键。 */
type BatchItem = { sig: string; element: React.JSX.Element };

export function renderMarkdown(text: string): string {
	return renderPlainMarkdown(text);
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

/** 相对时间：刚刚 / 12 分钟前。对照 Cursor 回答底下的 “12m ago”。 */
function formatAgo(timestamp: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - timestamp) / 60000));
	if (minutes < 1) return t("chat.justNow");
	if (minutes < 60) return t("chat.minutesAgo", { n: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return t("chat.hoursAgo", { n: hours });
	return t("chat.daysAgo", { n: Math.round(hours / 24) });
}

/** 时长的紧凑展示（对照 Cursor 的 “Worked for 7m 23s”）。 */
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
 * 过程收成正文上方的一行「工作了 7m 23s」，点开才看步骤。正文下面是复制和时间。
 * 提问卡、渲染卡与错误仍原位可见。任务清单由对话区右上角的 TodoPin 独占，时间轴不再重复。
 */

/** 内容流的一行；提问行带 questionIndex 作跳转锚点，操作栏行用更紧凑的包装。 */
type TimelineRow = {
	key: string;
	content: React.JSX.Element;
	entryId?: string;
	questionIndex?: number;
	compact?: boolean;
	answer?: boolean;
	workRunning?: boolean;
	deliveryTurn?: string;
	/** 贴在结论下面的附属行（工作过程、截图、改动）：不另起一块，避免回答被切成好几截。 */
	quiet?: boolean;
};

/** 渲染含 `code` 反引号的摘要行（工具摘要里的命令/路径/模式）。 */
export function InlineSummary({ text }: { text: string }): React.JSX.Element {
	const parts = text.split(/`([^`]*)`/);
	return (
		<>
			{parts.map((part, index) =>
				index % 2 === 1 ? (
					<code
						key={index}
						className={`owl-tool-inline-code ${pathCandidateFromCode(part) === "" ? "" : "owl-path-chip"}`}
					>
						{part}
					</code>
				) : part ? (
					<span key={index}>{part}</span>
				) : null,
			)}
		</>
	);
}

/** 只有真失败才标红、计入「N 个失败」；非零退出与守卫拦截各有自己的样式。 */
function isHardFailure(card: ToolCard): boolean {
	return card.status === "error" && errorKindOf(card.name, card.output?.text) === "failed";
}

/** 工具状态图标：运行中转圈，成功勾，失败/拦截/非零退出分别保留异常图标。 */
function StatusIcon({ status, errorKind }: { status: ToolStatus; errorKind?: ReturnType<typeof errorKindOf> }): React.JSX.Element {
	if (status === "error" && errorKind === "blocked") return <IconAlert className="h-3.5 w-3.5 shrink-0 text-owl-warning" />;
	if (status === "error" && errorKind === "exit") return <IconAlert className="h-3.5 w-3.5 shrink-0 text-owl-faint" />;
	// 调用本身无效（工具不存在、参数没通过校验）：模型的下一次调用会改对，用中性色，不标红。
	if (status === "error" && errorKind === "invalid") return <IconAlert className="h-3.5 w-3.5 shrink-0 text-owl-faint" />;
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
	if (status === "error") return <IconAlert className="h-3.5 w-3.5 shrink-0 text-owl-danger" />;
	// 完成的勾用主题成功色：长列表里「哪些步成了」扫一眼可得，不必逐行读字。
	return <IconCheck className="h-3.5 w-3.5 shrink-0 text-owl-success" />;
}

/**
 * 工作过程里参与 morph / breathe 的状态图标槽：给图标一个与自身同尺寸的定位上下文，
 * 扩散环和光晕画在槽的伪元素上，不额外占布局。
 * 「最近状态」行不要用这个槽 —— 那里的尺寸靠 .owl-work-latest-state > svg 约束，多包一层会撑爆整行。
 */
function StatusSlot({ status, errorKind, justDone }: { status: ToolStatus; errorKind?: ReturnType<typeof errorKindOf>; justDone?: boolean }): React.JSX.Element {
	return <span className="owl-status-slot" data-just-done={justDone ? "true" : "false"}><StatusIcon status={status} errorKind={errorKind} /></span>;
}

/** 思考过程：整轮合并成一条轻量折叠行，默认收起，不再一段一个全宽条。 */
/** 思考原文预览行数：超过才出「查看全文」，展开后全高进页面滚动，不再嵌套内滚。 */
const THINKING_PREVIEW_LINES = 12;

function ThinkingRow({ thinking, segments, searchTarget }: { thinking: string; segments?: readonly { key?: string; entryId?: string; text: string }[]; searchTarget?: MessageSearchTarget }): React.JSX.Element {
	const copy = useWorkProcessText();
	const revealsHit = Boolean(searchTarget && segments?.some((segment) => segment.entryId === searchTarget.entryId));
	const presentation = useContext(WorkPresentationContext);
	const keys = (segments ?? [{ key: undefined, entryId: undefined, text: thinking }]).map((segment) => "thinking:" + (segment.key ?? segment.entryId ?? segment.text));
	const [open, setOpen] = useState(revealsHit || keys.some((key) => presentation?.thoughts.get(key)));
	const [expanded, setExpanded] = useState(false);
	useLayoutEffect(() => { if (revealsHit) { setOpen(true); setExpanded(true); } }, [revealsHit, searchTarget?.requestId]);
	const allLines = useMemo(() => thinking.split("\n"), [thinking]);
	const lines = useMemo(() => allLines.filter((line) => line.trim() !== "").length, [allLines]);
	const canExpand = allLines.length > THINKING_PREVIEW_LINES;
	const bodyKey = "thinking:" + (keys[0] ?? thinking);
	return (
		<div className="owl-thinking" data-open={open || undefined}>
			<button type="button" className="flex w-full cursor-pointer select-none items-center gap-1.5 py-0.5 text-left" data-message-action-ui="" aria-expanded={open} onClick={() => { for (const key of keys) presentation?.thoughts.set(key, !open); setOpen(!open); }}>
				<IconLightbulb className="h-3.5 w-3.5" />
				<IconChevron className="owl-thinking-chevron h-3 w-3 shrink-0 transition-transform" />
				<span title={t("chat.thinkingLines", { n: lines })}>{workProcessText("thinkingOriginal")}</span>
				<span className="owl-thinking-count" aria-hidden="true">{lines}</span>
			</button>
			<div className="owl-collapse-body" data-open={open || undefined}>
				<div className="owl-thinking-panel">
					<div className="owl-thinking-toolbar" data-message-action-ui="">
						<span className="owl-thinking-count">{t("chat.thinkingLines", { n: lines })}</span>
						<MessageCopyButton text={thinking} label={copy("copyOutput")} identity={bodyKey + ":copy"} showLabel />
						{canExpand && <button type="button" className="owl-work-output-toggle" data-work-reading="" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? copy("collapseOutput") : copy("expandOutput", { n: allLines.length })}</button>}
					</div>
					<pre className="owl-thinking-text">
						{canExpand && !expanded
							? allLines.slice(0, THINKING_PREVIEW_LINES).join("\n")
							: segments ? segments.map((segment, index) => <span key={String(index) + ":" + segment.entryId} data-entry-id={segment.entryId}>{index > 0 ? "\n\n" : ""}{segment.text}</span>) : thinking}
					</pre>
				</div>
			</div>
		</div>
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
function ToolRowView({ card, ownerIndex, entryId, expanded = false, autoOpen = true, processView = false, onOpenSubagent }: { card: ToolCard; ownerIndex?: number; entryId?: string; expanded?: boolean; autoOpen?: boolean; processView?: boolean; onOpenSubagent?: (card: ToolCard) => void }): React.JSX.Element {
	const copy = useWorkProcessText();
	const outputSection = useRef<HTMLElement>(null);
	const toolRoot = useRef<HTMLDivElement>(null);
	const receiptTarget = useContext(AttachmentToolContext);
	const focusTarget = useContext(WorkToolFocusContext);
	const presentation = useContext(WorkPresentationContext);
	const arrived = useContext(WorkArrivedContext);
	const { view, onInspectTool } = useContext(ExecutionViewContext);
	const presentationKey = String(ownerIndex) + ":" + card.id;
	const revealsReceipt = (receiptTarget?.toolId === card.id && receiptTarget?.ownerIndex === ownerIndex) || (focusTarget?.toolId === card.id && focusTarget?.ownerIndex === ownerIndex);
	const subagentCopy = useSubagentText();
	const [fullOutput, setFullOutput] = useState(revealsReceipt || (presentation?.outputs.get(presentationKey) ?? view === "verbose"));
	const toggleOutput = (value: boolean): void => { presentation?.outputs.set(presentationKey, value); setFullOutput(value); };
	// 点击图片/「查看完整大图」打开屏幕居中灯箱（不再卡片内撑开把时间轴挤跳）。
	const [zoomIndex, setZoomIndex] = useState<number | null>(null);
	const hasImages = (card.output?.images?.length ?? 0) > 0;
	const [open, setOpen] = useState(revealsReceipt || (presentation?.tools.get(presentationKey) ?? (view === "verbose" || expanded || (autoOpen && hasImages))));
	const toggleTool = (): void => setOpen((value) => {
		presentation?.tools.set(presentationKey, !value);
		return !value;
	});
	// 完成跃迁只认「这一行从活动态转入终态」的那一次转变。会话恢复时首帧就已是终态，不触发。
	const [justDone, setJustDone] = useState(false);
	const previousStatus = useRef(card.status);
	useEffect(() => {
		const before = previousStatus.current;
		previousStatus.current = card.status;
		if (before === card.status) return;
		if (before !== "running" && before !== "pending") return;
		if (card.status === "running" || card.status === "pending") return;
		setJustDone(true);
	}, [card.status]);
	useLayoutEffect(() => {
		const focused = presentation?.focus;
		if (focused?.key === presentationKey && !focused.element.isConnected) {
			const active = document.activeElement;
			if (!active || active === document.body || !active.isConnected) toolRoot.current?.querySelectorAll<HTMLElement>("button, a[href], textarea, input, [tabindex]")[focused.index]?.focus({ preventScroll: true });
			if (presentation) presentation.focus = undefined;
		}
		return () => {
			const active = document.activeElement;
			if (!presentation || !active || !toolRoot.current?.contains(active)) return;
			const index = [...toolRoot.current.querySelectorAll("button, a[href], textarea, input, [tabindex]")].indexOf(active);
			if (index >= 0) presentation.focus = { key: presentationKey, index, element: active };
		};
	});
	useLayoutEffect(() => { if (revealsReceipt) { setOpen(true); setFullOutput(true); } }, [revealsReceipt, receiptTarget?.requestId, focusTarget]);
	useEffect(() => {
		// Only explicit choices persist; automatic view defaults follow the selected view both ways.
		if (!presentation?.tools.has(presentationKey)) setOpen(revealsReceipt || view === "verbose" || expanded || (autoOpen && (card.output?.images?.length ?? 0) > 0));
		if (!presentation?.outputs.has(presentationKey)) setFullOutput(revealsReceipt || view === "verbose");
	}, [view, expanded, autoOpen, card.output?.images, presentation, presentationKey, revealsReceipt]);

	const output = card.output;
	const previewLines = processView ? 16 : OUTPUT_PREVIEW_LINES;
	const { preview, dropped } = output ? tailLines(output.text, previewLines) : { preview: "", dropped: 0 };
	const totalLines = Math.max(output?.totalLines ?? 0, output?.text.split("\n").length ?? 0);
	const hasMore = totalLines > previewLines;
	const images = output?.images ?? [];
	const exitCode = card.status === "error" ? exitCodeOf(output?.text) : undefined;
	const errorKind = card.status === "error" ? errorKindOf(card.name, output?.text) : undefined;
	const opensSubagent = card.name === "subagent" && onOpenSubagent !== undefined;
	const actionTitle = processView ? workActionTitle(card) : card.summary;
	const actionPath = processView ? workActionPath(card) : undefined;
	const input = card.detail || (processView ? card.args : "");
	// 行级耗时：只有跑满 1 秒的行才显示，瞬时行不制造 0s 噪声；运行中的行随过程区秒针走。
	const workNow = useContext(WorkNowContext);
	const rowMs = card.startedAt === undefined ? undefined : card.status === "running" ? (workNow ?? Date.now()) - card.startedAt : card.finishedAt !== undefined ? card.finishedAt - card.startedAt : undefined;
	const rowSecs = processView && rowMs !== undefined && rowMs >= 1000 ? formatDuration(rowMs) : undefined;

	return (
		<div ref={toolRoot} className="owl-tool-row" data-entry-id={entryId} data-tool-id={card.id} data-tool-owner={ownerIndex} data-status={card.status} data-error-kind={errorKind} data-fresh={arrived.has(presentationKey) ? "true" : "false"}>
			<div className="flex items-center gap-1">
			<button
				type="button"
				aria-expanded={opensSubagent ? undefined : open}
				title={opensSubagent ? subagentCopy.open : actionPath || input || card.summary}
				onClick={() => opensSubagent ? onOpenSubagent(card) : toggleTool()}
				className="owl-tool-summary min-w-0 flex-1"
			>
				<StatusSlot status={card.status} errorKind={errorKind} justDone={justDone} />
				<span
					className={`${processView ? "owl-work-action-copy" : "min-w-0 flex-1 truncate"} ${errorKind === "failed" ? "text-owl-danger" : card.name === "subagent" ? "text-owl-accent" : "text-owl-muted"}`}
				>
					<span className={processView ? "owl-work-action-title" : undefined} title={actionPath || input || card.summary}>{actionPath ? actionTitle : <InlineSummary text={actionTitle} />}</span>
				</span>
				{card.status === "cancelled" && <span className="owl-work-action-result text-xs text-owl-faint">{t("chat.cancelled")}</span>}
				{errorKind === "blocked" && <span className="owl-work-action-result shrink-0 text-xs text-owl-warning">{t("chat.toolBlocked")}</span>}
				{errorKind !== "blocked" && exitCode !== undefined && (
					<span className={`owl-work-action-result shrink-0 text-xs ${errorKind === "exit" ? "text-owl-faint" : "text-owl-danger"}`}>
						{t("chat.exitCode", { code: exitCode })}
					</span>
				)}
				{rowSecs !== undefined && <span className="owl-work-row-secs">{rowSecs}</span>}
				<IconChevron
					className={`h-3 w-3 shrink-0 text-owl-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{opensSubagent && <button type="button" className="owl-msg-action" title={subagentCopy.toolDetails} aria-label={subagentCopy.toolDetails} aria-expanded={open} onClick={toggleTool}><IconMore className="h-3.5 w-3.5" /></button>}
			</div>
			{open && (
				<div className="owl-tool-detail">
					{input && (
						<section className="owl-work-record" data-work-record="command">
							<div className="owl-work-record-toolbar" data-message-action-ui=""><span className="owl-work-record-label">{actionPath ? <code className="owl-tool-inline-code owl-path-chip">{actionPath}</code> : copy("command")}</span><MessageCopyButton text={input} label={copy("copyCommand")} identity={presentationKey + ":command"} showLabel /></div>
							<pre className="owl-tool-command">{input}</pre>
						</section>
					)}
					{output && output.text !== "" && (
						<section ref={outputSection} className="owl-work-record" data-work-record="output">
							<div className="owl-work-record-toolbar" data-message-action-ui="">
								<span className="owl-work-record-label">{copy("output")}</span>
								{hasMore && <button type="button" className="owl-work-output-toggle" data-work-reading="" aria-expanded={fullOutput} onClick={() => toggleOutput(!fullOutput)}>{fullOutput ? copy("collapseOutput") : copy("expandOutput", { n: totalLines })}</button>}
								<MessageCopyButton text={output.text} label={copy("copyOutput")} identity={presentationKey + ":output"} showLabel />
							</div>
							<pre className="owl-tool-output">
								{fullOutput || !hasMore ? output.text : `${t("chat.outputTruncated", { n: dropped })}\n${preview}`}
							</pre>
							{hasMore && fullOutput && <div className="owl-work-record-foot" data-message-action-ui=""><button type="button" className="owl-work-output-toggle" data-work-reading="" onClick={() => {
								toggleOutput(false);
								const viewport = outputSection.current?.closest<HTMLElement>(".owl-chat-scroll");
								if (viewport && outputSection.current) viewport.scrollTo({ top: messageScrollTop(viewport, outputSection.current), behavior: "instant" });
							}}>{copy("collapseOutput")}</button></div>}
						</section>
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
								<button type="button" key={index} className="owl-image-trigger w-full" aria-label={t("chat.toolScreenshot", { name: card.name, i: index + 1 })} onClick={() => setZoomIndex(index)}><img
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={t("chat.toolScreenshot", { name: card.name, i: index + 1 })}
									className="max-h-72 w-full cursor-zoom-in rounded-lg border border-owl-border object-contain object-top"
								/></button>
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
						<ImageViewer
							images={images.map((image, index) => ({ src: `data:${image.mimeType};base64,${image.data}`, alt: t("chat.toolScreenshot", { name: card.name, i: index + 1 }) }))}
							index={zoomIndex}
							onIndexChange={setZoomIndex}
							onClose={() => setZoomIndex(null)}
						/>
					)}
					{(output?.text || card.detail) && (
						<div className="owl-tool-meta">
							{(card.finishedAt ?? card.startedAt) !== undefined && (
								<span>{formatClock(card.finishedAt ?? card.startedAt!)}</span>
							)}
						</div>
					)}
					{onInspectTool && <div className="owl-work-record-foot" data-message-action-ui=""><button type="button" className="owl-work-inspect" data-work-reading="" title={copy("inspectTool")} aria-label={copy("inspectTool") + ": " + actionTitle} onClick={() => onInspectTool(card, ownerIndex)}>{copy("inspectTool")}</button></div>}
				</div>
			)}
		</div>
	);
}

function ToolRecords({ cards, owners, entryIds, expanded, onOpenSubagent }: { cards: ToolCard[]; owners: ReadonlyMap<ToolCard, number>; entryIds: ReadonlyMap<number, string>; expanded: boolean; onOpenSubagent?: (card: ToolCard) => void }): React.JSX.Element {
	return <div className="owl-work-tool-list">
		{cards.map((card) => <ToolRowView key={String(owners.get(card)) + ":" + card.id} card={card} ownerIndex={owners.get(card)} entryId={entryIds.get(owners.get(card) ?? -1)} expanded={expanded} autoOpen={false} processView onOpenSubagent={onOpenSubagent} />)}
	</div>;
}

/**
 * 一段连续工具记录共用一个折叠入口，公开说明和交互卡在正文中打断该段。
 * 运行时展示当前动作与实际输出；结束后的失败保留计数与原始明细。
 * 手动展开状态跟随具体操作保留，不因最后一条回答到达而关闭。
 */
type WorkProcessItem = {
	key: string;
	content: React.JSX.Element;
	entryId?: string;
	toolIds?: string[];
	cards?: ToolCard[];
	owners?: ReadonlyMap<ToolCard, number>;
	entryIds?: ReadonlyMap<number, string>;
	thinking?: string;
	interactive?: boolean;
	/** 公开进展：折叠时也保持可见，不随工具行一起收起。 */
	note?: boolean;
};

type WorkProcessScope = {
	id: string;
	items: WorkProcessItem[];
	steps: number;
	failed: number;
	running?: boolean;
	waiting?: boolean;
	startedAt?: number;
	finishedAt?: number;
	subagents: ToolCard[];
	lastEntryIndex: number;
};

/**
 * 工作过程动效：开着的动效由用户设置决定（聊天阅读 → 工作过程动效）。
 * 开关表落在根节点 data-fx 上，CSS 用 [data-fx~="rail"] 之类匹配。
 */
function WorkProcessRow({ scopes, hasAnswer, onOpenSubagent, searchTarget }: {
	scopes: readonly WorkProcessScope[];
	hasAnswer: boolean;
	onOpenSubagent?: (card: ToolCard) => void;
	searchTarget?: MessageSearchTarget;
}): React.JSX.Element {
	const copy = useWorkProcessText();
	const root = useRef<HTMLDivElement>(null);
	const { view, onInspectTool } = useContext(ExecutionViewContext);
	const workEffects = useWorkEffects();
	const panelId = useId();
	const items = useMemo(() => scopes.flatMap((scope) => scope.items), [scopes]);
	const activeScope = scopes.findLast((scope) => scope.running);
	const running = Boolean(activeScope);
	const waiting = Boolean(activeScope?.waiting);
	const revealsHit = Boolean(searchTarget && items.some((item) => item.entryId === searchTarget.entryId || [...(item.entryIds?.values() ?? [])].includes(searchTarget.entryId)));
	const receiptTarget = useContext(AttachmentToolContext);
	const revealsReceipt = items.some((item) => receiptTarget && item.toolIds?.includes(String(receiptTarget.ownerIndex) + ":" + receiptTarget.toolId));
	const presentation = useContext(WorkPresentationContext);
	const presentationKeys = useMemo(() => items.flatMap((item) => ["item:" + item.key, ...(item.toolIds ?? [])]), [items]);
	const processPreference = (): boolean | undefined => {
		const preferences = presentationKeys.map((key) => presentation?.processes.get(key));
		return preferences.includes(true) ? true : preferences.includes(false) ? false : undefined;
	};
	const [open, setOpen] = useState(revealsHit || revealsReceipt || (processPreference() ?? view === "verbose"));
	const setProcessOpen = (value: boolean): void => {
		for (const key of presentationKeys) presentation?.processes.set(key, value);
		setOpen(value);
	};
	useEffect(() => { const preferred = processPreference(); setOpen(preferred ?? (revealsHit || revealsReceipt || view === "verbose")); }, [presentationKeys, presentation, view, revealsHit, revealsReceipt]);
	const [focusedTool, setFocusedTool] = useState<{ toolId: string; ownerIndex?: number }>();
	const issueCursor = useRef(0);
	useEffect(() => { if (revealsHit) setOpen(true); }, [revealsHit, searchTarget?.requestId]);
	useEffect(() => { if (revealsReceipt) setOpen(true); }, [revealsReceipt, receiptTarget?.requestId]);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running || activeScope?.startedAt === undefined) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [running, activeScope?.startedAt]);
	const durations = scopes.flatMap((scope) => {
		const end = scope.running ? now : scope.finishedAt;
		return scope.startedAt !== undefined && end !== undefined ? [Math.max(0, end - scope.startedAt)] : [];
	});
	const elapsed = durations.length ? durations.reduce((sum, duration) => sum + duration, 0) : undefined;
	const actions = useMemo<WorkAction[]>(() => scopes.flatMap((scope) => scope.items.flatMap((item) => (item.cards ?? []).map((card) => ({
		key: String(item.owners?.get(card)) + ":" + card.id, card, ownerIndex: item.owners?.get(card), entryId: item.entryIds?.get(item.owners?.get(card) ?? -1), scope: scope.id,
	})))), [scopes]);
	// 新行落位只认本次运行中追加的条目：首次渲染先把现有条目全部登记为已见，之后新出现的 key 才标记。
	// 这样会话恢复不会把历史记录整段重播一遍。工具行落在 .owl-tool-row 上而不是外层 item，
	// 因为一个 item 会合并同一段里的多次工具调用，只有行才是逐条出现的。
	const [arrivedItems, setArrivedItems] = useState<ReadonlySet<string>>(EMPTY_KEYS);
	const [arrivedActions, setArrivedActions] = useState<ReadonlySet<string>>(EMPTY_KEYS);
	const seenItems = useRef<Set<string> | null>(null);
	const seenActions = useRef<Set<string> | null>(null);
	useEffect(() => {
		if (seenItems.current === null || seenActions.current === null) {
			seenItems.current = new Set(items.map((item) => item.key));
			seenActions.current = new Set(actions.map((action) => action.key));
			return;
		}
		const itemsNow = items.filter((item) => !seenItems.current!.has(item.key)).map((item) => item.key);
		const actionsNow = actions.filter((action) => !seenActions.current!.has(action.key)).map((action) => action.key);
		if (itemsNow.length > 0) {
			for (const key of itemsNow) seenItems.current.add(key);
			setArrivedItems((current) => new Set([...current, ...itemsNow]));
		}
		if (actionsNow.length > 0) {
			for (const key of actionsNow) seenActions.current.add(key);
			setArrivedActions((current) => new Set([...current, ...actionsNow]));
			// 冒泡给聊天层的「回到最新」按钮：用户翻在上面时，新工具行到达让它轻点一下。
			root.current?.dispatchEvent(new Event("owl-work-new-activity", { bubbles: true }));
		}
	}, [items, actions]);
	const facts = workActionFacts(actions);
	const thinkingSegments = items.filter((item) => item.thinking !== undefined).map((item) => ({ key: item.key, entryId: item.entryId, text: item.thinking! }));
	const searchedAction = searchTarget ? actions.find((action) => action.entryId === searchTarget.entryId && [action.card.summary, action.card.detail, action.card.output?.text].some((text) => text?.toLocaleLowerCase().includes(searchTarget.query.toLocaleLowerCase()))) : undefined;
	const searchFocus = useMemo(() => searchedAction ? { toolId: searchedAction.card.id, ownerIndex: searchedAction.ownerIndex } : undefined, [searchedAction?.card.id, searchedAction?.ownerIndex, searchTarget?.requestId]);
	const current = activeScope ? workActionFacts(actions.filter((action) => action.scope === activeScope.id)).current : undefined;
	const primary = running ? waiting ? copy("waiting") : current ? workActionTitle(current.card) : copy("waitingModel") : actions.length || !thinkingSegments.length ? copy("process") : copy("thinking");
	// Finished records retain their original status behind the issue counter. Only the active
	// segment promotes a received result, so an old failed attempt cannot masquerade as live output.
	const activeActions = activeScope ? actions.filter((action) => action.scope === activeScope.id) : [];
	const activeFacts = workActionFacts(activeActions);
	const reviewIssue = running && !current ? activeFacts.issues.at(-1) : undefined;
	const latestOutput = running ? reviewIssue?.card.output?.text.trim() ? reviewIssue : workLatestOutput(activeActions, current) : undefined;
	const latestStatus = running ? reviewIssue ?? activeFacts.recent.at(-1) : undefined;
	const issueKind = facts.issues.some(({ card }) => isHardFailure(card)) ? "failed" : facts.issues.some(({ card }) => errorKindOf(card.name, card.output?.text) === "blocked") ? "blocked" : "exit";
	// 耗时单独成节点，好让 count 动效只改它的 opacity，不牵动整行的排版。
	// 运行中还差步数时把操作计数换成进度（已完成 X/N），全部收尾后回到总计数。
	const doneCount = actions.filter(({ card }) => ["ok", "error", "cancelled"].includes(card.status)).length;
	const countText = !actions.length ? undefined : running && doneCount < actions.length ? copy("stepProgress", { done: doneCount, total: actions.length }) : copy("stepCount", { n: actions.length });
	const metadataTail = [countText, facts.recovered.length ? copy("recoveredCount", { n: facts.recovered.length }) : undefined].filter(Boolean).join(" · ");
	// 结束态的结果词：全部成功亮绿、取消标中性；失败不加词——红色 issue link 已经是那个信号，再写一遍计数就是重复。
	const finishedRun = !running && actions.length > 0;
	const cancelledRun = finishedRun && facts.issues.length === 0 && actions.some(({ card }) => card.status === "cancelled");
	const allDoneRun = finishedRun && facts.issues.length === 0 && !cancelledRun;
	const terminalWord = allDoneRun ? { text: copy("allDone"), tone: "ok" } : cancelledRun ? { text: copy("runCancelled"), tone: "neutral" } : undefined;
	const terminalTone = allDoneRun ? "text-owl-success" : cancelledRun ? "text-owl-faint" : !finishedRun ? "" : issueKind === "failed" ? "text-owl-danger" : issueKind === "blocked" ? "text-owl-warning" : "";
	// 预览只取末 3 行：超出时给出「末 3 行 · 共 N 行」，不让人把尾巴当全部。
	const latestOutputLineCount = latestOutput?.card.output !== undefined ? Math.max(latestOutput.card.output.totalLines ?? 0, latestOutput.card.output.text.split("\n").length) : 0;
	const latestOutputLines = latestOutputLineCount > 3 ? latestOutputLineCount : undefined;
	const hasOrdinaryItems = items.some((item) => !item.interactive);
	useEffect(() => {
		if (!open || !focusedTool) return;
		const frame = requestAnimationFrame(() => {
			const viewport = root.current?.closest<HTMLElement>(".owl-chat-scroll");
			const target = [...(root.current?.querySelectorAll<HTMLElement>("[data-tool-id]") ?? [])].find((element) => element.dataset.toolId === focusedTool.toolId && element.dataset.toolOwner === String(focusedTool.ownerIndex));
			if (!viewport || !target) return;
			viewport.removeAttribute("data-owl-scroll-restoring");
			viewport.dataset.owlSearchNavigation = "work-issue";
			viewport.scrollTo({ top: messageScrollTop(viewport, target), behavior: "instant" });
			viewport.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
		});
		return () => cancelAnimationFrame(frame);
	}, [focusedTool, open]);
	const jumpToAnswer = (): void => {
		const viewport = root.current?.closest<HTMLElement>(".owl-chat-scroll");
		let target = root.current?.closest(".owl-chat-row")?.nextElementSibling;
		while (target && !target.hasAttribute("data-qidx")) {
			if (target instanceof HTMLElement && target.dataset.owlAnswer === "true" && viewport) {
				viewport.removeAttribute("data-owl-scroll-restoring");
				viewport.dataset.owlSearchNavigation = "answer";
				viewport.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
				viewport.scrollTo({ top: messageScrollTop(viewport, target), behavior: "instant" });
				viewport.dispatchEvent(new Event("scroll"));
				return;
			}
			target = target.nextElementSibling;
		}
	};
	const collapseProcess = (): void => {
		setProcessOpen(false);
		const summary = root.current?.querySelector<HTMLButtonElement>(".owl-work-process-summary");
		const viewport = root.current?.closest<HTMLElement>(".owl-chat-scroll");
		summary?.focus({ preventScroll: true });
		if (viewport && summary) viewport.scrollTo({ top: messageScrollTop(viewport, summary), behavior: "instant" });
	};
	// 等待回答时的直达入口：滚动到底部并聚焦提问卡（没有提问卡时聚焦输入框）。
	// 用户作答后 userJustSent 会自己恢复贴底跟随，这里只负责把人带到能作答的地方。
	const jumpToComposer = (): void => {
		const viewport = root.current?.closest<HTMLElement>(".owl-chat-scroll");
		if (viewport) {
			viewport.removeAttribute("data-owl-scroll-restoring");
			viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
			viewport.dispatchEvent(new Event("scroll"));
		}
		const question = document.querySelector<HTMLElement>(".owl-question-anchor:not([hidden])");
		const target = question?.querySelector<HTMLElement>("button, [role='textbox'], input, textarea, select") ?? document.querySelector<HTMLElement>(".owl-composer-input [role='textbox']");
		target?.focus({ preventScroll: true });
		// 到达确认：卡片闪一圈琥珀描边（与等待态同色），告诉人「到这儿了」。一次性 WAAPI，不常驻。
		const card = question?.querySelector<HTMLElement>(".owl-question-card");
		const motionAllowed = document.documentElement.dataset.owlChatMotion !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (card && motionAllowed && typeof card.animate === "function") {
			card.animate(
				[
					{ boxShadow: "0 0 0 2px color-mix(in srgb, var(--color-owl-warning) 55%, transparent), 0 2px 8px rgb(0 0 0 / 8%)" },
					{ boxShadow: "0 0 0 2px transparent, 0 2px 8px rgb(0 0 0 / 8%)" },
				],
				{ duration: 720, easing: "ease-out" },
			);
		}
	};
	const inspectAction = (action: WorkAction): void => {
		if (onInspectTool) onInspectTool(action.card, action.ownerIndex);
		else { setProcessOpen(true); setFocusedTool({ toolId: action.card.id, ownerIndex: action.ownerIndex }); }
	};
	return (
		<WorkToolFocusContext.Provider value={searchFocus ?? focusedTool}>
		<WorkArrivedContext.Provider value={arrivedActions}>
		<WorkNowContext.Provider value={running ? now : undefined}>
		<div ref={root} className="owl-work-process" data-state={waiting ? "waiting" : running ? "running" : "finished"} data-view={view} data-fx={enabledWorkEffectIds(workEffects).join(" ")} data-failed-count={scopes.reduce((sum, scope) => sum + scope.failed, 0)}>
			{hasOrdinaryItems && <div className="owl-work-process-header" data-message-action-ui="">
				<button type="button" aria-expanded={open} aria-controls={panelId} data-work-reading="" onClick={() => setProcessOpen(!open)} className="owl-tool-summary owl-work-process-summary">
					{waiting ? <span className="owl-status-slot"><IconClock className="h-3.5 w-3.5 shrink-0" /></span> : running ? current ? <StatusSlot status={current.card.status} justDone={current.card.status !== "running" && current.card.status !== "pending"} /> : <span className="owl-status-slot"><IconLightbulb className="h-3.5 w-3.5 shrink-0" /></span> : <span className="owl-status-slot"><IconTerminal className={"h-3.5 w-3.5 shrink-0 " + terminalTone} /></span>}
					<span className="owl-work-primary" role={running ? "status" : undefined} aria-live={running ? "polite" : undefined}>{current && workActionPath(current.card) ? primary : <InlineSummary text={primary} />}</span>
					<span className="owl-work-metadata">{elapsed !== undefined && <span className="owl-work-secs">{formatDuration(elapsed)}</span>}{elapsed !== undefined && (metadataTail !== "" || terminalWord !== undefined) ? " · " : ""}{metadataTail}{terminalWord !== undefined && metadataTail !== "" ? " · " : ""}{terminalWord !== undefined && <span className="owl-work-terminal-word" data-tone={terminalWord.tone}>{terminalWord.text}</span>}</span>
					<IconChevron className={"owl-work-summary-chevron h-3 w-3 shrink-0 transition-transform " + (open ? "rotate-90" : "")} />
				</button>
				{facts.issues.length > 0 && <button type="button" className="owl-work-issue-link" data-error-kind={issueKind} data-work-reading="" title={copy("issueHint")} onClick={() => {
					const issue = facts.issues[issueCursor.current++ % facts.issues.length]!;
					setProcessOpen(true);
					setFocusedTool({ toolId: issue.card.id, ownerIndex: issue.ownerIndex });
				}}><IconAlert className="h-3 w-3" />{copy("issueCount", { n: facts.issues.length })}</button>}
			</div>}
			{activeScope?.subagents.some((card) => card.status === "running" || card.status === "pending") && <div className="owl-work-delegations">{activeScope.subagents.filter((card) => card.status === "running" || card.status === "pending").map((card) => <SubagentLiveLine key={card.id} card={card} onOpen={() => onOpenSubagent ? onOpenSubagent(card) : setProcessOpen(true)} />)}</div>}
			<div id={panelId} className="owl-tool-group-body owl-work-process-body" data-open={open}>
				{items.filter((item) => !item.thinking && (open || item.interactive || item.note)).map((item) => <div key={item.key} data-entry-id={item.entryId} className="owl-work-process-item" data-work-kind={item.interactive ? "interactive" : item.note ? "note" : item.cards ? "tool" : "note"} data-fresh={item.cards ? "false" : arrivedItems.has(item.key) ? "true" : "false"}>{item.content}</div>)}
				{thinkingSegments.length > 0 && <div className="owl-work-process-item" data-work-kind="thinking" data-fresh={arrivedItems.has(thinkingSegments[0]!.key) ? "true" : "false"} hidden={!open && view === "normal"}>{open || view !== "normal" ? <ThinkingRow thinking={thinkingSegments.map((segment) => segment.text).join("\n\n")} segments={thinkingSegments} searchTarget={searchTarget} /> : null}</div>}
			</div>
			{latestStatus && <div className="owl-work-latest-state" data-status={latestStatus.card.status} data-error-kind={latestStatus.card.status === "error" ? errorKindOf(latestStatus.card.name, latestStatus.card.output?.text) : undefined}>
				<span className="owl-work-record-label">{copy(reviewIssue ? "reviewIssue" : "latestStatus")}</span>
				<StatusIcon status={latestStatus.card.status} errorKind={latestStatus.card.status === "error" ? errorKindOf(latestStatus.card.name, latestStatus.card.output?.text) : undefined} />
				<span className="owl-work-latest-title"><InlineSummary text={workActionTitle(latestStatus.card)} /></span>
				<span className="owl-work-status-word">{workActionStatus(latestStatus.card)}</span>
			</div>}
			{latestOutput && <section className="owl-work-latest-output" aria-label={copy("latestOutput")} data-output-status={latestOutput.card.status}>
				<div className="owl-work-latest-toolbar"><span>{copy("latestOutput")}{latestOutput.key !== current?.key ? " · " + workActionTitle(latestOutput.card) : ""}</span>
					{latestOutputLines !== undefined && <span className="owl-work-latest-lines">{copy("latestLinesHint", { n: 3, total: latestOutputLines })}</span>}
					{/* 预览只有末 3 行：把刚出现的报错/路径直接复制走，不必为此开完整面板。 */}
					{latestOutput.card.output?.text !== undefined && <MessageCopyButton text={latestOutput.card.output.text} label={copy("copyOutput")} identity={latestOutput.key + ":latest"} showLabel />}
					<button type="button" data-work-reading="" onClick={() => inspectAction(latestOutput)}>{copy("inspectTool")}</button>
				</div>
				<pre>{tailLines(latestOutput.card.output!.text, 3).preview}</pre>
			</section>}
			{waiting && current && <div className="owl-work-waiting-cta">
				<button type="button" className="owl-work-go-answer" data-work-reading="" onClick={jumpToComposer}>{copy("goAnswer")}<span aria-hidden="true">↓</span></button>
			</div>}
			{hasOrdinaryItems && open && <div className="owl-work-process-foot" data-message-action-ui="">
				{hasAnswer && <button type="button" className="owl-work-answer-link" data-work-reading="" onClick={jumpToAnswer}>{copy("viewAnswer")}</button>}
				<button type="button" data-work-reading="" onClick={collapseProcess}>{copy("collapse")}</button>
			</div>}
		</div>
		</WorkNowContext.Provider>
		</WorkArrivedContext.Provider>
		</WorkToolFocusContext.Provider>
	);
}

/** 子智能体实时行：打开该次委派的活动记录，未接入查看入口时展开工作过程。 */
function SubagentLiveLine({ card, onOpen }: { card: ToolCard; onOpen: () => void }): React.JSX.Element {
	let agent = "";
	let task = "";
	try {
		const args = JSON.parse(card.args) as Record<string, unknown>;
		if (typeof args.agent === "string") agent = args.agent;
		else if (typeof args.subagent === "string") agent = args.subagent;
		const raw = args.task ?? args.prompt ?? args.instructions;
		if (typeof raw === "string") task = raw;
	} catch {
		// 参数还不是合法 JSON 时退回人话摘要
	}
	const activity = card.output?.text.split("\n").map((line) => line.trim()).filter(Boolean).pop();
	return (
		<button
			type="button"
			onClick={onOpen}
			title={activity ?? task}
			className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs"
		>
			<StatusIcon status={card.status} />
			<span className="shrink-0 font-mono text-owl-accent">
				{agent ? t("chat.subagentLabel", { agent }) : t("chat.subagentPlain")}
			</span>
			<span className="min-w-0 flex-1 truncate text-owl-faint">{task || card.summary}</span>
		</button>
	);
}

/** 孤立结果行（找不到所属工具卡的防御兜底，如会话恢复失败）。 */
function OrphanResultRow({ entry }: { entry: Extract<ChatEntry, { kind: "toolResult" }> }): React.JSX.Element {
	return (
		<div className="flex items-center gap-2 text-xs">
			<span className={entry.ok ? "text-owl-success" : "text-owl-danger"}>{entry.ok ? "✓" : "✗"}</span>
			<span className="font-mono text-owl-accent">{entry.toolName}</span>
			<span className="min-w-0 flex-1 text-owl-faint">{entry.brief}</span>
		</div>
	);
}

/**
 * 回答底部操作栏（对照参考实现）：复制 / 在新对话中分支 /（仅最新一轮）
 * 重新生成 + 用量与时间元信息。一轮回答含多次 LLM 调用时只在最后一条下挂一条，
 * usage 传整轮聚合值。
 */
type OutputRate = ReturnType<typeof outputRate>;

/** 三点展开：输出速度、总 token，以及输入/缓存明细。运行中与回答结束后共用同一块。 */
function UsageDetails({ usage, requestCount, rate }: { usage?: MessageUsage; requestCount: number; rate?: OutputRate }): React.JSX.Element | null {
	if (!usage && !rate) return null;
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
	const summary = t("chat.msgUsage", { n: formatTokenCount(totalTokens), calls: requestCount });
	return (
		<details className="owl-response-details">
			<summary aria-label={summary} title={summary}>
				<IconMore className="h-3.5 w-3.5" />
			</summary>
			<div className="owl-response-metrics">
				{totalTokens > 0 && <span>{t("chat.activityTokens", { output: formatTokenCount(usage!.output), n: formatTokenCount(totalTokens) })}</span>}
				{rate && <span>{t(rate.estimated ? "chat.activityTpsEstimated" : "chat.activityTps", { n: compactNumber(Math.floor(rate.tps)) })}</span>}
				{usageTitle && <p className="owl-response-usage">{usageTitle}</p>}
			</div>
		</details>
	);
}

function AssistantFooter({ entry, usage: usageOverride, requestCount, rate, canRegenerate, onRegenerate, canBranch, onBranch }: {
	entry: Extract<ChatEntry, { kind: "assistant" }>;
	/** 整轮聚合用量；缺省退回本条消息自己的用量 */
	usage?: MessageUsage;
	requestCount: number;
	/** 本轮最近一条可测速回复；结束后不再估算。 */
	rate?: OutputRate;
	canRegenerate: boolean;
	onRegenerate?: () => void;
	canBranch: boolean;
	onBranch?: () => void;
}): React.JSX.Element {
	const actionCopy = useMessageActionsText();
	const usage = usageOverride ?? entry.usage;
	return (
		<div className="owl-msg-actions flex-wrap" data-message-action-ui="" title={entry.timestamp !== undefined ? formatAgo(entry.timestamp) : undefined}>
			<MessageCopyButton text={entry.text} label={t("chat.msgCopy")} identity={entry.entryId} />
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
			{canBranch && onBranch && <MessageMoreMenu label={actionCopy("more")} identity={entry.entryId} items={[{ id: "branch", label: t("chat.msgBranch"), onSelect: onBranch }]} />}
			<UsageDetails usage={usage} requestCount={requestCount} rate={rate} />
		</div>
	);
}

/** 气泡正文：技能调用只亮技能名标签，不铺开 SKILL.md 全文。 */
function UserText({ text }: { text: string }): React.JSX.Element {
	const skill = parseSkillInvocation(text);
	if (!skill) return <>{text}</>;
	return (
		<>
			<span className="owl-skill-chip" title={`/skill:${skill.name}`}>{skill.name}</span>
			{skill.rest && <>{" "}{skill.rest}</>}
		</>
	);
}

/** 用户提问行：随消息附的图片缩略图（点击放大）+ 文本气泡 + 悬停浮现的 编辑/复制/回退 按钮。 */
function UserRowViewInner({
	entry,
	busy,
	onRewind,
	onEditMessage,
	receipts,
	cwd, sessionId, client, onOpenFile, onLocateAttachment,
}: {
	entry: Extract<ChatEntry, { kind: "user" }>;
	busy: boolean;
	onRewind?: (entryId: string) => void;
	onEditMessage?: (entryId: string, text: string, images?: ToolResultImage[]) => boolean | void | Promise<boolean | void>;
	receipts?: Receipt[];
	cwd?: string;
	sessionId?: string;
	client?: BridgeClient;
	onOpenFile?: (path: string) => void | Promise<void>;
	onLocateAttachment?: (toolId: string, ownerIndex?: number) => void;
}): React.JSX.Element {
	const actionCopy = useMessageActionsText();
	const editImpactId = useId();
	const [zoomed, setZoomed] = useState<number | null>(null);
	const [editing, setEditing] = useState(false);
	const sourceText = userSourceText(entry.text);
	const [draft, setDraft] = useState(sourceText);
	const images = entry.images ?? [];
	const attachedPaths = entry.attachedPaths ?? [];
	const canRewind = Boolean(entry.entryId && onRewind);
	// 编辑=重发：回退到这条消息再发新文本（会截断其后对话），必须带 entryId 且会话空闲
	const canEdit = Boolean(entry.entryId && onEditMessage) && !busy;
	if (editing) {
		const submit = (): void => {
			if (busy) return;
			const text = draft.trim();
			if (!text || text === sourceText.trim() || !entry.entryId) {
				setEditing(false);
				return;
			}
			// 回退失败时留在编辑框，避免看起来像已经取消或发出。
			void Promise.resolve(onEditMessage?.(entry.entryId, text, images.length > 0 ? images : undefined)).then((accepted) => {
				if (accepted !== false) setEditing(false);
			});
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
						aria-describedby={editImpactId}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "Escape") {
								event.stopPropagation();
								setEditing(false);
							} else if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						}}
					/>
					<p id={editImpactId} className="owl-user-edit-impact" data-message-action-ui="">{actionCopy("editImpact")}</p>
					<div className="owl-user-editor-actions">
						<button type="button" className="owl-user-editor-button" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
						<button type="button" className="owl-user-editor-button is-primary" disabled={busy || draft.trim() === ""} onClick={submit}>
							{t("chat.msgEditSend")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="owl-user-row">
			<div className="owl-user-bubble">
				{images.length > 0 && (
					<div className={`flex flex-wrap justify-end gap-1.5${attachedPaths.length > 0 || entry.text.trim() !== "" ? " mb-1.5" : ""}`}>
						{images.map((image, index) => (
							<button type="button" key={index} className="owl-image-trigger" aria-label={t("chat.attachment", { n: index + 1 })} onClick={() => setZoomed(index)}><img
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={t("chat.attachment", { n: index + 1 })}
								className="max-h-44 max-w-56 cursor-zoom-in rounded-lg border border-owl-border object-contain"
							/></button>
						))}
					</div>
				)}
				{attachedPaths.length > 0 && (
					<div className="owl-user-files">
						{(receipts ?? attachedPaths.map((path) => ({ path, status: "referenced" as const, evidence: [] }))).map((receipt) => <AttachmentReceipt key={receipt.path} receipt={receipt} cwd={cwd} sessionId={sessionId} client={client} onOpenFile={onOpenFile} onLocate={onLocateAttachment} />)}
					</div>
				)}
				{entry.text.trim() !== "" && <UserText text={entry.text} />}
				{(entry.omittedImages ?? 0) > 0 && (
					<div className="owl-user-note">{t("chat.imagesOmitted", { n: entry.omittedImages! })}</div>
				)}
			</div>
			<div className="owl-user-actions" role="group" aria-label={actionCopy("userActions")} data-message-action-ui="">
				{canEdit && <button type="button" className="owl-user-quick" title={t("chat.msgEdit")} aria-label={t("chat.msgEdit")} onClick={() => { setDraft(sourceText); setEditing(true); }}>
					<IconCompose className="h-3.5 w-3.5" />
				</button>}
				<MessageCopyButton text={sourceText} label={t("chat.msgCopy")} className="owl-user-quick" identity={entry.entryId} />
				{canRewind && <button type="button" className="owl-rewind-trigger" title={t("rewind.buttonTitle")} aria-label={t("rewind.buttonTitle")} onClick={() => entry.entryId && onRewind?.(entry.entryId)}>↶</button>}
			</div>
			{zoomed !== null && images[zoomed] !== undefined && (
				<ImageViewer images={images.map((image, index) => ({ src: `data:${image.mimeType};base64,${image.data}`, alt: t("chat.attachment", { n: index + 1 }) }))} index={zoomed} onIndexChange={setZoomed} onClose={() => setZoomed(null)} />
			)}
		</div>
	);
}

/** 已落盘的用户行 props 全部稳定（回调经 useStableOption 转换），memo 让流式 batch 直接跳过。 */
const UserRowView = memo(UserRowViewInner);

/** buildRows 的上下文：渲染回调 + 消息操作（编辑/分支/重新生成）的可用性。 */
type RowOptions = {
	entries: ChatEntry[];
	sessionId?: string;
	onLocateAttachment?: (toolId: string, ownerIndex?: number) => void;
	searchTarget?: MessageSearchTarget;
	expandedTools: boolean;
	onRewind?: (entryId: string) => void;
	cwd?: string;
	onOpenFile?: (path: string) => void;
	turnCard?: (artifacts: FileArtifact[]) => React.JSX.Element | null;
	/** Specialized artifacts belong to their producing turn, including the active one. */
	renderTurnArtifacts?: (entries: ChatEntry[]) => React.ReactNode;
	/** 最新一轮回答还在流式：最后一条 assistant 不渲染操作栏。 */
	streaming: boolean;
	/** The run also remains active while waiting for approval. */
	runActive: boolean;
	/** 会话空闲且最后一条用户消息带 entryId：最后一条回答可「重新生成」。 */
	canRegenerate: boolean;
	onRegenerate?: () => void;
	onEditMessage?: (entryId: string, text: string, images?: ToolResultImage[]) => boolean | void | Promise<boolean | void>;
	/** 「在新对话中分支」：以该条回答为末梢复制新会话并切换。 */
	onBranch?: (entryId: string) => void;
	/** 会话内任务卡的「任务页」跳转（自动化任务 Rail 视图）。 */
	onOpenAutomation?: () => void;
	onOpenSubagent?: (card: ToolCard) => void;
	/** 桥客户端：任务卡的「暂停任务」需要。 */
	client?: BridgeClient;
	/** 会话忙（运行/提交中）：暂停用户消息的编辑重发。 */
	busy: boolean;
	/** 行内容缓存域（profile/session/cwd/客户端）：条目元素按它分桶，切会话不串。 */
	cacheScope: string;
	/** 跨条目的工具批次元素缓存（一个工具批次可横跨多条 assistant 消息）。 */
	batchItems: Map<string, BatchItem>;
};

/** Keep prose and tool groups in the order emitted by the assistant. */
function buildRows({ entries, sessionId, onLocateAttachment, searchTarget, expandedTools, onRewind, cwd, onOpenFile, turnCard, renderTurnArtifacts, streaming, runActive, canRegenerate, onRegenerate, onEditMessage, onBranch, onOpenAutomation, onOpenSubagent, client, busy, cacheScope, batchItems }: RowOptions): TimelineRow[] {
	const rows: TimelineRow[] = [];
	const attachmentReceipts = collectAttachmentReceipts(entries, cwd);
	const toolOwners = new Map<ToolCard, number>();
	entries.forEach((entry, index) => { if (entry.kind === "assistant") for (const tool of entry.tools) toolOwners.set(tool, index); });
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
	let lastFooter: { row: TimelineRow; index: number; entry: Extract<ChatEntry, { kind: "assistant" }>; usage?: MessageUsage; requestCount: number; rate?: OutputRate } | undefined;
	// 轮内操作栏收集：一轮（两条用户消息之间）可能含多次 LLM 调用（中间说明 + 最终回答），
	// 操作栏只保留轮内最后一条有正文的调用并把整轮用量聚到它身上，其余从行列表剔除
	let turnFooters: Array<{ row: TimelineRow; index: number; entry: Extract<ChatEntry, { kind: "assistant" }> }> = [];
	let turnUsage: MessageUsage | undefined;
	let turnRequestCount = 0;
	let turnRate: OutputRate;
	// 流式中的进行轮（最后一条用户消息之后的条目）还没定型，整轮操作栏等 agent_end 重建后再出现
	let lastUserIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.kind === "user" && !entry.queued) {
			lastUserIndex = i;
			break;
		}
	}
	let activeRunIndex = currentRunStartIndex(entries) ?? (lastUserIndex >= 0 ? lastUserIndex : entries.length);
	entries.forEach((entry, index) => {
		if (index >= activeRunIndex && entry.kind === "assistant" && (entry.aborted || entry.error))
			activeRunIndex = index + 1;
	});
	// 每轮（两条用户消息之间）的「最终回答」= 该轮最后一条带正文的 assistant。
	// 上屏顺序：工作过程在前，最终正文与操作栏在后，继续保留原来的成果与交付组件。
	// 思考、普通工具和提问工具保留在过程记录中；公开中间说明始终可见。
	// 轮内没有正文（被停止/还在生成）时不标回答，工作段在轮末收口。
	const assistantHasText = (entry: ChatEntry): boolean => {
		if (entry.kind !== "assistant") return false;
		const segments: AssistantSegment[] = entry.segments ?? [
			...(entry.thinking ? [{ kind: "thinking" as const, text: entry.thinking }] : []),
			...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []),
			...entry.tools.map((tool) => ({ kind: "tool" as const, toolId: tool.id })),
		];
		return segments.some((segment, index) => segment.kind === "text" && segment.phase !== "commentary" && segment.text.trim() !== "" && (segment.phase === "final_answer" || !segments.slice(index + 1).some((later) => later.kind === "tool")));
	};
	// 中间说明是否携带 owl-ui 围栏（GenuiAnswerCard 只吃最终答案文本，判定与它同源）。
	const assistantHasOwlUiFence = (entry: ChatEntry): boolean => {
		if (entry.kind !== "assistant") return false;
		const segments: AssistantSegment[] = entry.segments ?? [
			...(entry.thinking ? [{ kind: "thinking" as const, text: entry.thinking }] : []),
			...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []),
		];
		return segments.some((segment) => segment.kind === "text" && segment.phase !== "commentary" && segment.text.includes("```owl-ui"));
	};
	const answerEntries = new Set<number>();
	// 模型在出完 owl-ui 围栏后又调用工具（如执行异常补报）时，围栏所在的中间说明会被
	// 折叠进工作过程，界面只剩末尾无围栏的纯文本。本轮最终答案不带围栏时，把带围栏的
	// 中间说明提升为答案行，看板不再藏在折叠区里。
	const promotedFenceEntries = new Set<number>();
	{
		let turnTextIndexes: number[] = [];
		let turnFenceIndexes: number[] = [];
		const commitTurn = (): void => {
			const answer = turnTextIndexes.at(-1) ?? turnFenceIndexes.at(-1);
			if (answer !== undefined) {
				answerEntries.add(answer);
				if (!assistantHasOwlUiFence(entries[answer]!)) {
					const candidate = turnFenceIndexes[0];
					if (candidate !== undefined) promotedFenceEntries.add(candidate);
				}
			}
			turnTextIndexes = [];
			turnFenceIndexes = [];
		};
		entries.forEach((entry, index) => {
			if (entry.kind === "user") {
				if (entry.queued) return;
				commitTurn();
				return;
			}
			if (assistantHasText(entry)) turnTextIndexes.push(index);
			if (assistantHasOwlUiFence(entry)) turnFenceIndexes.push(index);
		});
		commitTurn();
	}
	// 操作栏工厂：已落盘的历史回答随时可分支（会话正在跑也不收按钮，进行中的这一轮
	// 本来就没有操作栏）；重新生成只在末条、且会话空闲时开启。
	const assistantFooter = (entry: Extract<ChatEntry, { kind: "assistant" }>, index: number, allowRegenerate: boolean, usage: MessageUsage | undefined, requestCount: number, rate: OutputRate): React.JSX.Element => (
		<AssistantFooter
			entry={entry}
			usage={usage}
			requestCount={requestCount}
			rate={rate}
			canRegenerate={allowRegenerate}
			onRegenerate={allowRegenerate ? onRegenerate : undefined}
			canBranch={entry.entryId !== undefined && onBranch !== undefined}
			onBranch={entry.entryId !== undefined && onBranch ? () => onBranch(entry.entryId!) : undefined}
		/>
	);
	const finishTurnFooters = (): void => {
		const totalUsage = turnUsage;
		const requestCount = turnRequestCount;
		const rate = turnRate;
		turnUsage = undefined;
		turnRequestCount = 0;
		turnRate = undefined;
		if (turnFooters.length === 0) return;
		const keep = turnFooters[turnFooters.length - 1]!;
		for (const item of turnFooters) {
			if (item === keep) continue;
			const position = rows.indexOf(item.row);
			if (position >= 0) rows.splice(position, 1);
		}
		// 幸存的操作栏按整轮聚合用量重渲染（push 时的值可能缺其后纯工具调用的用量）
		keep.row.content = assistantFooter(keep.entry, keep.index, false, totalUsage, requestCount, rate);
		lastFooter = { ...keep, usage: totalUsage, requestCount, rate };
		turnFooters = [];
	};
	let turn = 0;
	let turnEntries: ChatEntry[] = [];
	// 当前这段工作的起点，用来写「工作了 7m 23s」：本轮第一段从用户发消息算起，
	// 后续每段从上一段收口时算起，各段只显示自己的耗时，不累计。
	let workStartedAt: number | undefined;
	let resumeWorkClock = false;
	// 结论出现前先把工作行放到正文上面，一轮只放一次。
	let answerWorkFlushed = false;
	// 轮内截图（截图类工具的产物）：最终回答之后平铺成「本轮截图」条，免翻折叠行
	let turnShots: Array<{ key: string; image: ToolResultImage }> = [];
	// ── 整轮工作过程收纳：跨 LLM 调用累积思考/中间说明/普通工具（含提问工具）。
	// 在正文出现前或当前段收口时整理过程，保持真实工作段边界。todo 仍由独立入口管理。
	// 交互渲染卡保留原组件，不转换成普通命令或静态答案。
	let workRows: WorkProcessItem[] = [];
	let workSteps = 0;
	let workFailed = 0;
	let workPendingTools: ToolCard[] = [];
	let workSubagents: ToolCard[] = [];
	let workSeq = 0;
	let workFinishedAt: number | undefined;
	let workLastEntryIndex = -1;
	type TurnProcess = { row: TimelineRow; scopes: WorkProcessScope[]; hasAnswer: boolean; turn: number };
	const processes: TurnProcess[] = [];
	const workSegments: WorkProcessScope[] = [];
	let turnProcess: TurnProcess | undefined;
	let turnHasAnswer = false;
	let workBoundary = "start";
	const recordWork = (entry: Extract<ChatEntry, { kind: "assistant" }>, index: number, tool?: ToolCard): void => {
		workLastEntryIndex = index;
		for (const time of [entry.endedAt, tool?.finishedAt]) {
			if (time !== undefined && Number.isFinite(time)) workFinishedAt = Math.max(workFinishedAt ?? time, time);
		}
	};
	const flushWorkTools = (): void => {
		if (workPendingTools.length === 0) return;
		const cards = workPendingTools;
		workPendingTools = [];
		workSubagents.push(...cards.filter((card) => card.name === "subagent"));
		workSteps += cards.length;
		workFailed += cards.filter(isHardFailure).length;
		const entryIds = new Map<number, string>(cards.flatMap((card) => {
			const owner = toolOwners.get(card);
			const entry = owner === undefined ? undefined : entries[owner];
			return owner !== undefined && entry?.kind === "assistant" && entry.entryId ? [[owner, entry.entryId] as const] : [];
		}));
		// 工具批次元素按内容签名缓存：卡片对象在条目重建时换新身份，但内容不变就复用，
		// React 对相同引用的整棵工具树跳过调和（批次可能横跨多条 assistant，不能按条目缓存）。
		const batchSig = cards.map((card) => `${card.id}:${card.status}:${card.output === undefined ? "" : "o"}`).join("|");
		const batchKey = `tools:${expandedTools ? "expanded" : "collapsed"}:${cards[0]!.id}:${cards.length}`;
		const cachedBatch = batchItems.get(batchKey);
		const content = cachedBatch !== undefined && cachedBatch.sig === batchSig ? cachedBatch.element : (() => {
			const element = <ToolRecords cards={cards} owners={toolOwners} entryIds={entryIds} expanded={expandedTools} onOpenSubagent={onOpenSubagent} />;
			batchItems.set(batchKey, { sig: batchSig, element });
			return element;
		})();
		workRows.push({
			key: "tools-" + toolOwners.get(cards[0]!) + ":" + cards[0]!.id,
			toolIds: cards.map((card) => `${toolOwners.get(card)}:${card.id}`),
			cards,
			owners: toolOwners,
			entryIds,
			content,
		});
	};
	// Preserve emitted segment order. Only the latest segment owned by the active run is live.
	// 交互卡先于折叠行，并且在没有工具步时也要落盘。
	const flushWork = (finishedAt?: number): void => {
		flushWorkTools();
		if (workRows.length === 0) return;
		const items = workRows;
		const steps = workSteps;
		const failed = workFailed;
		const startedAt = workStartedAt;
		const subagents = workSubagents;
		if (finishedAt !== undefined && Number.isFinite(finishedAt)) workFinishedAt = Math.max(workFinishedAt ?? finishedAt, finishedAt);
		const lastEntryIndex = workLastEntryIndex;
		const scope: WorkProcessScope = { id: "scope-" + workSeq++, items, steps, failed, startedAt, finishedAt: workFinishedAt, subagents, lastEntryIndex };
		workStartedAt = workFinishedAt;
		resumeWorkClock = workFinishedAt === undefined;
		workRows = [];
		workSteps = 0;
		workFailed = 0;
		workSubagents = [];
		workFinishedAt = undefined;
		workLastEntryIndex = -1;
		if (!turnProcess) {
			const row: TimelineRow = { key: "work-turn-" + turn + "-" + workBoundary, quiet: true, content: <></> };
			turnProcess = { row, scopes: [], hasAnswer: turnHasAnswer, turn };
			processes.push(turnProcess);
			rows.push(row);
		}
		turnProcess.scopes.push(scope);
		workSegments.push(scope);
	};
	const flushTurnArtifacts = (): void => {
		if (turnEntries.length === 0) return;
		// 只在 agent 真正登记了验收清单时才出卡：文件数与执行记录分别由改动卡和工作过程承担，这里再列一遍就是重复。
		if (deliveryChecklist(turnEntries)) rows.push({ key: "turn-delivery-" + turn, quiet: true, deliveryTurn: turnEntries.find((entry): entry is Extract<ChatEntry, { kind: "user" }> => entry.kind === "user" && !entry.queued)?.entryId, content: <DeliverySummary entries={turnEntries} /> });
		const content = renderTurnArtifacts?.(turnEntries);
		if (content != null) rows.push({ key: "turn-artifacts-" + turn, quiet: true, content: <>{content}</> });
	};
		entries.forEach((entry, index) => {
			if (index === activeRunIndex && entry.kind !== "user") {
				flushWork();
				workStartedAt = entry.kind === "assistant" ? entry.timestamp : undefined;
			}
			if (entry.kind === "user" && entry.queued) {
				flushWork();
				turnProcess = undefined;
				workBoundary = "queued-" + index;
				rows.push({
					key: "queued-" + index,
					entryId: entry.entryId,
					content: (
						<div className="owl-user-queued">
							<div className="owl-user-bubble"><UserText text={entry.text} />{(entry.attachedPaths?.length ?? 0) > 0 && <div className="owl-user-files">{attachmentReceipts.get(index)?.map((receipt) => <AttachmentReceipt key={receipt.path} receipt={receipt} cwd={cwd} sessionId={sessionId} client={client} onOpenFile={onOpenFile} />)}</div>}</div>
							<span className="owl-user-queued-hint">{t("composer.queuedHint")}</span>
						</div>
					),
				});
				return;
			}
			if (entry.kind === "user") {
				finishTurnFooters();
				flushWork();
				flushTurnArtifacts();
				turnEntries = [entry];
				turnShots = [];
				workStartedAt = entry.timestamp;
				resumeWorkClock = false;
				answerWorkFlushed = false;
				const artifacts = historicalArtifacts?.get(index);
				if (artifacts && onOpenFile) {
					const node = turnCard ? turnCard(artifacts) : <Artifacts artifacts={artifacts} client={client} cwd={cwd} onOpenFile={onOpenFile} />;
					if (node) rows.push({ key: "artifacts-" + index, quiet: true, content: node });
				}
				turn += 1;
				turnProcess = undefined;
				turnHasAnswer = false;
				workBoundary = "start";
				// 自动化任务的到点投递渲染成任务卡（可暂停），不是普通用户气泡。
				const delivery = parseScheduleDelivery(entry.text);
				rows.push({
					key: "q" + turn,
					entryId: entry.entryId,
					questionIndex: turn,
					content: delivery
						? <ScheduleDeliveryCard info={delivery} client={client} onOpenAutomation={onOpenAutomation} />
						: <UserRowView entry={entry} busy={busy} onRewind={onRewind} onEditMessage={onEditMessage} receipts={attachmentReceipts.get(index)} cwd={cwd} sessionId={sessionId} client={client} onOpenFile={onOpenFile} onLocateAttachment={onLocateAttachment} />,
				});
				return;
			}
		turnEntries.push(entry);
		if (entry.kind === "toolResult") {
			flushWork();
			turnProcess = undefined;
			workBoundary = "result-" + index;
			rows.push({ key: "result-" + index, content: <OrphanResultRow entry={entry} /> });
			return;
		}
		if (resumeWorkClock) {
			workStartedAt = entry.timestamp;
			resumeWorkClock = false;
		}
		const seenTools = new Set<string>();
		// 整轮用量累计：纯工具调用的 LLM 轮没有正文、不上屏操作栏，但同样是整轮成本
		turnUsage = addUsage(turnUsage, entry.usage);
		turnRequestCount += 1;
		const measured = outputRate(entry);
		if (measured) turnRate = measured;
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
			// 任务清单的实时状态由对话区右上角的入口（TodoPin）独占展示：时间轴不再
			// 上屏 todo 卡片（更新频繁，且与清单内容完全重复），也不计入折叠区步数
			if (card.name === "todo") return;
			recordWork(entry, index, card);
			if (card.name === "render_ui" && card.output?.genuiSpec !== undefined) {
				// owl-genui：完成后留在结论下方（运行中还没有 spec，先走普通工具行）。
				// 正在问的问题由输入框上的提问卡负责，工具记录留在折叠里，不另占一行。
				flushWork();
				turnProcess = undefined;
				workBoundary = "interactive-" + index + ":" + card.id;
				rows.push({ key: "genui-" + index + ":" + card.id, entryId: entry.entryId, content: cachedAssistantItem(entry, cacheScope, "genui:" + card.id, () => (
					<div data-work-kind="interactive" data-tool-id={card.id} data-tool-owner={index}><GenuiToolCardView card={card} /></div>
				)) });
			} else {
				workPendingTools.push(card);
			}
		};
		// 回答段元素按条目身份缓存：settled 与否进键（流式中的最后一条回答每 batch
		// 都是新条目对象，天然缓存未命中）。历史回答不再每 batch 重跑一次 markdown 解析。
		const answerCard = (segmentIndex: number, text: string): React.JSX.Element =>
			cachedAssistantItem(entry, cacheScope, `seg:${segmentIndex}:${index === lastAssistantIndex ? "live" : "settled"}`, () => (
				<GenuiAnswerCard
					key={segmentIndex}
					text={text}
					identity={`msg${index}-seg${segmentIndex}`}
					settled={index !== lastAssistantIndex}
					renderMarkdown={renderAnswerMarkdown}
				/>
			));
		// 同一轮结论的多段正文合成一块，段与段之间不再各占一行、各留一段空隙。
		const answerParts: React.JSX.Element[] = [];
		const pushAnswer = (): void => {
			if (answerParts.length === 0) return;
			const parts = answerParts.splice(0, answerParts.length);
			turnHasAnswer = true;
			for (const process of processes) if (process.turn === turn) process.hasAnswer = true;
			rows.push({
				key: "message-" + index,
				entryId: entry.entryId,
					answer: true,
				content: parts.length === 1 ? parts[0]! : <div className="owl-turn-answer">{parts}</div>,
			});
		};
		segments.forEach((segment, segmentIndex) => {
			if (segment.kind === "tool") {
				const card = entry.tools.find((tool) => tool.id === segment.toolId);
				if (card && !seenTools.has(card.id)) appendTool(card);
				return;
			}
			if (!segment.text.trim()) return;
			if (segment.kind === "thinking") {
				// 思考进折叠区：不再打断工具聚合，也不再占独立整行
				workSteps += 1;
				recordWork(entry, index);
				workRows.push({ key: "think-" + index + "-" + segmentIndex, entryId: entry.entryId, thinking: segment.text, content: <ThinkingRow thinking={segment.text} /> });
				return;
			}
			const followedByTool = segment.phase !== "final_answer" && !segment.text.includes("```owl-ui") && segments.slice(segmentIndex + 1).some((later) => later.kind === "tool");
			if (segment.phase === "commentary" || followedByTool || (!answerEntries.has(index) && !promotedFenceEntries.has(index))) {
				// 公开进展是本轮工作过程的一部分：作为 note 项并进本轮的折叠块，不再自成一行的顶层 row。
				// 原先这里收口并断开 turnProcess，一段说明就把一轮切成多块，
				// 「说明 / 工作过程 / 说明 / 工作过程 / 答案」交替堆叠，读起来像五条消息。
				// note 项在折叠时也保持可见（只有工具行随折叠收起），进展不因折叠而消失。
				// 工具是批量入列的（一次工具组一个 item），先把它落盘，note 才排在它后面：
				// 否则说明会插到本段工具之前，真实顺序就错了。
				flushWorkTools();
				workSteps += 1;
				recordWork(entry, index);
				workRows.push({
					key: "note-" + index + "-" + segmentIndex,
					entryId: entry.entryId,
					note: true,
					content: <div className="owl-work-progress">{answerCard(segmentIndex, segment.text)}</div>,
				});
				return;
			}
			// 工作用时放在正文上面，和 Cursor 的 “Worked for …” 同一位置。
			// finishedAt 必须用 endedAt（message_end 本地时钟）：wire 的 timestamp 是
			// 响应开始时刻，用它会把「生成了 3s」收成「工作了 1s」。
			if (!answerWorkFlushed) {
				answerWorkFlushed = true;
				flushWork(entry.endedAt);
			}
			answerParts.push(answerCard(segmentIndex, segment.text));
		});
		pushAnswer();
		for (const card of entry.tools) if (!seenTools.has(card.id)) appendTool(card);
		if (entry.error) {
			flushWork(entry.endedAt);
			turnProcess = undefined;
			workBoundary = "error-" + index;
			workStartedAt = undefined;
			resumeWorkClock = true;
			rows.push({ key: "error-" + index, entryId: entry.entryId, content: <div className="owl-chat-error" role="alert">{entry.error}</div> });
		} else if (entry.aborted) {
			// 用户暂停：只留一行置灰小字（provider 的中止报错不上屏），继续入口在输入框按钮上。
			flushWork(entry.endedAt);
			turnProcess = undefined;
			workBoundary = "paused-" + index;
			workStartedAt = undefined;
			resumeWorkClock = true;
			rows.push({ key: "paused-" + index, content: <div className="owl-chat-paused">{t("chat.pausedHint")}</div> });
		}
		// 回答底部操作栏：只挂在每轮最终回答上（纯工具调用与中间说明不上屏）。流式中的
		// 进行轮整轮不上屏（等 agent_end 重建后一次性出现，避免中途闪现又消失）。
		// 这里不收口工作过程，让折叠行留在操作栏下面。
		if (
			answerEntries.has(index) &&
			(lastAssistantIndex === -1 || index !== lastAssistantIndex) &&
			!(streaming && lastUserIndex !== -1 && index > lastUserIndex)
		) {
			const row: TimelineRow = {
				key: "footer-" + index,
				compact: true,
				content: assistantFooter(entry, index, false, turnUsage, turnRequestCount, turnRate),
			};
			rows.push(row);
			turnFooters.push({ row, index, entry });
			// 截图不插在正文和操作栏之间，避免把回答切成两截；缩略图跟在操作栏后面。
			if (turnShots.length > 0) {
				const shots = turnShots;
				turnShots = [];
				rows.push({ key: "turn-shots-" + index, quiet: true, content: <TurnScreenshotStrip shots={shots} /> });
			}
		}
		});
	flushWork();
	if (runActive) {
		const active = workSegments.findLast(segment => segment.lastEntryIndex >= activeRunIndex);
		if (active) { active.running = true; active.waiting = !streaming; }
		else if (turnProcess && activeRunIndex < entries.length) {
			const entry = entries[activeRunIndex];
			turnProcess.scopes.push({ id: "scope-active", items: [], steps: 0, failed: 0, running: true, waiting: !streaming, startedAt: entry?.kind === "assistant" ? entry.timestamp : undefined, subagents: [], lastEntryIndex: entries.length - 1 });
		}
	}
	for (const process of processes) {
		process.row.workRunning = process.scopes.some((scope) => scope.running) && process.scopes.some((scope) => scope.items.some((item) => !item.interactive));
		process.row.content = <WorkProcessRow scopes={process.scopes} hasAnswer={process.hasAnswer} onOpenSubagent={onOpenSubagent} searchTarget={searchTarget} />;
	}
	finishTurnFooters();
	flushTurnArtifacts();
	// 重新生成只出现在最后一条回答的操作栏上：对最后一条用户消息整轮「仅回退对话」后重发
		if (lastFooter && canRegenerate && onRegenerate) {
		lastFooter.row.content = assistantFooter(lastFooter.entry, lastFooter.index, true, lastFooter.usage, lastFooter.requestCount, lastFooter.rate);
	}
	return rows;
}

type QuestionMark = { n: number; text: string; preview: string };

function buildQuestions(entries: ChatEntry[]): QuestionMark[] {
	return entries.filter((entry): entry is Extract<ChatEntry, { kind: "user" }> => entry.kind === "user" && !entry.queued).map((entry, index) => {
		const preview = userSourceText(entry.text).trim() || (entry.images?.length
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
			{active > 0 && <span className="owl-chat-minimap-count" aria-hidden="true">{active}/{questions.length}</span>}
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

/**
 * 轮末截图条：本轮 agent 截过的屏幕画面在最终回答之后平铺展示，不用翻
 * 工作过程折叠行找图；点缩略图开灯箱看全图。只收截图类工具（生图类工具的
 * 产物属于会话内容，已在各自卡片里渲染）。
 */
function TurnScreenshotStrip({ shots }: { shots: Array<{ key: string; image: ToolResultImage }> }): React.JSX.Element {
	const t = useT();
	const [zoom, setZoom] = useState<number | null>(null);
	return (
		<div className="owl-turn-shots">
			<div className="flex flex-wrap gap-2">
				{shots.map((shot, index) => (
					<button type="button" key={shot.key} className="owl-image-trigger" aria-label={t("chat.toolScreenshot", { name: "", i: index + 1 })} onClick={() => setZoom(index)}><img
						src={`data:${shot.image.mimeType};base64,${shot.image.data}`}
						alt={t("chat.latestScreenshot")}
						className="h-24 cursor-zoom-in rounded-md border border-owl-border object-contain"
					/></button>
				))}
			</div>
			{zoom !== null && shots[zoom] !== undefined && (
				<ImageViewer images={shots.map((shot) => ({ src: `data:${shot.image.mimeType};base64,${shot.image.data}`, alt: t("chat.fullScreenshot") }))} index={zoom} onIndexChange={setZoom} onClose={() => setZoom(null)} />
			)}
		</div>
	);
}

export function ChatStream({
	entries,
	sessionId,
	profile,
	startReady = true,
	searchTarget,
	deliveryRequest,
	searchHistoryMessage,
	artifacts,
	renderTurnArtifacts,
	cwd,
	onOpenFile,
	onOpenUrl,
	activity = "idle",
	onRewind,
	client,
	onOpenReview,
	onRegenerate,
	onEditMessage,
	onBranch,
	onOpenAutomation,
	onOpenSubagent,
	executionView = "normal",
	onInspectTool,
}: {
	entries: ChatEntry[];
	sessionId?: string;
	profile?: string;
	/** Home statistics only mount after the bridge confirms this account's settings. */
	startReady?: boolean;
	recentSessions?: readonly StartRecentSession[];
	/** Restore an existing conversation without sending a new prompt. */
	onResumeSession?: (id: string) => void;
	searchTarget?: MessageSearchTarget;
	deliveryRequest?: number;
	/** A searched message preceding the compacted transcript; display-only, never a live turn. */
	searchHistoryMessage?: SessionSearchMessageResult;
	activity?: ChatActivity;
	/** 空会话开始页的菜单卡回调（打开工作台对应面板）。 */
	onQuickAction?: (kind: string) => void;
	onPromptExample?: (text: string) => void;
	onOpenDeveloper?: () => void;
	artifacts?: React.ReactNode;
	/** Render each turn's artifacts before the next delivered user message instead of at the session tail. */
	renderTurnArtifacts?: (entries: ChatEntry[]) => React.ReactNode;
	cwd?: string;
	onOpenFile?: (path: string) => void;
	/** 行内 code 芯片里的 http(s) 链接：交给侧边栏浏览器（未传则维持纯文本）。 */
	onOpenUrl?: (url: string) => void;
	/** 用户消息 ↶ 回退（owl-rewind）：传了才渲染按钮，未带 entryId 的行不渲染。 */
	onRewind?: (entryId: string) => void;
	/** 桥客户端：历史轮的改动卡（diffApproval.*）需要；缺省回退旧「成果文件」卡。 */
	client?: BridgeClient;
	/** 历史轮改动卡的「工作台审查」跳转（带聚焦路径）。 */
	onOpenReview?: (focusPath: string) => void;
	/** 回答操作栏的「重新生成」：对最后一条用户消息整轮仅回退对话后重发。 */
	onRegenerate?: () => void;
	/** 用户消息的「编辑重发」：回退到该条消息（仅对话）后发送新文本。 */
	onEditMessage?: (entryId: string, text: string, images?: ToolResultImage[]) => boolean | void | Promise<boolean | void>;
	/** 回答操作栏的「在新对话中分支」：以该条回答为末梢复制新会话并切换。 */
	onBranch?: (entryId: string) => void;
	/** 会话内任务卡的「任务页」跳转（自动化任务 Rail 视图）。 */
	onOpenAutomation?: () => void;
	/** Open the delegated run without resuming or mutating its child session. */
	onOpenSubagent?: (card: ToolCard) => void;
	/** Changes execution presentation without changing the active run. */
	executionView?: ExecutionView;
	/** Open the original tool input/output in the workspace. */
	onInspectTool?: (card: ToolCard, ownerIndex?: number) => void;
}): React.JSX.Element {
	const t = useT();
	const container = useRef<HTMLElement>(null);
	const receiptScope = JSON.stringify([profile, sessionId, cwd]);
	const workPresentation = useMemo<WorkPresentation>(() => ({ processes: new Map(), tools: new Map(), outputs: new Map(), thoughts: new Map() }), [receiptScope]);
	// App 每次渲染都会传新的回调引用；经 ref 委托转成稳定身份，行内容缓存与 rows
	// memo 才不会被无关的 App 重渲染打断。语义不变：调用时取最新闭包。
	const onRewindRef = useRef(onRewind);
	onRewindRef.current = onRewind;
	const onEditMessageRef = useRef(onEditMessage);
	onEditMessageRef.current = onEditMessage;
	const onOpenSubagentRef = useRef(onOpenSubagent);
	onOpenSubagentRef.current = onOpenSubagent;
	const onOpenFileRef = useRef(onOpenFile);
	onOpenFileRef.current = onOpenFile;
	const onOpenReviewRef = useRef(onOpenReview);
	onOpenReviewRef.current = onOpenReview;
	const onRegenerateRef = useRef(onRegenerate);
	onRegenerateRef.current = onRegenerate;
	const onBranchRef = useRef(onBranch);
	onBranchRef.current = onBranch;
	const onOpenAutomationRef = useRef(onOpenAutomation);
	onOpenAutomationRef.current = onOpenAutomation;
	const onInspectToolRef = useRef(onInspectTool);
	onInspectToolRef.current = onInspectTool;
	const hasRewind = onRewind !== undefined;
	const hasEditMessage = onEditMessage !== undefined;
	const hasOpenSubagent = onOpenSubagent !== undefined;
	const hasOpenFile = onOpenFile !== undefined;
	const hasOpenReview = onOpenReview !== undefined;
	const hasRegenerate = onRegenerate !== undefined;
	const hasBranch = onBranch !== undefined;
	const hasOpenAutomation = onOpenAutomation !== undefined;
	const hasInspectTool = onInspectTool !== undefined;
	const rewindStable = useMemo(() => (hasRewind ? (entryId: string): void => onRewindRef.current?.(entryId) : undefined), [hasRewind]);
	const editMessageStable = useMemo(() => (hasEditMessage ? (entryId: string, text: string, images?: ToolResultImage[]): boolean | void | Promise<boolean | void> => onEditMessageRef.current?.(entryId, text, images) : undefined), [hasEditMessage]);
	const openSubagentStable = useMemo(() => (hasOpenSubagent ? (card: ToolCard): void => onOpenSubagentRef.current?.(card) : undefined), [hasOpenSubagent]);
	const openFileStable = useMemo(() => (hasOpenFile ? (path: string): void => onOpenFileRef.current?.(path) : undefined), [hasOpenFile]);
	const openReviewStable = useMemo(() => (hasOpenReview ? (focusPath: string): void => onOpenReviewRef.current?.(focusPath) : undefined), [hasOpenReview]);
	const regenerateStable = useMemo(() => (hasRegenerate ? (): void => onRegenerateRef.current?.() : undefined), [hasRegenerate]);
	const branchStable = useMemo(() => (hasBranch ? (entryId: string): void => onBranchRef.current?.(entryId) : undefined), [hasBranch]);
	const openAutomationStable = useMemo(() => (hasOpenAutomation ? (): void => onOpenAutomationRef.current?.() : undefined), [hasOpenAutomation]);
	const inspectToolStable = useMemo(() => (hasInspectTool ? (card: ToolCard, ownerIndex?: number): void => onInspectToolRef.current?.(card, ownerIndex) : undefined), [hasInspectTool]);
	const executionPresentation = useMemo(() => ({ view: executionView, onInspectTool: inspectToolStable }), [executionView, inspectToolStable]);
	// 行内容缓存域（profile/session/cwd/客户端）+ 跨条目工具批次缓存：换会话整体作废。
	const cacheScope = `${receiptScope}:${clientStampOf(client)}`;
	const batchItemCache = useRef<{ scope: string; items: Map<string, BatchItem> }>({ scope: "", items: new Map() });
	if (batchItemCache.current.scope !== cacheScope) batchItemCache.current = { scope: cacheScope, items: new Map() };
	const batchItems = batchItemCache.current.items;
	const receiptSequence = useRef(0);
	const [requestedReceipt, setRequestedReceipt] = useState<{ scope: string; toolId: string; ownerIndex?: number; requestId: number }>();
	const receiptTarget = requestedReceipt?.scope === receiptScope ? requestedReceipt : undefined;
	const onLocateAttachment = useCallback((toolId: string, ownerIndex?: number) => setRequestedReceipt({ scope: receiptScope, toolId, ownerIndex, requestId: ++receiptSequence.current }), [receiptScope]);
	const handledReceipt = useRef<number | undefined>(undefined);
	// 跟随新内容滚动的开关。用户的向上滚动意图（滚轮/触控板/拖滚动条/翻页键）立即关闭，
	// 只有视口真正回到贴底位置才重新打开——流式输出期间翻历史不会被拽回底部。
	const stick = useRef(!sessionId);
	const readingProcess = useRef(false);
	const explicitScroll = useRef(false);
	const workReadAnchor = useRef<{ element: HTMLElement; top: number; toolId?: string; owner?: string } | undefined>(undefined);
	const navigationTarget = useRef<number | null>(null);
	const prevEntries = useRef<ChatEntry[]>([]);
	const [showLatest, setShowLatest] = useState(false);
	const latestChip = useRef<HTMLButtonElement>(null);
	// 上一帧的滚动度量。用来区分「人往上翻」和「流式内容把页面撑高」。
	const scrollMetrics = useRef({ top: 0, height: 0 });
	const pinning = useRef(false);
	const pinToBottom = (el: HTMLElement): void => {
		const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
		if (Math.abs(el.scrollTop - bottom) > 1) {
			pinning.current = true;
			el.scrollTop = bottom;
			pinning.current = false;
		}
		scrollMetrics.current = { top: el.scrollTop, height: el.scrollHeight };
	};
	// 离开底部超过 48px 才挂上按钮，回到 24px 内才摘掉。阈值之间保持原状，
	// 避免流式增高在贴底线附近把「有新进展」一帧挂上、下一帧摘掉。
	const publishLatest = (el: HTMLElement): void => {
		const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
		setShowLatest((shown) => (stick.current || gap < 24 ? false : shown || gap >= 48));
	};
	const handledSearch = useRef<string | undefined>(undefined);
	const handledDelivery = useRef<number | undefined>(undefined);
	const activeSearch = searchTarget?.sessionId === sessionId ? searchTarget : undefined;
	const searchRequest = activeSearch ? JSON.stringify([sessionId, activeSearch.entryId, activeSearch.requestId]) : undefined;
	const historyMessage = activeSearch && searchHistoryMessage?.entryId === activeSearch.entryId
		&& !entries.some((entry) => (entry.kind === "user" || entry.kind === "assistant") && entry.entryId === activeSearch.entryId)
		? searchHistoryMessage : undefined;
	const historyText = historyMessage ? typeof historyMessage.message.content === "string" ? historyMessage.message.content : historyMessage.message.content.map((block) => block.text).join("\n") : "";
	const historyLabel = getUiLanguage() === "en" ? "Earlier message" : "较早的历史消息";
	const isStartPage = entries.length === 0 && !activeSearch && !historyMessage;

	useLayoutEffect(() => {
		stick.current = !sessionId;
		readingProcess.current = false;
		workReadAnchor.current = undefined;
		navigationTarget.current = null;
		scrollMetrics.current = { top: 0, height: 0 };
		handledSearch.current = undefined;
		prevEntries.current = entries;
		container.current?.removeAttribute("data-owl-search-navigation");
		if (sessionId) container.current?.setAttribute("data-owl-scroll-restoring", "true");
		else container.current?.removeAttribute("data-owl-scroll-restoring");
	}, [profile, sessionId, cwd]);
	useLayoutEffect(() => {
		if (!searchRequest || handledSearch.current === searchRequest) return;
		stick.current = false;
		container.current?.removeAttribute("data-owl-search-navigation");
	}, [searchRequest]);
	useLayoutEffect(() => {
		const el = container.current;
		if (!el) return;
		if (!isStartPage) {
			if (el.dataset.owlSearchNavigation === "start") el.removeAttribute("data-owl-search-navigation");
			return;
		}
		stick.current = false;
		navigationTarget.current = null;
		setShowLatest(false);
		el.scrollTop = 0;
		// The home page owns its initial top position, including workspace-memory restoration.
		el.dataset.owlSearchNavigation = "start";
		el.removeAttribute("data-owl-scroll-restoring");
		el.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
	}, [isStartPage, profile, sessionId, cwd]);

	const onWheel = (event: React.WheelEvent<HTMLElement>): void => {
		navigationTarget.current = null;
		explicitScroll.current = true;
		// 向上滚（deltaY<0）是明确的用户意图，先于滚动发生：直接停跟随。
		// 触控板/高精度滚轮单次位移很小，靠位移阈值判断会漏，必须在 wheel 上拦。
		if (event.deltaY < 0) stick.current = false;
	};

	useEffect(() => {
		const last = entries[entries.length - 1];
		const prevLast = prevEntries.current[prevEntries.current.length - 1];
		const userJustSent = last?.kind === "user" && !last.queued && entries.length > prevEntries.current.length && last !== prevLast;
		prevEntries.current = entries;
		if (isStartPage) return;
		const el = container.current;
		// 用户刚发出的消息优先于尚未完成的位置恢复，否则往上翻过后发送会停在原处。
		if (userJustSent) {
			stick.current = true;
			readingProcess.current = false;
			workReadAnchor.current = undefined;
			el?.removeAttribute("data-owl-scroll-restoring");
		}
		if (!userJustSent && (el?.dataset.owlScrollRestoring === "true" || (searchRequest && handledSearch.current !== searchRequest))) return;
		if (!stick.current && !userJustSent) return;
		// 直接设 scrollTop：瞬时定位，不与用户滚动抢平滑动画队列。
		if (el) {
			pinToBottom(el);
			publishLatest(el);
		}
	}, [entries, isStartPage]);

	// 用户翻在上面时，新工具行到达让「回到最新」按钮轻点一下（一次性位移，不常驻动画）。
	useEffect(() => {
		const el = container.current;
		if (!el) return;
		const nudge = (): void => {
			const chip = latestChip.current;
			if (!chip || typeof chip.animate !== "function") return;
			chip.animate(
				[
					{ transform: "translateX(-50%) scale(1)" },
					{ transform: "translateX(-50%) scale(1.07)" },
					{ transform: "translateX(-50%) scale(1)" },
				],
				{ duration: 420, easing: "ease-out" },
			);
		};
		el.addEventListener("owl-work-new-activity", nudge);
		return () => el.removeEventListener("owl-work-new-activity", nudge);
	}, []);

	const [expandedTools, setExpandedTools] = useState(() => document.documentElement.dataset.owlToolRecords === "expanded");
	useEffect(() => {
		const update = (): void => setExpandedTools(document.documentElement.dataset.owlToolRecords === "expanded");
		update();
		window.addEventListener("owl-chat-appearance-change", update);
		return () => window.removeEventListener("owl-chat-appearance-change", update);
	}, []);
	const turnCard = useMemo(() => {
		if (cwd === undefined || client === undefined || openReviewStable === undefined) return undefined;
		return (turnArtifacts: FileArtifact[]): React.JSX.Element | null => (
			<TurnArtifacts artifacts={turnArtifacts} cwd={cwd} client={client} sessionId={sessionId} disabled={activity !== "idle"} onOpenFile={openFileStable ?? (() => undefined)} onOpenReview={openReviewStable} />
		);
	}, [cwd, client, sessionId, activity, openFileStable, openReviewStable]);
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
				sessionId,
				onLocateAttachment,
				searchTarget: activeSearch,
				expandedTools,
				onRewind: rewindStable,
				cwd,
				onOpenFile: openFileStable,
				turnCard,
				renderTurnArtifacts,
				streaming: activity === "working",
				runActive: activity === "working" || activity === "waiting",
				canRegenerate,
				onRegenerate: regenerateStable,
				onEditMessage: editMessageStable,
				onBranch: branchStable,
				onOpenAutomation: openAutomationStable,
				onOpenSubagent: openSubagentStable,
				client,
				busy,
				cacheScope,
				batchItems,
			}),
		[entries, sessionId, onLocateAttachment, activeSearch, expandedTools, rewindStable, cwd, openFileStable, turnCard, renderTurnArtifacts, activity, canRegenerate, regenerateStable, editMessageStable, branchStable, openAutomationStable, openSubagentStable, client, busy, cacheScope, batchItems],
	);
	const rememberWorkReading = (): void => {
		const el = container.current;
		if (!el || !readingProcess.current) return;
		if (workReadAnchor.current && !workReadAnchor.current.element.isConnected) return;
		const bounds = el.getBoundingClientRect();
		const anchor = [...el.querySelectorAll<HTMLElement>(".owl-work-process-body .owl-tool-row, .owl-work-process-body pre")].find((node) => {
			const rect = node.getBoundingClientRect();
			return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom;
		});
		if (anchor) {
			const tool = anchor.closest<HTMLElement>("[data-tool-id]");
			workReadAnchor.current = { element: anchor, top: anchor.getBoundingClientRect().top, toolId: tool?.dataset.toolId, owner: tool?.dataset.toolOwner };
		}
	};
	const restoreWorkReading = (): void => {
		const el = container.current;
		const anchor = workReadAnchor.current;
		if (!el || stick.current || !readingProcess.current || el.dataset.owlScrollRestoring === "true" || activeSearch) return;
		const target = anchor?.element.isConnected ? anchor.element : anchor?.toolId ? [...el.querySelectorAll<HTMLElement>("[data-tool-id]")].find((node) => node.dataset.toolId === anchor.toolId && node.dataset.toolOwner === anchor.owner) : undefined;
		if (anchor && target) {
			const delta = target.getBoundingClientRect().top - anchor.top;
			if (Number.isFinite(delta) && Math.abs(delta) > 0.5) el.scrollTop += delta;
			workReadAnchor.current = { ...anchor, element: target, top: target.getBoundingClientRect().top };
		}
		rememberWorkReading();
	};
	useLayoutEffect(() => {
		const el = container.current;
		if (!el || stick.current || !readingProcess.current) return;
		restoreWorkReading();
		// 锚定阅读位置会改 scrollTop，先记成当前帧，避免被当成用户往上翻。
		scrollMetrics.current = { top: el.scrollTop, height: el.scrollHeight };
		publishLatest(el);
	}, [rows]);
	useEffect(() => {
		const el = container.current;
		if (!el || !receiptTarget || handledReceipt.current === receiptTarget.requestId) return;
		let frame = 0; let attempts = 0; let target: HTMLElement | undefined;
		const locate = (): void => {
			target = [...el.querySelectorAll<HTMLElement>("[data-tool-id]")].find((node) => node.dataset.toolId === receiptTarget.toolId && node.dataset.toolOwner === String(receiptTarget.ownerIndex));
			if (!target) { if (++attempts < 4) frame = requestAnimationFrame(locate); return; }
			handledReceipt.current = receiptTarget.requestId;
			stick.current = false; navigationTarget.current = null;
			el.removeAttribute("data-owl-scroll-restoring");
			el.dataset.owlSearchNavigation = `attachment-${receiptTarget.requestId}`;
			target.dataset.attachmentTarget = "true";
			el.scrollTo({ top: messageScrollTop(el, target), behavior: "instant" });
			el.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
		};
		frame = requestAnimationFrame(locate);
		return () => { cancelAnimationFrame(frame); target?.removeAttribute("data-attachment-target"); };
	}, [receiptTarget, rows]);

	useEffect(() => {
		const el = container.current;
		if (!el || !activeSearch || !searchRequest) return;
		let clearHighlight = (): void => undefined;
		let target: HTMLElement | undefined;
		const frame = requestAnimationFrame(() => {
			target = messageElement(el, activeSearch.entryId, activeSearch.query);
			if (!target) return;
			target.dataset.searchMatch = "true";
			clearHighlight = highlightMessageMatches(target, activeSearch.query);
			if (handledSearch.current === searchRequest) return;
			handledSearch.current = searchRequest;
			stick.current = false;
			navigationTarget.current = null;
			// Workspace memory owns scroll persistence. Explicit search cancels its old reading position.
			el.dataset.owlSearchNavigation = String(activeSearch.requestId);
			el.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
			el.removeAttribute("data-owl-scroll-restoring");
			el.scrollTo({ top: messageScrollTop(el, target), behavior: "instant" });
			el.dispatchEvent(new Event("scroll"));
		});
		return () => {
			cancelAnimationFrame(frame);
			clearHighlight();
			target?.removeAttribute("data-search-match");
		};
	}, [rows, activeSearch, searchRequest, historyMessage]);

	useEffect(() => {
		const el = container.current;
		if (!el || deliveryRequest === undefined || handledDelivery.current === deliveryRequest || activity !== "idle" || activeSearch || entries.length === 0) return;
		const frame = requestAnimationFrame(() => {
			const lastUser = entries.findLast((entry) => entry.kind === "user" && !entry.queued);
			const target = [...el.querySelectorAll<HTMLElement>(".owl-delivery-summary")].findLast((node) => node.closest<HTMLElement>("[data-delivery-turn]")?.dataset.deliveryTurn === (lastUser?.kind === "user" ? lastUser.entryId : undefined));
			handledDelivery.current = deliveryRequest;
			stick.current = false;
			navigationTarget.current = null;
			el.dataset.owlSearchNavigation = `delivery-${deliveryRequest}`;
			el.removeAttribute("data-owl-scroll-restoring");
			el.scrollTo({ top: target ? messageScrollTop(el, target) : Math.max(0, el.scrollHeight - el.clientHeight), behavior: "instant" });
			el.dispatchEvent(new Event("owl-chat-search-navigation", { bubbles: true }));
			el.dispatchEvent(new Event("scroll"));
		});
		return () => cancelAnimationFrame(frame);
	}, [deliveryRequest, activity, entries, rows, activeSearch]);

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
		const landingGap = maxTop - top;
		navigationTarget.current = Math.abs(el.scrollTop - top) > 1 ? top : null;
		if (navigationTarget.current === null) stick.current = landingGap < 24;
		scrollMetrics.current = { top, height: el.scrollHeight };
		el.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
		setShowLatest((shown) => (stick.current || landingGap < 24 ? false : shown || landingGap >= 48));
	};

	// 会话切换/恢复后立即校准高亮，不等首次滚动
	useEffect(() => {
		updateActiveQuestion();
	}, [questions, searchRequest]); // eslint-disable-line react-hooks/exhaustive-deps

	const onScrollWithTracking = (): void => {
		const el = container.current;
		if (!el) return;
		if (isStartPage) {
			stick.current = false;
			setShowLatest(false);
			return;
		}
		if (el.dataset.owlScrollRestoring === "true" || pinning.current) return;
		// 平滑跳转第一帧仍靠近底部，抵达目标前不能重新开启贴底跟随。
		let navigationArrived = false;
		if (navigationTarget.current !== null) {
			if (Math.abs(el.scrollTop - navigationTarget.current) > 1) return;
			navigationTarget.current = null;
			scrollMetrics.current = { top: el.scrollTop, height: el.scrollHeight };
			navigationArrived = true;
		}
		const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
		const heightDelta = el.scrollHeight - scrollMetrics.current.height;
		const topDelta = el.scrollTop - scrollMetrics.current.top;
		// 只有视口真的往上走（滚动条、滚轮、键盘）才停跟随。内容变高时 scrollHeight 增大，
		// 不能当成用户离开，否则跟随中的每一段输出都会把「有新进展」点亮再熄灭。
		const movedUp = topDelta < -1 && heightDelta > -1;
		if (navigationArrived && gap < 24 && !(readingProcess.current && !explicitScroll.current)) {
			stick.current = true;
			readingProcess.current = false;
			workReadAnchor.current = undefined;
			pinToBottom(el);
		} else if (movedUp) stick.current = false;
		else if (readingProcess.current && !explicitScroll.current) stick.current = false;
		else if (stick.current) pinToBottom(el);
		else if (gap < 4 || (explicitScroll.current && gap < 24)) {
			stick.current = true;
			readingProcess.current = false;
			workReadAnchor.current = undefined;
			pinToBottom(el);
		}
		if (stick.current) { readingProcess.current = false; workReadAnchor.current = undefined; }
		explicitScroll.current = false;
		publishLatest(el);
		scrollMetrics.current = { top: el.scrollTop, height: el.scrollHeight };
		rememberWorkReading();
		updateActiveQuestion();
	};

	useEffect(() => {
		const el = container.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			if (isStartPage) return;
			if (el.clientHeight === 0 || el.clientWidth === 0) return;
			if (el.dataset.owlScrollRestoring === "true" || (searchRequest && handledSearch.current !== searchRequest)) return;
			restoreWorkReading();
			// 提问卡展开或收起会改变聊天视口：贴底时跟随，翻历史或导航时保留位置。
			// 跟随中的增高在这里一次性钉到底，不把「暂时离开 24px」交给按钮状态。
			if (stick.current && navigationTarget.current === null && !readingProcess.current) pinToBottom(el);
			onScrollWithTracking();
		});
		observer.observe(el);
		// 内容列也要观察：面板/卡片异步加载改变内容高度时容器自身并不 resize，
		// 不补这个观察，「回到最新」会停在内容变化前的过期状态（如空态面板加载完
		// 成后按钮误显示并盖住面板底部）。
		const content = el.firstElementChild;
		if (content) observer.observe(content);
		return () => observer.disconnect();
	}, [questions, searchRequest, isStartPage]); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<AttachmentToolContext.Provider value={receiptTarget}>
		<WorkPresentationContext.Provider value={workPresentation}>
		<ExecutionViewContext.Provider value={executionPresentation}>
		<div className="owl-chat-surface" data-activity={activity} data-execution-view={executionView}>
			{questions.length > 0 && <QuestionMinimap questions={questions} active={activeQuestion} onJump={jumpToQuestion} />}
			<div className="owl-chat-layout">
				<main ref={container} onWheel={onWheel} onScroll={onScrollWithTracking} onScrollEnd={() => { navigationTarget.current = null; onScrollWithTracking(); }} onPointerDown={() => { navigationTarget.current = null; }} onTouchStart={() => { navigationTarget.current = null; }} onKeyDown={() => { navigationTarget.current = null; }} className="owl-chat-scroll" aria-label={t("chat.messagesAria")} onClickCapture={(event) => {
					if (!(event.target instanceof Element)) return;
					const control = event.target.closest<HTMLButtonElement>(".owl-answer-reading [data-answer-toolbar] button[data-answer-action]");
					const processControl = event.target.closest(".owl-work-process button[aria-expanded], .owl-work-process summary, .owl-work-process [data-work-reading]");
					if ((control?.dataset.answerAction === "expand-code" && control.closest("[data-answer-code]")) || (control?.dataset.answerAction === "expand-table" && control.closest("[data-answer-table]")) || processControl) {
						stick.current = false;
						navigationTarget.current = null;
						if (processControl) { readingProcess.current = true; rememberWorkReading(); }
					}
				}} onClick={(event) => {
					if (!(event.target instanceof Element)) return;
					const anchor = event.target.closest<HTMLAnchorElement>(".owl-answer a[href]");
					const href = anchor?.getAttribute("href");
					// 任何非锚点链接都不能走 <a> 默认行为：那会把整个主窗口导航走，且没有返回入口。
					if (href && !href.startsWith("#")) {
						event.preventDefault();
						if (/^https?:\/\//i.test(href)) {
							onOpenUrl?.(href);
							return;
						}
						if (href.startsWith("//")) {
							onOpenUrl?.(`https:${href}`);
							return;
						}
						if (cwd && onOpenFile && (!/^[a-z][a-z\d+.-]*:/i.test(href) || /^file:\/\//i.test(href))) {
							const target = href.split("#")[0].replace(/(?::\d+)+$/, "");
							const linked = workspaceArtifactPath(target, cwd, { encoded: true });
							if (linked) onOpenFile(linked);
						}
						return;
					}
					// 行内 code 芯片（反引号包的路径/链接）：解析成工作区路径交给
					// onOpenFile（HTML 由 App 落到侧边栏浏览器）；解析不了（工作区外、
					// 纯命令词）就维持纯文本。代码块（pre>code）与链接内芯片不抢。
					const code = event.target.closest<HTMLElement>("code");
					if (!code || code.closest("pre") || code.closest("a")) return;
					// 有选区（拖选/双击选词）说明用户在复制：点击不开文件
					const selection = window.getSelection();
					if (selection && selection.toString().trim() !== "") return;
					const candidate = pathCandidateFromCode(code.textContent ?? "");
					if (!candidate) return;
					if (cwd && onOpenFile) {
						const path = workspaceArtifactPath(candidate, cwd);
						if (path) {
							event.preventDefault();
							onOpenFile(path);
							return;
						}
					}
					if (/^https?:\/\//i.test(candidate) && onOpenUrl) {
						event.preventDefault();
						onOpenUrl(candidate);
					}
				}}>
					<div className="owl-chat-column">
						{historyMessage && <section className="owl-chat-history-message" data-entry-id={historyMessage.entryId} data-owl-search-history="true" data-history-role={historyMessage.message.role} aria-label={historyLabel}>
							<p className="owl-chat-history-message-label">{historyLabel} · {historyMessage.message.role === "user" ? getUiLanguage() === "en" ? "You" : "你" : "Owl"}</p>
							{historyMessage.message.role === "assistant" ? <MarkdownAnswer html={renderAnswerMarkdown(historyText)} /> : <div className="owl-chat-history-message-user">{historyText}</div>}
						</section>}
						{isStartPage && <StartPage client={startReady ? client : undefined} profile={startReady ? profile : undefined} />}
						{rows.map((row) => <div key={row.key} data-entry-id={row.entryId} data-qidx={row.questionIndex} data-delivery-turn={row.deliveryTurn} data-owl-answer={row.answer ? "true" : undefined} className={row.questionIndex ? "owl-chat-question" : row.quiet ? "owl-chat-row owl-chat-row-quiet" : row.compact ? "owl-chat-row owl-chat-row-compact" : "owl-chat-row"}>{row.content}</div>)}
						{artifacts != null && <div className="owl-chat-row owl-chat-row-quiet">{artifacts}</div>}
					</div>
				</main>
			</div>
			{showLatest && !isStartPage && <button ref={latestChip} className="owl-chat-latest" type="button" onClick={() => {
				navigationTarget.current = null;
				const el = container.current;
				const answer = activity === "idle" && readingProcess.current ? [...(el?.querySelectorAll<HTMLElement>('[data-owl-answer="true"]') ?? [])].at(-1) : undefined;
				readingProcess.current = false;
				workReadAnchor.current = undefined;
				stick.current = !answer;
				if (el) el.scrollTop = answer ? messageScrollTop(el, answer) : el.scrollHeight;
				setShowLatest(false);
			}}>{activity === "idle" && readingProcess.current && rows.findLastIndex((row) => row.answer) > rows.findLastIndex((row) => row.questionIndex) ? workProcessText("answerReady") + " · " + workProcessText("viewAnswer") : activity === "working" ? workProcessText("latestUpdate") + " · " + t("chat.backToLatest") : t("chat.backToLatest")} <span aria-hidden="true">↓</span></button>}
		</div>
		</ExecutionViewContext.Provider>
		</WorkPresentationContext.Provider>
		</AttachmentToolContext.Provider>
	);
}
