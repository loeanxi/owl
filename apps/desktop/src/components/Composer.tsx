import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { BridgeClient } from "../bridge/client.ts";
import type { AgentPresetDefinition, ApprovalMode, FsSearchHit, ProviderModelsMessage, SessionStatsResult, SlashCommandEntry } from "../bridge/protocol.ts";
import { getUiLanguage, t, useT, type TextKey } from "../i18n/index.ts";
import { Menu } from "./Menu.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { samePath } from "../utils/paths.ts";
import { getProjectDisplayName, isProjectHidden, restoreProject, setProjectAlias, useProjectSidebarRevision } from "../project-sidebar-model.ts";
import { listenForOsFileDrop, readLocalImage } from "../bridge/native.ts";
import { extractPlainText } from "./AttachedFileChip.tsx";
import { ComposerMaterials } from "./ComposerMaterials.tsx";
import type { ModelSelectionFeedback } from "../hooks/use-model-selection.ts";
import { ModelSelectionNotice } from "./ModelSelectionNotice.tsx";
import { usePromptSuggestion } from "../hooks/use-prompt-suggestion.ts";
import { checkAttachmentPaths, type AttachmentIssue } from "../hooks/attachment-preflight.ts";
import { AttachmentPreflightNotice } from "./AttachmentPreflightNotice.tsx";
import { classifyHtmlDrop, dropPointHits, fileBasename, imageMimeOfName, splitDroppedPaths } from "./composer-drop.ts";
import { PresetAvatar } from "./agent-preset-meta.tsx";
import { OwlMascot, type OwlPose } from "./OwlMascot.tsx";
import { useComposerPredictionText } from "./composer-prediction-copy.ts";
import { useExecutionText } from "./execution-copy.ts";
import { useComposerMotion, type ComposerSendMotion } from "./use-composer-motion.ts";
import "./composer-responsive.css";
import "./composer-prediction.css";
import "./composer-motion.css";
import { ImageViewer } from "./ImageViewer.tsx";

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const THINKING_LABELS: Record<string, TextKey> = {
	off: "composer.thinking.off",
	minimal: "composer.thinking.minimal",
	low: "composer.thinking.low",
	medium: "composer.thinking.medium",
	high: "composer.thinking.high",
	xhigh: "composer.thinking.xhigh",
	max: "composer.thinking.max",
};

/** 审批模式三档：标准（逐次确认）/ 计划（只读工具做调研）/ 自动（全自动）。 */
const APPROVAL_MODES: { value: ApprovalMode; labelKey: TextKey; titleKey: TextKey }[] = [
	{ value: "confirm", labelKey: "composer.mode.confirm.label", titleKey: "composer.mode.confirm.title" },
	{ value: "plan", labelKey: "composer.mode.plan.label", titleKey: "composer.mode.plan.title" },
	{ value: "auto", labelKey: "composer.mode.auto.label", titleKey: "composer.mode.auto.title" },
];

/** 预设视觉身份（配色/徽字）在 agent-preset-meta 与侧栏、设置页共用。 */

/** 审批模式小图标：线性风格，标准模式使用原型的盾形勾。 */
function ModeIcon({ mode, active }: { mode: ApprovalMode; active: boolean }): React.JSX.Element {
	const tone = active ? "text-owl-accent" : "text-owl-faint";
	if (mode === "plan") {
		// 罗盘：调研与规划
		return (
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
				<circle cx="8" cy="8" r="6.2" />
				<path d="M10.6 5.4 9.1 9.1 5.4 10.6 6.9 6.9l3.7-1.5Z" />
			</svg>
		);
	}
	if (mode === "auto") {
		// 闪电：全自动
		return (
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
				<path d="M8.8 1.5 3.8 9h3l-.6 5.5L11.2 7h-3l.6-5.5Z" />
			</svg>
		);
	}
	// 盾形勾：标准（逐次把关）
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
			<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z" />
			<path d="m8 12 3 3 5-6" />
		</svg>
	);
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(value);
}

function contextTone(percent: number | null): string {
	if (percent === null) return "text-owl-faint";
	if (percent >= 85) return "text-owl-danger";
	if (percent >= 60) return "text-owl-warning";
	return "text-owl-muted";
}

/** 上下文占用小圆环：弧长 = 占用比例，颜色跟随按钮文字色（平时中性，将满转警示）。 */
function ContextRing({ percent }: { percent: number | null }): React.JSX.Element {
	const level = Math.min(100, Math.max(0, percent ?? 0));
	return (
		<svg viewBox="0 0 16 16" className="owl-context-ring" aria-hidden="true">
			<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
			{level > 0 && <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength={100} strokeDasharray={`${level} 100`} transform="rotate(-90 8 8)" />}
		</svg>
	);
}

/** 上下文用量鱼缸：铺在输入框底层，液面高度 = 上下文占用比例。 */
function ContextTank({ percent }: { percent: number | null }): React.JSX.Element | null {
	if (percent === null) return null;
	const level = Math.min(100, Math.max(0, percent));
	const tone = level >= 85 ? "danger" : level >= 60 ? "warn" : "normal";
	const levelText = tone === "danger" ? t("context.levelDanger", { n: level }) : tone === "warn" ? t("context.levelWarn", { n: level }) : t("context.level", { n: level });
	return (
		<div
			className="owl-context-tank"
			data-tone={tone}
			role="meter"
			aria-valuenow={level}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuetext={levelText}
			title={`${levelText}
${t("context.levelHint")}`}
		>
			<div className="owl-context-tank__liquid" style={{ height: `${level}%` }}>
				<svg className="owl-context-tank__wave" viewBox="0 0 120 8" preserveAspectRatio="none">
					<path d="M0 4 Q15 0 30 4 T60 4 T90 4 T120 4 V8 H0 Z" />
				</svg>
			</div>
		</div>
	);
}

/** 终端：本地运行环境。 */
function LocalEnvironmentIcon({ tone = "text-owl-faint" }: { tone?: string }): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
			<path d="m4 6 5 6-5 6M12 18h8" />
		</svg>
	);
}

/** 云朵：远程会话（占位项）。 */
function CloudIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0">
			<path d="M4.6 12h6.6a2.7 2.7 0 0 0 .5-5.35 3.7 3.7 0 0 0-7.25.75A2.6 2.6 0 0 0 4.6 12Z" />
		</svg>
	);
}

/** 文件夹加号：新建/打开项目目录（对照 Claude 输入框的 folder-plus chip）。 */
function FolderPlusIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0">
			<path d="M3 6h6l2 3h10v11H3Z" />
			<path d="M12 12v5M9.5 14.5h5" />
		</svg>
	);
}

/** 空心文件夹：项目 chip 与项目菜单项。 */
function FolderIcon({ tone = "text-owl-faint" }: { tone?: string }): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
			<path d="M3 6h6l2 3h10v11H3Z" />
		</svg>
	);
}

type ComposerAction = "send" | "pause" | "abort" | "resume";

function ComposerActionIcon({ action }: { action: ComposerAction }): React.JSX.Element {
	const send = action === "send";
	return (
		<span className="owl-composer-action-stage" aria-hidden="true">
			<svg viewBox="0 0 16 16" data-shown={send || undefined} className="owl-composer-action-glyph is-stroke">
				<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
			</svg>
			<svg viewBox="0 0 12 12" data-shown={action === "pause" || undefined} className="owl-composer-action-glyph is-fill">
				<rect x="2.4" y="1.8" width="2.8" height="8.4" rx="1" />
				<rect x="6.8" y="1.8" width="2.8" height="8.4" rx="1" />
			</svg>
			<svg viewBox="0 0 12 12" data-shown={action === "abort" || undefined} className="owl-composer-action-glyph is-fill">
				<rect x="2" y="2" width="8" height="8" rx="1" />
			</svg>
			<svg viewBox="0 0 12 12" data-shown={action === "resume" || undefined} className="owl-composer-action-glyph is-fill">
				<path d="M4 2.7v6.6c0 .4.45.65.79.42l5.1-3.3a.5.5 0 0 0 0-.84L4.79 2.28A.5.5 0 0 0 4 2.7Z" />
			</svg>
		</span>
	);
}

function Chevron(): React.JSX.Element {
	return (
			<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3 text-owl-faint">
				<path d="M2.5 4.5L6 8l3.5-3.5" />
			</svg>
		);
}

/**
 * 输入框顶部环境 chip（Claude 同款布局）：填充式小圆角，无边框。
 * 运行位置 / 项目 / 添加项目。
 */
const envChipClass =
	"owl-composer-env-chip flex h-6 items-center gap-1 whitespace-nowrap rounded-md bg-owl-hover/40 px-2 text-xs text-owl-muted " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-not-allowed disabled:opacity-40";

/** 环境行的纯图标 chip（添加项目）。 */
const envIconButtonClass =
	"flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-owl-hover/40 text-owl-muted " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text";

/**
 * 输入框底部选择器（精简 ghost 风）：无边框按钮，悬停才浮出底色。
 * 左侧预设/审批模式在宽列显示名称，窄列收为图标；右侧模型+思考强度带文字。
 */
const ghostPillClass =
	"owl-composer-choice flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs text-owl-faint " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

const menuItemClass = "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-owl-hover";

function modelDisplayName(providers: ProviderModelsMessage[], model: string, fallback: string): string {
	const slash = model.indexOf("/");
	const providerId = slash > 0 ? model.slice(0, slash) : undefined;
	const modelId = slash > 0 ? model.slice(slash + 1) : undefined;
	return providers.find((provider) => provider.id === providerId)?.models.find((entry) => entry.id === modelId)?.name ?? (modelId || fallback);
}

/**
 * 模型选择菜单（模型 + 思考强度一体）：触发器把当前强度挂在模型名后方；面板里
 * 悬停推理模型行时，强度选项以浮层挂在行的右侧（贴窗口边缘放不下就翻到行的
 * 左侧），选强度即选中该模型并应用。浮层是 fixed 定位（面板 overflow 剪不到）。
 */
function ModelPickerMenu({
	providers,
	model,
	levels,
	thinkingLevel,
	thinkingDisabled,
	onModel,
	onThinkingLevel,
}: {
	providers: ProviderModelsMessage[];
	model: string;
	levels: string[];
	thinkingLevel: string;
	thinkingDisabled: boolean;
	onModel: (value: string) => void;
	onThinkingLevel: (level: string) => void;
}): React.JSX.Element {
	const t = useT();
	const activeName = modelDisplayName(providers, model, t("composer.defaultModel"));

	return (
		<Menu
			triggerClassName={ghostPillClass}
			triggerTitle={`${t("composer.switchModel")} · ${activeName}${thinkingDisabled ? ` · ${t("composer.thinkingUnsupported")}` : ""}`}
			panelClassName="owl-composer-menu right-0 w-64"
			trigger={
				<>
					<span className="owl-composer-label max-w-44 truncate">{activeName}</span>
					<svg
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						className={`h-3 w-3 shrink-0 ${thinkingDisabled ? "text-owl-faint" : "text-owl-accent"}`}
					>
						<path d="M8 1.5c2 2.2 4.5 3.8 4.5 7a4.5 4.5 0 1 1-9 0c0-3.2 2.5-4.8 4.5-7Z" />
						<circle cx="8" cy="9" r="1.6" fill="currentColor" stroke="none" />
					</svg>
					<span className={`shrink-0 text-xs ${thinkingDisabled ? "text-owl-faint" : "text-owl-accent"}`}>
						{THINKING_LABELS[thinkingLevel] ? t(THINKING_LABELS[thinkingLevel]) : thinkingLevel}
					</span>
					<Chevron />
				</>
			}
		>
			{(close: () => void) => (
				<ModelPickerBody
					close={close}
					providers={providers}
					model={model}
					levels={levels}
					thinkingLevel={thinkingLevel}
					thinkingDisabled={thinkingDisabled}
					onModel={onModel}
					onThinkingLevel={onThinkingLevel}
				/>
			)}
		</Menu>
	);
}

/** 菜单面板体：随菜单开合挂载/卸载，思考浮层的悬停状态在这里，不会跨开关残留。 */
function ModelPickerBody({
	close,
	providers,
	model,
	levels,
	thinkingLevel,
	thinkingDisabled,
	onModel,
	onThinkingLevel,
}: {
	close: () => void;
	providers: ProviderModelsMessage[];
	model: string;
	levels: string[];
	thinkingLevel: string;
	thinkingDisabled: boolean;
	onModel: (value: string) => void;
	onThinkingLevel: (level: string) => void;
}): React.JSX.Element {
	const t = useT();
	const [flyout, setFlyout] = useState<{ x: number; y: number; value: string } | null>(null);
	const flyoutClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// 浮层贴行右上；右侧放不下翻到行的左侧。纵向按行顶对齐并夹在窗口内。
	const openFlyout = (value: string, row: HTMLElement): void => {
		if (flyoutClose.current) clearTimeout(flyoutClose.current);
		const rect = row.getBoundingClientRect();
		const width = 132;
		const height = 44 + levels.length * 28;
		const side = rect.right + width + 12 <= window.innerWidth ? rect.right + 6 : rect.left - width - 6;
		const x = Math.max(8, Math.min(side, window.innerWidth - width - 8));
		const y = Math.max(8, Math.min(rect.top - 2, window.innerHeight - height - 8));
		setFlyout({ x, y, value });
	};
	// 行 → 浮层之间有几像素缝隙：延迟关、进入即保活，指针穿过缝隙不闪断。
	const scheduleFlyoutClose = (): void => {
		if (flyoutClose.current) clearTimeout(flyoutClose.current);
		flyoutClose.current = setTimeout(() => setFlyout(null), 120);
	};
	const keepFlyout = (): void => {
		if (flyoutClose.current) clearTimeout(flyoutClose.current);
	};

	return (
		<>
			<div className="w-full" onMouseLeave={scheduleFlyoutClose}>
				{providers.length === 0 && <p className="px-3 py-2 text-xs text-owl-faint">{t("composer.noModels")}</p>}
				{providers.map((provider) => (
					<div key={provider.id}>
						<p className="px-3 pt-2 pb-1 text-[10px] tracking-wide text-owl-faint uppercase">
							{provider.name ?? provider.id}
						</p>
						{provider.models.map((entry) => {
							const value = `${provider.id}/${entry.id}`;
							const active = value === model;
							return (
								<div
									key={entry.id}
									className="relative"
									onMouseEnter={entry.reasoning ? (event) => openFlyout(value, event.currentTarget) : undefined}
									onMouseLeave={entry.reasoning ? scheduleFlyoutClose : undefined}
								>
									<button
										type="button"
										className={`${menuItemClass} ${active ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
										onClick={() => {
											onModel(value);
											close();
										}}
									>
									<span className="min-w-0 flex-1 truncate" title={entry.name}>
										{entry.name}
										{entry.contextWindow ? (
											<span className="ml-1.5 text-owl-faint">{Math.round(entry.contextWindow / 1000)}k</span>
										) : null}
									</span>
									{active && <span className="text-owl-accent">✓</span>}
									</button>
								</div>
							);
						})}
					</div>
				))}
			</div>
			{/* 挂到 body：吉祥物槽位带 transform，会把 fixed 定位改成相对槽位 */}
			{flyout && createPortal(
				<div
					className="owl-menu-panel fixed z-50 w-32 rounded-xl border border-owl-border bg-owl-panel py-1 shadow-xl shadow-black/50"
					style={{ left: flyout.x, top: flyout.y }}
					onMouseEnter={keepFlyout}
					onMouseLeave={scheduleFlyoutClose}
					onMouseDown={(event) => event.stopPropagation()}
				>
					<p className="px-2.5 pb-0.5 pt-1 text-[10px] tracking-wide text-owl-faint uppercase">{t("composer.thinkingSection")}</p>
					{levels.map((level) => (
						<button
							key={level}
							type="button"
							disabled={thinkingDisabled}
							title={thinkingDisabled ? t("composer.thinkingUnsupported") : undefined}
							className={`${menuItemClass} disabled:cursor-not-allowed disabled:opacity-50 ${level === thinkingLevel ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
							onClick={() => {
								onThinkingLevel(level);
								if (flyout.value !== model) onModel(flyout.value);
								close();
							}}
						>
							<span className="flex-1">{THINKING_LABELS[level] ? t(THINKING_LABELS[level]) : level}</span>
							{level === thinkingLevel && <span className="text-owl-accent">✓</span>}
						</button>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}

/** 目录 chip 尾部的 ✕（叉掉目录，不选目录对话）。 */
const envChipClearClass =
	"flex h-6 w-5 items-center justify-center rounded-md text-[11px] text-owl-faint " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text";

/** 斜杠命令菜单里的来源标签。 */
const SLASH_KIND_LABELS: Record<SlashCommandEntry["kind"], TextKey> = {
	builtin: "composer.slashKind.builtin",
	skill: "composer.slashKind.skill",
	prompt: "composer.slashKind.prompt",
	extension: "composer.slashKind.extension",
};

/** 随消息发送的图片附件（base64；与后端 ImageContent 同形）。 */
export type ComposerImage = { type: "image"; data: string; mimeType: string };

export type ComposerDraftRequest = {
	id: number;
	text: string;
	images?: ComposerImage[];
	attachedPaths?: string[];
	replace?: boolean;
};

/** 待发送区里的附图：额外带本地 id 供列表 key 与单张移除。 */
type PendingImage = ComposerImage & { id: string; name?: string };

/** 单张附图上限：10MB（base64 后约 13MB，远小于桥 WebSocket 上限；服务端会按模型输入限制再压缩）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 一条消息最多附图数。 */
const MAX_PROMPT_IMAGES = 8;

/** 剪贴板/拖入的文件按扩展名兜底识别图片（Windows 资源管理器复制的文件 type 可能为空）。 */
function imageMimeOf(file: File): string | undefined {
	return imageMimeOfName(file.name, file.type);
}

function filePathOf(file: File): string | undefined {
	const path = (file as File & { path?: unknown }).path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function transferHasFiles(transfer: DataTransfer): boolean {
	const types = transfer.types;
	return types.includes("Files") || types.includes("text/uri-list");
}

/** 把图片文件读成 base64；非图片或读取失败返回 undefined。 */
function readImageFile(file: File): Promise<{ data: string; mimeType: string; name: string } | undefined> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = typeof reader.result === "string" ? reader.result : "";
			const comma = result.indexOf(",");
			const mimeType = imageMimeOf(file);
			if (comma < 0 || !mimeType) {
				resolve(undefined);
				return;
			}
			resolve({ data: result.slice(comma + 1), mimeType, name: file.name });
		};
		reader.onerror = () => resolve(undefined);
		reader.readAsDataURL(file);
	});
}

let imageSeq = 0;

export function Composer({
	client,
	connected,
	disabled,
	running,
	sentHistory,
	turnRate,
	paused = false,
	hideEnvironment = false,
	environmentAccessory,
	onSend,
	onAbort,
	onPause,
	onResume,
	providers,
	model,
	onModel,
	modelSelection,
	onRetryModelSelection,
	thinkingLevel,
	onThinkingLevel,
	approvalMode,
	onApprovalMode,
	agentPresets,
	defaultPresetId,
	agentPreset,
	agentPresetLocked,
	agentPresetDisabledReasons,
	onAgentPresetSelect,
	sessionInfo,
	workspaceDir,
	projects,
	sessionScope = "chat",
	/** 是否已选择对话目录；false = 已叉掉（不选目录，会话进默认目录），chip 变成「选择目录」占位。 */
	workspaceSelected = true,
	onSwitchProject,
	/** 点 chip 上的 ✕：解除目录绑定（会话默认进默认目录）。 */
	onClearProject,
	commands,
	searchFiles,
	draftRequest,
	initialDraft,
	onDraftChange,
	onOpenContext,	owlPose = "idle",
	queueSessionId,
	queueProfile,
	queueOwnerRevision,
	queueIsCurrent,
	followUp,
	hideMascot = false,
	questionPending = false,
}: {
	client: BridgeClient;
	/** 桥连接状态：本地 chip 上展示运行环境健康度。 */
	connected: boolean;
	disabled: boolean;
	running: boolean;
	/** 本轮最近一条可测速回复的 tok/s（流式中为估算）。并入上下文计数展示，undefined 表示暂时测不了。 */
	turnRate?: { tps: number; estimated: boolean };
	/** 当前会话处于「已暂停」态：按钮显示继续，点击可从中断处接着跑。 */
	paused?: boolean;
	/** Hide secondary environment controls while the active conversation needs attention. */
	hideEnvironment?: boolean;
	/** Optional mode control that shares the existing environment row's alignment. */
	environmentAccessory?: ReactNode;
	/** false or rejection leaves the complete draft intact; void preserves synchronous callers. */
	onSend: (text: string, images?: ComposerImage[], attachedPaths?: string[], delivery?: "queue" | "steer") => boolean | void | Promise<boolean | void>;
	/** 队列归属的会话与身份，用于发送动效的所有权判定。 */
	queueSessionId?: string;
	queueProfile?: string;
	queueOwnerRevision?: string | number;
	queueIsCurrent?: () => boolean;
	/** Latest user and assistant text, so the next-prompt hint can follow this turn. */
	followUp?: { user: string; assistant: string };
	/** 输入框上方已经有排队或任务清单时，把沿口上的猫头鹰收起来。 */
	hideMascot?: boolean;
	/** 上方贴着待答题卡片时同样让位：吉祥物探出沿口会压住卡片底边和「展开」。 */
	questionPending?: boolean;
	onAbort: () => void;
	/** 提供时运行中按钮显示「暂停」而不是直接中止。 */
	onPause?: () => void;
	/** 已暂停时点击按钮的恢复动作。 */
	onResume?: () => void;
	providers: ProviderModelsMessage[];
	model: string;
	onModel: (value: string) => void;
	modelSelection?: ModelSelectionFeedback;
	onRetryModelSelection?: () => void;
	thinkingLevel: string;
	onThinkingLevel: (level: string) => void;
	approvalMode: ApprovalMode;
	onApprovalMode: (mode: ApprovalMode) => void;
	/** Agent 预设花名册（桥端 preset.list）：决定会话的工具/提示词/技能组合。 */
	agentPresets?: AgentPresetDefinition[];
	/** 新任务默认预设 id（花名册里的「默认」徽章）。 */
	defaultPresetId?: string;
	/** 当前生效（或暂存）的预设 id。 */
	agentPreset?: string;
	/** 会话跑过第一轮后预设锁定（DSH 的 blank-session-only 切换不变量）。 */
	agentPresetLocked?: boolean;
	/** Presets that this conversation type cannot run, with an explanation shown in the menu. */
	agentPresetDisabledReasons?: Readonly<Record<string, string>>;
	/** 选择预设：空白会话即时切换，新会话暂存到创建时生效。 */
	onAgentPresetSelect?: (id: string) => void;
	sessionInfo: SessionStatsResult | undefined;
	/** 当前项目（工作目录）绝对路径。 */
	workspaceDir: string;
	/** false = 已叉掉目录（不选目录，会话进默认目录），chip 显示「选择目录」占位。 */
	workspaceSelected?: boolean;
	/** 候选项目列表（与侧边栏同源：当前 ∪ 有会话 ∪ 到访过）。 */
	projects: string[];
	/** Project visibility preferences belong to the current conversation type. */
	sessionScope?: "chat" | "research";
	/** 切换项目 = 换工作目录并从新会话开始（与侧边栏点击项目同语义）。 */
	onSwitchProject: (path: string) => void;
	/** 叉掉目录（不选目录对话）；提供才显示 ✕。 */
	onClearProject?: () => void;
	/** 斜杠命令清单（桥端 commands.list）：输入 "/" 时自动补全。 */
	commands: SlashCommandEntry[];
	/** @ 调起的本项目文件搜索（侧栏同源：与 fs.search 共享 100 命中兜底）。 */
	searchFiles: (cwd: string, query: string) => Promise<FsSearchHit[]>;
	/** Start-page examples fill a draft without submitting or replacing existing text.
	 *  replace: 会话回退后的「文本回填」——整体替换输入框内容而不是追加。 */
	draftRequest?: ComposerDraftRequest;
	/** ↑ 召回用的历史输入（最新在前）；连续重复只留一条。 */
	sentHistory?: readonly string[];
	/** Restore a caller-owned text draft when this composer mounts; later prop changes do not move the caret. */
	initialDraft?: string;
	/** Observe edits, draft inserts, and send/clear so another view can restore the same text draft. */
	onDraftChange?: (text: string) => void;
	/** 点击后跳到完整上下文面板（Ctrl+Alt+B 同一视图）；不传则菜单里不出入口。 */
	onOpenContext?: () => void;
	/** 栖在对话框上沿的流羽猫头鹰。空闲也在。 */
	owlPose?: OwlPose;
}): React.JSX.Element {
	const t = useT();
	useProjectSidebarRevision();
	const predictionText = useComposerPredictionText();
	const executionCopy = useExecutionText();
	const predictionSettingId = useId();
	const [value, setValue] = useState(() => initialDraft ?? "");
	const initialDraftRef = useRef(initialDraft);
	const draftRevision = useRef(0);
	const submitInFlight = useRef(false);
	const mounted = useRef(true);
	const [sending, setSending] = useState(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	const setDraftValue = (text: string): void => {
		draftRevision.current++;
		setValue(text);
		onDraftChange?.(text);
	};
	const [showNewProject, setShowNewProject] = useState(false);
	// 待发送附图：Ctrl+V 粘贴或拖入图片先进这里，随下一条消息一起发出。
	const [pendingImages, updatePendingImages] = useState<PendingImage[]>([]);
	const setPendingImages = (next: SetStateAction<PendingImage[]>): void => {
		draftRevision.current++;
		updatePendingImages(next);
	};
	// 点击缩略图查看完整大图（与 ChatStream 的看图体验一致），点遮罩关闭。
	const [zoomedImage, setZoomedImage] = useState<PendingImage | null>(null);
	const [pasteHint, setPasteHint] = useState<string | undefined>(undefined);
	// 召回态：-1 = 未在浏览；0 = 最近一条。任何其它按键即退出，避免覆盖用户改动。
	const recallIndex = useRef(-1);
	const recallHistory = (() => {
		const seen: string[] = [];
		for (const text of sentHistory ?? []) {
			if (text.trim() && seen[seen.length - 1] !== text) seen.push(text);
		}
		return seen;
	})();
	const [dragOver, setDragOver] = useState(false);
	// 悬停期间 dataTransfer.items 里可见的文件数；0 = 原生桌面拖拽（web 拿不到数量）。
	const [dragCount, setDragCount] = useState(0);
	const hintTimerRef = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(hintTimerRef.current), []);
	const editorRef = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	const inputBoxRef = useRef<HTMLDivElement>(null);
	const dropZoneRef = useRef<HTMLDivElement>(null);
	const [predictionVisible, setPredictionVisible] = useState(() => typeof IntersectionObserver === "undefined");
	useEffect(() => {
		const surface = dropZoneRef.current;
		if (!surface || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) if (entry.target === surface) setPredictionVisible(entry.isIntersecting);
		});
		observer.observe(surface);
		return () => observer.disconnect();
	}, []);
	const nativeDropAt = useRef(0);
	const slashMenuRef = useRef<HTMLDivElement>(null);
	const mentionMenuRef = useRef<HTMLDivElement>(null);
	// 斜杠命令菜单：输入末尾的 "/命令" token（行首或空白之后）触发；
	// Esc 关闭后要等输入变化才重开，避免关不掉。
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	// @ 文件引用：attachedPaths 与 DOM 中的芯片同步（哨兵推到、点 X 清掉它们）。
	const [attachedPaths, updateAttachedPaths] = useState<string[]>([]);
	const attachmentOwner = JSON.stringify([queueProfile, queueSessionId, queueOwnerRevision, workspaceDir, sessionScope]);
	const motion = useComposerMotion({
		surfaceRef: dropZoneRef, inputRef: inputBoxRef, client,
		owner: JSON.stringify([queueProfile, queueOwnerRevision ?? queueSessionId, workspaceDir, sessionScope]),
		isCurrent: queueIsCurrent,
	});
	const attachmentContext = useRef({ client, owner: attachmentOwner, connected });
	attachmentContext.current = { client, owner: attachmentOwner, connected };
	const [attachmentCheck, setAttachmentCheck] = useState<{ owner: string; client: BridgeClient; checking: boolean; issues: AttachmentIssue[] }>();
	const visibleAttachmentCheck = attachmentCheck?.owner === attachmentOwner && attachmentCheck.client === client ? attachmentCheck : undefined;
	const verifyAttachedPaths = async (paths: readonly string[], revision: number): Promise<boolean> => {
		setAttachmentCheck({ owner: attachmentOwner, client, checking: true, issues: [] });
		try {
			const issues = await checkAttachmentPaths(client, workspaceDir, paths);
			if (!mounted.current || !attachmentContext.current.connected || attachmentContext.current.owner !== attachmentOwner || attachmentContext.current.client !== client || draftRevision.current !== revision || (queueIsCurrent && !queueIsCurrent())) return false;
			setAttachmentCheck({ owner: attachmentOwner, client, checking: false, issues });
			return issues.length === 0;
		} finally {
			if (mounted.current) setAttachmentCheck((current) => current?.owner === attachmentOwner && current.client === client && current.checking ? { ...current, checking: false } : current);
		}
	};
	const setAttachedPaths = (next: SetStateAction<string[]>): void => {
		draftRevision.current++;
		updateAttachedPaths(next);
	};
	const [mentionOpen, setMentionOpen] = useState(false);
	const [mentionQuery, setMentionQuery] = useState("");
	const [mentionItems, setMentionItems] = useState<FsSearchHit[]>([]);
	const [mentionIndex, setMentionIndex] = useState(0);
	useLayoutEffect(() => {
		if (initialDraftRef.current === undefined) return;
		clearEditorContent(editorRef.current);
		insertPlainText(editorRef.current, initialDraftRef.current);
	}, []);
	// Restore the complete draft. Appending examples or recovered input preserves existing materials.
	useEffect(() => {
		if (!draftRequest) return;
		const images = (draftRequest.images ?? []).map((image) => ({ ...image, id: `img-${++imageSeq}` }));
		if (draftRequest.replace) {
			setDraftValue(draftRequest.text);
			setPendingImages(images);
			setAttachedPaths([...(draftRequest.attachedPaths ?? [])]);
			clearEditorContent(editorRef.current);
			insertPlainText(editorRef.current, draftRequest.text);
		} else {
			const next = value.trim() ? `${value}\n\n${draftRequest.text}` : draftRequest.text;
			setDraftValue(next);
			if (images.length > 0) setPendingImages((current) => [...current, ...images]);
			if (draftRequest.attachedPaths?.length) setAttachedPaths((current) => [...new Set([...current, ...draftRequest.attachedPaths!])]);
			if (editorRef.current) {
				appendPlainText(editorRef.current, draftRequest.text, value.trim().length > 0);
			}
		}
		setMentionOpen(false);
		setSlashDismissed(true);
		editorRef.current?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftRequest]);
	const submit = async (delivery?: "queue" | "steer", source?: HTMLElement): Promise<void> => {
		if (disabled || submitInFlight.current || modelSelection?.status === "pending") return;
		const text = value.trim();
		const hasImages = pendingImages.length > 0;
		const hasAttachments = attachedPaths.length > 0;
		if (!text && !hasImages && !hasAttachments) return;
		const revision = draftRevision.current;
		submitInFlight.current = true;
		setSending(true);
		let feedback: ComposerSendMotion | undefined;
		try {
			if (hasAttachments && !(await verifyAttachedPaths([...attachedPaths], revision))) return;
			const deliveryMode = running ? delivery ?? "steer" : undefined;
			feedback = motion.beginSend(deliveryMode, source);
			const accepted = await onSend(text, hasImages ? pendingImages.map(({ type, data, mimeType }) => ({ type, data, mimeType })) : undefined, hasAttachments ? [...attachedPaths] : undefined, deliveryMode);
			if (accepted === false) { feedback.cancel(); return; }
			feedback.accepted();
			// A later edit or externally restored draft belongs to the user, not this request.
			if (!mounted.current || draftRevision.current !== revision) return;
			setDraftValue("");
			setAttachedPaths([]);
			setMentionOpen(false);
			clearEditorContent(editorRef.current);
			setPendingImages([]);
		} catch {
			feedback?.cancel();
			// The caller owns visible failure feedback. Keep every part of the draft for retry.
		} finally {
			submitInFlight.current = false;
			if (mounted.current) setSending(false);
		}
	};

	// 附图提示自动消退（超限/超大时给一句人话反馈，不打断输入）。
	const showHint = (text: string): void => {
		setPasteHint(text);
		window.clearTimeout(hintTimerRef.current);
		hintTimerRef.current = window.setTimeout(() => setPasteHint(undefined), 4000);
	};

	// 拖进来的文件只记路径。芯片画在输入框上方，不再塞进正文，避免同一文件出现两枚。
	const addAttachmentPaths = (paths: string[]): void => {
		if (paths.length === 0) return;
		setAttachedPaths((current) => {
			const next = [...current];
			for (const path of paths) if (!next.includes(path)) next.push(path);
			return next.length === current.length ? current : next;
		});
	};

	// 系统拖放只有路径。图片读成预览；读不到（超大、权限）就退回路径芯片，文件仍然进对话。
	const addImagePaths = (paths: string[]): void => {
		const room = Math.max(0, MAX_PROMPT_IMAGES - pendingImages.length);
		const picked = paths.slice(0, room);
		if (paths.length > room) showHint(t("composer.imageLimitReached", { max: MAX_PROMPT_IMAGES }));
		const overflow = paths.slice(room);
		if (overflow.length > 0) addAttachmentPaths(overflow);
		if (picked.length === 0) return;
		void Promise.all(picked.map(async (path) => ({ path, image: await readLocalImage(path) }))).then((loaded) => {
			const images: PendingImage[] = [];
			const fallback: string[] = [];
			for (const entry of loaded) {
				if (entry.image) images.push({ id: `img-${++imageSeq}`, type: "image", data: entry.image.data, mimeType: entry.image.mimeType, name: fileBasename(entry.path) });
				else fallback.push(entry.path);
			}
			if (images.length > 0) setPendingImages((current) => [...current, ...images].slice(0, MAX_PROMPT_IMAGES));
			if (fallback.length > 0) addAttachmentPaths(fallback);
		});
	};

	const acceptDroppedPaths = (paths: string[]): void => {
		const split = splitDroppedPaths(paths);
		if (split.attachments.length > 0) addAttachmentPaths(split.attachments);
		if (split.images.length > 0) addImagePaths(split.images);
	};

	// 粘贴/拖入的图片文件读成 base64 挂进待发送区；超量截断、超大跳过。
	const addImageFiles = (files: File[]): void => {
		const candidates = files.filter((file) => imageMimeOf(file) !== undefined);
		if (candidates.length === 0) return;
		const room = Math.max(0, MAX_PROMPT_IMAGES - pendingImages.length);
		if (candidates.length > room) showHint(t("composer.imageLimitReached", { max: MAX_PROMPT_IMAGES }));
		const picked = candidates.slice(0, room);
		const accepted = picked.filter((file) => file.size <= MAX_IMAGE_BYTES);
		if (accepted.length < picked.length) showHint(t("composer.imageTooLarge", { limit: Math.round(MAX_IMAGE_BYTES / 1024 / 1024) }));
		if (accepted.length === 0) return;
		void Promise.all(accepted.map((file) => readImageFile(file))).then((images) => {
			const next = images.flatMap((image) =>
				image ? { id: `img-${++imageSeq}`, type: "image" as const, data: image.data, mimeType: image.mimeType, name: image.name } : [],
			);
			if (next.length > 0) setPendingImages((current) => [...current, ...next].slice(0, MAX_PROMPT_IMAGES));
		});
	};

// 富文本剪贴板降级：带 text/html 的粘贴（网页/Office/聊天工具复制）按 text/plain 插入，
// 避免 contenteditable 默认吞下带内联样式的标签。纯文件/链接粘贴不走这条。
	const pasteAsPlainText = (event: React.ClipboardEvent<HTMLElement>): boolean => {
		const html = event.clipboardData.getData("text/html");
		const plain = event.clipboardData.getData("text/plain");
		if (html.trim() === "" || plain.trim() === "" || plain.trim() === html.trim()) return false;
		event.preventDefault();
		const selection = window.getSelection();
		if (selection && selection.rangeCount > 0) {
			const range = selection.getRangeAt(0);
			range.deleteContents();
			range.insertNode(document.createTextNode(plain));
			range.collapse(false);
		} else {
			appendPlainText(editorRef.current, plain, (editorRef.current?.textContent ?? "").trim().length > 0);
		}
		return true;
	};

	const onClipboardPaste = (event: React.ClipboardEvent<HTMLElement>): void => {
		if (pasteAsPlainText(event)) return;
		const files: File[] = [];
		for (const item of Array.from(event.clipboardData.items)) {
			if (item.kind !== "file") continue;
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		const uriList = event.clipboardData.getData("text/uri-list");
		if (files.length === 0 && uriList.trim() === "") return;
		const classified = classifyHtmlDrop(
			files.map((file) => ({ name: file.name, type: file.type, path: filePathOf(file) })),
			uriList,
		);
		const imageFiles = classified.imageIndexes.flatMap((index) => {
			const file = files[index];
			return file ? [file] : [];
		});
		// 复制的网页链接只有 uri-list、落不成图片或附件：放行默认插入，别把粘贴整段吞掉。
		if (imageFiles.length === 0 && classified.attachmentPaths.length === 0 && classified.unnamedCount === 0) return;
		// 图片进预览。其余文件按本地路径附进本回合，没有路径就提示。
		event.preventDefault();
		if (imageFiles.length > 0) addImageFiles(imageFiles);
		if (classified.attachmentPaths.length > 0) addAttachmentPaths(classified.attachmentPaths);
		if (classified.unnamedCount > 0) showHint(t("composer.dropNoPath", { count: classified.unnamedCount }));
	};

	// 单行起步、随内容自动长高（Claude 同款）；上限 192px 与 max-h-48 一致，发送后随 value 清空缩回。
	useEffect(() => {
		const el = editorRef.current;
		if (!el) return;
		el.style.height = "auto";
		// Empty drafts keep the one-row height instead of measuring a wrapped placeholder.
		if (value) el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
	}, [value]);

	// 抽出从编辑器开头到光标的可见文本（跳过芯片节点），用于检测当前是否在 @ 引用中。
	function getTextBeforeCaret(editor: HTMLElement): { text: string; caretNode: Node | null; caretOffset: number } {
		const sel = typeof window !== "undefined" ? window.getSelection() : null;
		if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return { text: "", caretNode: null, caretOffset: 0 };
		const range = sel.getRangeAt(0);
		if (!editor.contains(range.endContainer)) return { text: "", caretNode: null, caretOffset: 0 };
		const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				const parent = (node.parentElement);
				if (parent?.closest(".owl-mention-chip")) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		let text = "";
		let caretNode: Node | null = null;
		let caretOffset = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			if (node === range.endContainer) {
				text += node.textContent?.slice(0, range.endOffset) ?? "";
				caretNode = node;
				caretOffset = range.endOffset;
				break;
			}
			text += node.textContent ?? "";
		}
		return { text, caretNode, caretOffset };
	}

	// 光标当前是否正处在 @xxx token 上（token 以非空白结尾）。
	function getActiveMention(editor: HTMLElement): { query: string; startNode: Node; startOffset: number; endNode: Node; endOffset: number } | null {
		const { text, caretNode, caretOffset } = getTextBeforeCaret(editor);
		if (!caretNode) return null;
		const match = /@([^\s@]*)$/.exec(text);
		if (!match) return null;
		const matchStart = text.length - match[0].length;
		// 重新走一遍树以定位 token 在 DOM 中的起节点。
		const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				const parent = (node.parentElement);
				if (parent?.closest(".owl-mention-chip")) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		let pos = 0;
		let startNode: Node | null = null;
		let startOffset = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const len = node.textContent?.length ?? 0;
			if (pos + len >= matchStart) {
				startNode = node;
				startOffset = matchStart - pos;
				break;
			}
			pos += len;
		}
		if (!startNode) return null;
		return { query: match[1], startNode, startOffset, endNode: caretNode, endOffset: caretOffset };
	}

	// 在编辑器里寻找指定路径对应的芯片并删除；返回是否找到。
	function removeChipByPath(editor: HTMLElement, path: string): boolean {
		const chip = editor.querySelector(`[data-mention-path="${CSS.escape(path)}"]`);
		if (!chip) return false;
		chip.parentNode?.removeChild(chip);
		return true;
	}

	// 重置编辑器：发送 / 草稿后调用。
	function clearEditorContent(editor: HTMLElement | null): void {
		if (!editor) return;
		while (editor.firstChild) editor.removeChild(editor.firstChild);
	}

	// 草稿初始化：整体赋值并保留光标。
	function insertPlainText(editor: HTMLElement | null, text: string): void {
		if (!editor) return;
		editor.appendChild(document.createTextNode(text));
	}

	// 草稿追加：在尾部拼一段，必要时先补换行。
	function appendPlainText(editor: HTMLElement | null, text: string, addLeadingBlankLine: boolean): void {
		if (!editor) return;
		if (addLeadingBlankLine) editor.appendChild(document.createTextNode("\n\n"));
		editor.appendChild(document.createTextNode(text));
	}

	// 把当前 @xxx token 换成芯片，芯片后保留原 caret。
	function replaceMentionWithChip(editor: HTMLElement, mention: NonNullable<ReturnType<typeof getActiveMention>>, path: string, basename: string): void {
		const range = document.createRange();
		range.setStart(mention.startNode, mention.startOffset);
		range.setEnd(mention.endNode, mention.endOffset);
		range.deleteContents();
		const chip = document.createElement("span");
		chip.className = "owl-mention-chip";
		chip.contentEditable = "false";
		chip.dataset.mentionPath = path;
		const label = document.createElement("span");
		label.className = "owl-mention-chip__label";
		label.textContent = basename;
		const x = document.createElement("button");
		x.type = "button";
		x.className = "owl-mention-chip__x";
		x.tabIndex = -1;
		x.textContent = "✕";
		x.setAttribute("aria-label", t("composer.removeAttachment"));
		// 防止按 X 跳出可编辑区域；onClick 由事件代理在 editor 顶层处理。
		x.addEventListener("mousedown", (event) => event.preventDefault());
		chip.appendChild(label);
		chip.appendChild(x);
		range.insertNode(chip);
		// 紧随芯片补一个零宽空格，光标得以落点（contenteditable=false 不会吃 caret）。
		const tail = document.createTextNode("\u200b");
		chip.parentNode?.insertBefore(tail, chip.nextSibling);
		const sel = window.getSelection();
		if (sel) {
			const nextRange = document.createRange();
			nextRange.setStart(tail, 1);
			nextRange.setEnd(tail, 1);
			sel.removeAllRanges();
			sel.addRange(nextRange);
		}
	}

	// 同步编辑器 DOM → value（跳过芯片）。
	const syncEditorToValue = (editor: HTMLElement | null): string => {
		if (!editor) return "";
		return extractPlainText(editor);
	};

	// 正文里的 @ 芯片保留原位，外部材料区只展示没有插进正文的路径。
	const inlineAttachmentPaths = new Set(
		Array.from(editorRef.current?.querySelectorAll(".owl-mention-chip") ?? [])
			.map((chip) => chip.getAttribute("data-mention-path"))
			.filter((path): path is string => Boolean(path)),
	);
	const chipEntries = attachedPaths
		.filter((path) => !inlineAttachmentPaths.has(path))
		.map((path) => ({ path, basename: fileBasename(path), key: path }));

	// @ 触发：value 变化时检查是否有 @ token；查询空时不拉接口。
	useEffect(() => {
		if (disabled) return;
		const editor = editorRef.current;
		if (!editor) return;
		const mention = getActiveMention(editor);
		if (!mention) {
			if (mentionOpen) setMentionOpen(false);
			return;
		}
		setMentionOpen(true);
		setMentionQuery(mention.query);
		setMentionIndex(0);
		// 新查询的结果回来之前先清掉上一份名单，避免回车选中过期文件。
		setMentionItems([]);
		if (mention.query.length === 0) return;
		let cancelled = false;
		void searchFiles(workspaceDir, mention.query).then((hits) => {
			if (cancelled) return;
			setMentionItems(hits.slice(0, 30));
		}).catch(() => {
			if (cancelled) return;
			setMentionItems([]);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value]);

	// 回车把当前高亮项变为芯片；同时记录到 attachedPaths。
	const acceptMention = (hit: FsSearchHit): void => {
		const editor = editorRef.current;
		if (!editor) return;
		const mention = getActiveMention(editor);
		if (!mention) return;
		// 不设上限（决定 2.3）；同路径不会重复打（重复 @ 同一路径也只多枚芯片）。
		replaceMentionWithChip(editor, mention, hit.path, hit.path.split("/").pop() ?? hit.path);
		setAttachedPaths((current) => (current.includes(hit.path) ? current : [...current, hit.path]));
		setDraftValue(syncEditorToValue(editor));
		setMentionOpen(false);
		setMentionItems([]);
		setMentionQuery("");
		// 保持 caret 在新芯片之后（replaceMentionWithChip 已经把零宽空格放好）。
		editor.focus();
	};

	// 从芯片列表里摘掉一个，同时清掉 editor 中对应的 span。
	const removeAttachment = (path: string): void => {
		const editor = editorRef.current;
		removeChipByPath(editor!, path);
		setAttachedPaths((current) => current.filter((entry) => entry !== path));
		setDraftValue(syncEditorToValue(editor));
		editor?.focus();
	};

	const acceptDroppedPathsRef = useRef(acceptDroppedPaths);
	acceptDroppedPathsRef.current = acceptDroppedPaths;
	// Windows 上资源管理器拖放到不了网页 drop，只能听桌面壳的系统拖放。
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void listenForOsFileDrop((event) => {
			const zone = dropZoneRef.current;
			if (!zone) return;
			if (event.type === "leave") {
				setDragOver(false);
				setDragCount(0);
				return;
			}
			const inside = dropPointHits(zone.getBoundingClientRect(), event.position, window.devicePixelRatio || 1);
			if (event.type !== "drop") {
				setDragOver(inside);
				if (inside) setDragCount(0);
				return;
			}
			setDragOver(false);
			setDragCount(0);
			if (!inside || event.paths.length === 0) return;
			nativeDropAt.current = Date.now();
			acceptDroppedPathsRef.current(event.paths);
		}).then((stop) => {
			if (cancelled) stop();
			else unlisten = stop;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	// 斜杠过滤：前缀命中排前，其次子串；上限 30 条防长清单卡顿。
	// exec 不命中返回 null（≠ undefined），用 null 判「不在输入命令」。
	const slashExec = slashDismissed ? null : /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/.exec(value);
	const slashItems: SlashCommandEntry[] = [];
	if (slashExec) {
		const query = slashExec[1].toLowerCase();
		for (const entry of commands) {
			const name = entry.name.toLowerCase();
			if (name.startsWith(query) || name.includes(query)) slashItems.push(entry);
		}
		if (query === "") {
			// 空查询（刚敲 "/"）：内置命令置顶，技能/扩展按原顺序跟在后面——
			// 技能动辄几十个，不置顶的话内置命令会被挤出可见区。
			slashItems.sort((a, b) => Number(a.kind !== "builtin") - Number(b.kind !== "builtin"));
		} else {
			slashItems.sort(
				(a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)),
			);
		}
		if (slashItems.length > 30) slashItems.length = 30;
	}
	const slashOpen = slashItems.length > 0;
	const slashActive = slashOpen ? Math.min(slashIndex, slashItems.length - 1) : -1;
	const predictionEligible = predictionVisible && value === "" && pendingImages.length === 0 && attachedPaths.length === 0
		&& !sending && !submitInFlight.current && !mentionOpen && slashExec === null && modelSelection?.status !== "pending";
	const isPredictionCurrent = (): boolean => {
		const surface = dropZoneRef.current;
		return queueIsCurrent?.() !== false && surface !== null
			&& (typeof surface.getClientRects !== "function" || surface.getClientRects().length > 0);
	};
	const prediction = usePromptSuggestion({
		client, connected, sessionId: queueSessionId, profile: queueProfile, ownerRevision: queueOwnerRevision,
		cwd: workspaceDir, model, running, paused, disabled, eligible: predictionEligible, followUp, isCurrent: isPredictionCurrent,
	});
	const suggestion = prediction.enabled && predictionEligible && !disabled && connected && !running && !paused ? prediction.suggestion : undefined;
	const acceptSuggestion = (): boolean => {
		const editor = editorRef.current;
		// Recheck the DOM: a keystroke or navigation can arrive before React commits the new owner or draft.
		if (!suggestion || !editor || editor.textContent !== "" || composing.current || submitInFlight.current || !isPredictionCurrent()) return false;
		const text = prediction.accept();
		if (!text) return false;
		clearEditorContent(editor);
		insertPlainText(editor, text);
		setDraftValue(text);
		editor.focus();
		const selection = window.getSelection();
		if (selection) {
			const caret = document.createRange();
			caret.selectNodeContents(editor);
			caret.collapse(false);
			selection.removeAllRanges();
			selection.addRange(caret);
		}
		motion.acceptSuggestion();
		return true;
	};

	const acceptSlashCommand = (entry: SlashCommandEntry): void => {
		const editor = editorRef.current;
		if (!editor || !slashExec) return;
		// 后端只执行开头的命令。把选中的命令放到开头，原有正文作为参数保留。
		// 只删末尾查询的文本，保留正文里的文件芯片及其附件关联。
		const textNodes: Text[] = [];
		const collectText = (node: Node): void => {
			if (node.nodeType === Node.TEXT_NODE) textNodes.push(node as Text);
			else if (node.nodeType === Node.ELEMENT_NODE && !(node as Element).classList.contains("owl-mention-chip")) {
				for (const child of Array.from(node.childNodes)) collectText(child);
			}
		};
		collectText(editor);
		const text = textNodes.map((node) => node.textContent ?? "").join("");
		const token = /\/([a-zA-Z0-9:_-]*)\s*$/.exec(text);
		if (!token || token[1] !== slashExec[1]) return;
		let remaining = text.length - token.index;
		for (let index = textNodes.length - 1; index >= 0 && remaining > 0; index--) {
			const node = textNodes[index];
			const content = node.textContent ?? "";
			const removed = Math.min(remaining, content.length);
			node.textContent = content.slice(0, content.length - removed);
			remaining -= removed;
		}
		editor.insertBefore(document.createTextNode(`/${entry.name} `), editor.firstChild);
		const prefix = value.slice(0, slashExec.index + slashExec[0].indexOf("/"));
		setDraftValue(`/${entry.name} ${prefix}`);
		setSlashDismissed(false);
		setSlashIndex(0);
		editor.focus();
		const selection = window.getSelection();
		if (selection) {
			const caret = document.createRange();
			caret.selectNodeContents(editor);
			caret.collapse(false);
			selection.removeAllRanges();
			selection.addRange(caret);
		}
	};

	// 菜单开着时点外部 = 收起（与 Menu 同款；菜单内点击用 onMouseDown 阻止抢焦点）。
	useEffect(() => {
		if (!slashOpen) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (!inputBoxRef.current?.contains(event.target as Node)) setSlashDismissed(true);
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [slashOpen]);

	// 高亮项变化后滚进可视区（键盘上下选命令时菜单跟随）。
	useEffect(() => {
		if (slashActive < 0) return;
		slashMenuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [slashActive]);

	const slash = model.indexOf("/");
	const activeProvider = slash > 0 ? model.slice(0, slash) : undefined;
	const activeModelId = slash > 0 ? model.slice(slash + 1) : undefined;
	const activeModelEntry = providers
		.find((provider) => provider.id === activeProvider)
		?.models.find((entry) => entry.id === activeModelId);
	const percent = sessionInfo?.contextUsage?.percent ?? null;
	const contextTokens = sessionInfo?.contextUsage?.tokens ?? null;
	const contextWindow = sessionInfo?.contextUsage?.contextWindow ?? activeModelEntry?.contextWindow;
	const levels = sessionInfo && sessionInfo.availableThinkingLevels.length > 0
		? sessionInfo.availableThinkingLevels
		: [...ALL_THINKING_LEVELS];
	const thinkingDisabled = sessionInfo !== undefined && !sessionInfo.supportsThinking;

	// 上下文构成占比（核心按消息角色估算后缩放到总口径），仿 ZCode 上下文容量弹层；
	// 四类取整后的余额归入「其他」，保证加总 ≈ 100%。
	const breakdownRows = (() => {
		const breakdown = sessionInfo?.contextUsage?.breakdown;
		if (!breakdown || contextTokens === null || contextTokens <= 0) return [];
		const total = breakdown.systemPrompt + breakdown.toolDefinitions + breakdown.messages + breakdown.toolResults;
		if (total <= 0) return [];
		const entries = [
			{ label: t("composer.ctxMessages"), value: breakdown.messages, color: "bg-emerald-400" },
			{ label: t("composer.ctxSystemPrompt"), value: breakdown.systemPrompt, color: "bg-sky-400" },
			{ label: t("composer.ctxToolDefinitions"), value: breakdown.toolDefinitions, color: "bg-violet-400" },
			{ label: t("composer.ctxToolResults"), value: breakdown.toolResults, color: "bg-amber-400" },
		].map((entry) => ({ ...entry, percent: (entry.value / total) * 100 }));
		const rows = entries.filter((entry) => entry.percent >= 0.1);
		const other = 100 - rows.reduce((sum, entry) => sum + entry.percent, 0);
		if (other >= 0.5) rows.push({ label: t("composer.ctxOther"), value: 0, color: "bg-zinc-500", percent: other });
		return rows;
	})();

	// 平均缓存命中率 = 缓存读取 /（缓存读取 + 未缓存输入）；无用量数据时不展示。
	const cacheHitRate = (() => {
		const tokens = sessionInfo?.stats?.tokens;
		if (!tokens) return null;
		const denominator = tokens.cacheRead + tokens.input;
		return denominator > 0 ? (tokens.cacheRead / denominator) * 100 : null;
	})();

	// 项目选择器排序：当前项目置顶，其余按显示名；移除的项目不再出现在候选列表。
	const sortedProjects = projects.filter((path) => !isProjectHidden(path, sessionScope)).sort((a, b) => {
		const aCurrent = samePath(a, workspaceDir);
		const bCurrent = samePath(b, workspaceDir);
		if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
		return getProjectDisplayName(a).localeCompare(getProjectDisplayName(b), getUiLanguage() === "en" ? "en" : "zh-CN");
	});

	const activeMode = APPROVAL_MODES.find((entry) => entry.value === approvalMode);
	const activePreset = agentPresets?.find((preset) => preset.id === agentPreset);

	// 项目下拉面板：选中态与「选择目录」占位态共用；未选目录时列表里没有打勾项。
	const projectMenu = (close: () => void): React.JSX.Element => (
		<div>
			<p className="px-3 pt-2 pb-1 text-[10px] tracking-wide text-owl-faint uppercase">{t("composer.projectPanelLabel")}</p>
			<div className="max-h-56 overflow-y-auto">
				{sortedProjects.map((path) => {
					const active = samePath(path, workspaceDir);
					return (
						<button
							key={path}
							type="button"
							title={path}
							className={`${menuItemClass} ${active ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
							onClick={() => {
								if (!active) onSwitchProject(path);
								close();
							}}
						>
							<FolderIcon tone={active ? "text-owl-text" : "text-owl-faint"} />
							<span className="flex-1 truncate">{getProjectDisplayName(path)}</span>
							{active && <span className="text-owl-accent">✓</span>}
						</button>
					);
				})}
				{sortedProjects.length === 0 && (
					<p className="px-3 py-2 text-xs text-owl-faint">{t("composer.noProjects")}</p>
				)}
			</div>
			<div className="my-1 border-t border-owl-border/70" />
			<button
				type="button"
				className={`${menuItemClass} text-owl-muted`}
				onClick={() => {
					close();
					setShowNewProject(true);
				}}
			>
				<FolderPlusIcon />
				<span className="flex-1">{t("composer.newProjectMenu")}</span>
			</button>
		</div>
	);

	const contextDetails = sessionInfo ? (
		<div className="w-full px-3 py-2 text-xs text-owl-muted">
			<div className="flex items-baseline justify-between gap-3 pb-1.5">
				<p className="text-owl-text">{t("composer.contextWindow")}</p>
				<p className="flex-none text-owl-faint">
					{contextTokens !== null ? formatTokens(contextTokens) : "—"}
					{contextWindow ? ` / ${formatTokens(contextWindow)}` : ""}
					{percent !== null ? ` · ${Math.round(percent)}%` : ""}
				</p>
			</div>
			<div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-owl-hover">
				<div
					className={`h-full rounded-full ${
						(percent ?? 0) >= 85 ? "bg-owl-danger" : (percent ?? 0) >= 60 ? "bg-owl-warning" : "bg-owl-success"
					}`}
					style={{ width: `${Math.min(100, Math.max(2, percent ?? 0))}%` }}
				/>
			</div>
			{breakdownRows.length > 0 && (
				<div className="pb-1">
					{breakdownRows.map((row) => (
						<div key={row.label} className="flex items-center gap-1.5 py-0.5">
							<span className={`h-1.5 w-1.5 flex-none rounded-full ${row.color}`} />
							<span className="min-w-0 flex-1 truncate">{row.label}</span>
							<span className="flex-none text-owl-faint">{row.percent.toFixed(1)}%</span>
						</div>
					))}
				</div>
			)}
			{cacheHitRate !== null && (
				<div className="mt-1 flex items-center justify-between border-t border-owl-border pt-1.5">
					<span>{t("composer.cacheHitRate")}</span>
					<span className="text-owl-faint">{cacheHitRate.toFixed(1)}%</span>
				</div>
			)}
			{sessionInfo.stats && (
				<>
					<p className="pt-1.5 pb-1 text-owl-text">{t("composer.sessionTotals")}</p>
					<p className="text-owl-faint">
						{t("composer.statsTokens", {
							input: formatTokens(sessionInfo.stats.tokens.input),
							output: formatTokens(sessionInfo.stats.tokens.output),
							cache: formatTokens(sessionInfo.stats.tokens.cacheRead + sessionInfo.stats.tokens.cacheWrite),
						})}
					</p>
					<p className="text-owl-faint">
						{t("composer.statsCost", { total: formatTokens(sessionInfo.stats.tokens.total), cost: sessionInfo.stats.cost.toFixed(4) })}
					</p>
				</>
			)}
			{onOpenContext && <button type="button" className="mt-1.5 flex w-full items-center justify-between rounded-lg border border-owl-border px-2.5 py-1.5 text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text" onClick={() => { onOpenContext(); }}>
				<span>{t("composer.contextPanelOpen")}</span>
				<span className="text-[10px] text-owl-faint">Ctrl+Alt+B</span>
			</button>}
		</div>
	) : (
		<p className="px-3 py-2 text-xs text-owl-faint">{t("composer.contextEmptyHint")}</p>
	);

	const hasDraft = value.trim().length > 0 || pendingImages.length > 0 || attachedPaths.length > 0;
	const action: ComposerAction = running
		? onPause ? "pause" : "abort"
		: paused && !hasDraft && onResume
			? "resume"
			: "send";
	const actionLabel = action === "pause" ? "composer.pause" : action === "abort" ? "composer.abort" : action === "resume" ? "composer.resume" : paused && hasDraft ? "composer.sendAndResume" : "composer.send";
	// 发不出去时告诉用户为什么（悬停/读屏），别让禁用按钮哑着。
	// 只作用于 send/resume：pause/abort 在运行中必须保持原语义可用。
	const sendBlockReason = action === "pause" || action === "abort"
		? undefined
		: !connected
			? t("composer.blockedOffline")
			: modelSelection?.status === "pending"
				? t("composer.blockedModel")
				: disabled || sending
					? t("composer.blockedBusy")
					: undefined;

	/** 预设 / 审批模式 / 模型：收在吉祥物弹出的面板里，输入框下方不再单占一行。 */
	const settingsPanel = (): React.JSX.Element => (
		<div className="owl-settings-panel">
			<p className="owl-settings-panel-title">{t("composer.settingsPanel")}</p>
			{agentPresets && agentPresets.length > 0 && onAgentPresetSelect && (
			<div className="owl-settings-panel-row">
				<span className="owl-settings-panel-label">{t("composer.settingsPreset")}</span>
				<Menu
					triggerClassName={ghostPillClass}
					triggerTitle={`${t("composer.preset.aria")}${activePreset ? ` · ${activePreset.name}` : ""}`}
					panelClassName="owl-composer-menu right-0 w-80"
					trigger={
						<>
							{activePreset ? (
								<PresetAvatar preset={activePreset} />
							) : (
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 shrink-0 text-owl-faint">
									<path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
								</svg>
							)}
							<span className="owl-composer-label flex-1 text-left">
								{activePreset?.name ?? t("composer.preset.menuTitle")}
							</span>
							<Chevron />
						</>
					}
				>
					{(close) => (
						<div>
							<div className="px-3 pb-1.5 pt-2">
								<p className="text-xs font-semibold text-owl-text">{t("composer.preset.menuTitle")}</p>
								<p className="mt-0.5 text-[10.5px] leading-snug text-owl-faint">{t("composer.preset.menuDesc")}</p>
							</div>
							{agentPresets.map((preset) => {
								const disabledReason = agentPresetDisabledReasons && Object.hasOwn(agentPresetDisabledReasons, preset.id) ? agentPresetDisabledReasons[preset.id] : undefined;
								return (
								<button
									key={preset.id}
									type="button"
									disabled={Boolean(disabledReason)}
									title={disabledReason}
									className={`${menuItemClass} items-start disabled:cursor-not-allowed disabled:opacity-50 ${preset.id === agentPreset ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
									onClick={() => {
										onAgentPresetSelect(preset.id);
										close();
									}}
								>
									<span className="mt-0.5">
										<PresetAvatar preset={preset} />
									</span>
									<span className="flex-1">
										<span className="flex items-center gap-1.5">
											<span className="font-medium">{preset.name}</span>
											{preset.id === defaultPresetId && (
												<span className="rounded bg-owl-accent/12 px-1.5 py-px text-[9px] font-semibold text-owl-accent">
													{t("composer.preset.defaultBadge")}
												</span>
											)}
											{!preset.builtin && (
												<span className="rounded bg-owl-faint/15 px-1.5 py-px text-[9px] text-owl-muted">
													{t("composer.preset.customBadge")}
												</span>
											)}
											<span className="text-[9px] tracking-wide text-owl-faint">{preset.id}</span>
										</span>
										<span className="mt-0.5 block text-[10.5px] leading-snug text-owl-faint">{preset.description}</span>
										{disabledReason && <span className="mt-1 block text-[10.5px] leading-snug text-owl-muted">{disabledReason}</span>}
									</span>
									{preset.id === agentPreset && <span className="mt-0.5 text-owl-accent">✓</span>}
								</button>
							);
							})}
							{agentPresetLocked && (
								<p className="flex items-start gap-1.5 border-t border-owl-border px-3 pb-2.5 pt-2 text-[10px] leading-snug text-owl-faint">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-px h-2.5 w-2.5 shrink-0">
										<rect x="4" y="10" width="16" height="10" rx="2" />
										<path d="M8 10V7a4 4 0 0 1 8 0v3" />
									</svg>
									{t("composer.preset.locked")}
								</p>
							)}
						</div>
					)}
				</Menu>
			</div>
			)}
			<div className="owl-settings-panel-row">
			<span className="owl-settings-panel-label">{t("composer.settingsMode")}</span>
			<Menu
				triggerClassName={ghostPillClass}
				triggerTitle={activeMode ? t(activeMode.titleKey) : undefined}
				panelClassName="owl-composer-menu right-0 w-64"
				trigger={
					<>
						<ModeIcon mode={approvalMode} active={approvalMode !== "confirm"} />
						<span className={`owl-composer-label flex-1 text-left${approvalMode === "auto" ? " text-owl-warning" : ""}`}>
							{activeMode ? t(activeMode.labelKey) : approvalMode}
						</span>
						<Chevron />
					</>
				}
			>
				{(close) => (
					<div>
						{APPROVAL_MODES.map((entry) => (
							<button
								key={entry.value}
								type="button"
								className={`${menuItemClass} ${entry.value === approvalMode ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
								title={t(entry.titleKey)}
								onClick={() => {
									onApprovalMode(entry.value);
									close();
								}}
							>
								<ModeIcon mode={entry.value} active={entry.value === approvalMode} />
								<span className="flex-1">{t(entry.labelKey)}</span>
								{entry.value === approvalMode && <span className="text-owl-accent">✓</span>}
							</button>
						))}
					</div>
				)}
			</Menu>
			</div>
			<div className="owl-settings-panel-row">
				<span className="owl-settings-panel-label">{t("composer.settingsModel")}</span>
				<ModelPickerMenu
					providers={providers}
					model={model}
					levels={levels}
					thinkingLevel={thinkingLevel}
					thinkingDisabled={thinkingDisabled}
					onModel={onModel}
					onThinkingLevel={onThinkingLevel}
				/>
			</div>
			<div className="owl-composer-prediction-setting">
				<label htmlFor={predictionSettingId} title={predictionText("settingHint")}>{predictionText("setting")}</label>
				<button
					type="button"
					id={predictionSettingId}
					role="switch"
					aria-label={predictionText("setting")}
					aria-checked={prediction.enabled}
					title={predictionText("settingHint")}
					className="owl-composer-prediction-switch"
					onClick={() => prediction.setEnabled(!prediction.enabled)}
				>
					<span />
				</button>
			</div>
		</div>
	);

	const thinkingName = THINKING_LABELS[thinkingLevel] ? t(THINKING_LABELS[thinkingLevel]) : thinkingLevel;
	const settingsSummary = [
		activePreset?.name,
		activeMode ? t(activeMode.labelKey) : approvalMode,
		`${modelDisplayName(providers, model, t("composer.defaultModel"))} · ${thinkingName}`,
	].filter(Boolean).join(" · ");
	const settingsTitle = `${settingsSummary}\n${approvalMode === "auto" ? `${t("composer.owlAutoWarning")}\n` : ""}${t("composer.owlSettings")}`;
	const mascotHidden = hideMascot || questionPending;

	return (
		<div
			className="owl-composer-surface owl-composer-responsive px-3 pt-1 pb-2"
			ref={dropZoneRef}
			onDragOver={(event) => {
				if (!transferHasFiles(event.dataTransfer)) return;
				event.preventDefault();
				setDragOver(true);
				setDragCount(event.dataTransfer.items?.length ?? 0);
			}}
			onDragLeave={(event) => {
				if (dropZoneRef.current?.contains(event.relatedTarget as Node)) return;
				setDragOver(false);
				setDragCount(0);
			}}
			onDrop={(event) => {
				if (!transferHasFiles(event.dataTransfer)) return;
				event.preventDefault();
				setDragOver(false);
				setDragCount(0);
				// 系统拖放和网页 drop 可能接连各来一次，800ms 内以系统路径为准。
				if (Date.now() - nativeDropAt.current < 800) return;
				const files = Array.from(event.dataTransfer.files);
				const classified = classifyHtmlDrop(
					files.map((file) => ({ name: file.name, type: file.type, path: filePathOf(file) })),
					event.dataTransfer.getData("text/uri-list"),
				);
				const imageFiles = classified.imageIndexes.flatMap((index) => {
					const file = files[index];
					return file ? [file] : [];
				});
				if (imageFiles.length > 0) addImageFiles(imageFiles);
				if (classified.attachmentPaths.length > 0) addAttachmentPaths(classified.attachmentPaths);
				if (classified.unnamedCount > 0) showHint(t("composer.dropNoPath", { count: classified.unnamedCount }));
			}}
		>
			<div className="owl-composer-column mx-auto max-w-3xl">
				{/* 环境行：搭在对话框上方（Claude 同款，与盒子左缘对齐） */}
				{!hideEnvironment && <div className="owl-composer-environment flex flex-wrap items-center gap-1 px-0.5 pb-1" data-has-mascot={!mascotHidden || undefined}>
					<Menu
						triggerClassName={envChipClass}
						triggerTitle={connected ? t("composer.runLocationLocalConnected") : t("composer.runLocationLocalDisconnected")}
						panelClassName="owl-composer-menu left-0 w-64"
						trigger={
							<>
								<LocalEnvironmentIcon tone={connected ? "text-owl-accent" : "text-owl-danger"} />
								<span>{t("composer.runLocation.local")}</span>
							</>
						}
					>
						{() => (
							<div>
								<p className="px-3 pt-2 pb-1 text-[10px] tracking-wide text-owl-faint uppercase">{t("composer.runLocation.title")}</p>
								<button type="button" className={`${menuItemClass} bg-owl-hover text-owl-text`}>
									<LocalEnvironmentIcon tone="text-owl-text" />
									<span className="flex-1">{t("composer.runLocation.localFull")}</span>
									{connected ? (
										<span className="flex items-center gap-1 text-[10px] text-owl-success">
											<span className="h-1.5 w-1.5 rounded-full bg-owl-success" />
											{t("composer.connected")}
										</span>
									) : (
										<span className="flex items-center gap-1 text-[10px] text-owl-danger">
											<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-owl-danger" />
											{t("composer.reconnecting")}
										</span>
									)}
								</button>
								<button type="button" className={`${menuItemClass} cursor-default text-owl-faint/60`} title={t("composer.featureInDevelopment")} disabled>
									<CloudIcon />
									<span className="flex-1">{t("composer.remoteSessions")}</span>
									<span className="text-[10px] text-owl-faint/70">{t("composer.inDevelopment")}</span>
								</button>
							</div>
						)}
					</Menu>
					{workspaceSelected ? (
						<div className="owl-composer-project flex items-center gap-0.5">
							<Menu
								triggerClassName={envChipClass}
								triggerTitle={t("composer.projectChipTitle", { dir: workspaceDir })}
								panelClassName="owl-composer-menu left-0 w-64"
								trigger={
									<>
										<FolderIcon />
										<span className="owl-composer-label max-w-40 truncate">{getProjectDisplayName(workspaceDir)}</span>
										<Chevron />
									</>
								}
							>
								{projectMenu}
							</Menu>
							{onClearProject && (
								<button
									type="button"
									className={envChipClearClass}
									title={t("composer.clearProject")}
									aria-label={t("composer.clearProject")}
									onClick={onClearProject}
								>
									✕
								</button>
							)}
						</div>
					) : (
						<Menu
							triggerClassName={envChipClass}
							triggerTitle={t("composer.projectChooseTitle")}
							panelClassName="owl-composer-menu left-0 w-64"
							trigger={
								<>
									<FolderIcon />
									<span className="owl-composer-label max-w-40 truncate">{t("composer.projectChoose")}</span>
									<Chevron />
								</>
							}
						>
							{projectMenu}
						</Menu>
					)}
					<button
						type="button"
						className={envIconButtonClass}
						title={t("composer.newProjectTitle")}
						aria-label={t("composer.newProjectAria")}
						onClick={() => setShowNewProject(true)}
					>
						<FolderPlusIcon />
					</button>
					{environmentAccessory && <div className="owl-composer-environment-accessory">{environmentAccessory}</div>}
				</div>}
				<ComposerMaterials key={attachmentOwner} images={pendingImages} files={chipEntries} onPreview={(image) => setZoomedImage(pendingImages.find((pending) => pending.id === image.id) ?? null)} onRemoveImage={(id) => {
					setPendingImages((current) => current.filter((image) => image.id !== id));
					editorRef.current?.focus({ preventScroll: true });
				}} onRemoveFile={removeAttachment} />
				{/* 输入框本体：Claude 同款单行小盒，输入与发送同行，随内容自动长高；吉祥物蹲在右上角沿口 */}
				<div
					className={"owl-composer-input relative rounded-xl border border-owl-border bg-owl-panel shadow-sm shadow-black/10 transition-colors focus-within:border-owl-accent/70" + (dragOver ? " border-owl-accent" : "")}
					ref={inputBoxRef}
					data-running={running && !paused || undefined}
					data-question-pending={questionPending || undefined}
				data-drag-over={dragOver || undefined}
				>
					{dragOver && <div className="owl-composer-drop-hint" role="status">{dragCount > 0 ? t("composer.dropOverCount", { n: dragCount }) : t("composer.dropOverGeneric")}</div>}
					<ContextTank percent={percent} />
					<svg className="owl-composer-runtime-beam" aria-hidden="true">
						<rect className="owl-composer-beam-tail" x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="12" pathLength="100" />
						<rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="12" pathLength="100" />
					</svg>
					<span className="owl-composer-send-glint" aria-hidden="true" />
					<OwlMascot
						pose={owlPose}
						hidden={mascotHidden}
						title={settingsTitle}
						alert={approvalMode === "auto"}
						panel={settingsPanel}
						panelLabel={t("composer.settingsPanel")}
					/>
					{slashExec !== null && (
						<div
							ref={slashMenuRef}
							className="owl-menu-panel absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-owl-border bg-owl-panel py-1 shadow-xl shadow-black/50"
						>
							{slashOpen ? (
								slashItems.map((entry, index) => (
									<button
										key={`${entry.kind}:${entry.name}`}
										type="button"
										data-active={index === slashActive || undefined}
										className={`${menuItemClass} ${index === slashActive ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
										title={entry.description}
										onMouseDown={(event) => event.preventDefault()}
										onMouseMove={() => setSlashIndex(index)}
										onClick={() => acceptSlashCommand(entry)}
									>
										<span className="shrink-0 font-mono text-[11px] text-owl-accent/90">/{entry.name}</span>
										{entry.argumentHint && (
											<span className="shrink-0 font-mono text-[10px] text-owl-faint">{entry.argumentHint}</span>
										)}
										<span className="flex-1 truncate text-left">{entry.description}</span>
										<span className="shrink-0 text-[10px] text-owl-faint">{t(SLASH_KIND_LABELS[entry.kind])}</span>
									</button>
								))
							) : (
								<p className="px-3 py-2 text-xs text-owl-faint">{t("composer.noMatchingCommands")}</p>
							)}
						</div>
					)}
					{pasteHint && <p className="relative px-2.5 pt-1 text-[11px] text-owl-warning">{pasteHint}</p>}
					{mentionOpen && (
						<div
							ref={mentionMenuRef}
							className="owl-mention-menu"
							role="listbox"
							aria-label="同步附文件"
						>
							{mentionItems.length === 0 ? (
								<p className="owl-mention-menu__empty">{t("composer.mentionNoMatches")}</p>
							) : (
								mentionItems.map((hit, index) => {
									const active = index === mentionIndex;
									return (
										<div
											key={hit.path}
											role="option"
											aria-selected={active}
											data-active={active || undefined}
											className="owl-mention-menu__row"
											onMouseDown={(event) => event.preventDefault()}
											onMouseMove={() => setMentionIndex(index)}
											onClick={() => acceptMention(hit)}
										>
											<small>{hit.path}</small>
										</div>
									);
								})
							)}
							{mentionItems.length > 0 && (
								<p className="owl-mention-menu__empty">
									{t("composer.mentionCount", { n: mentionItems.length })} · {t("composer.mentionHint")}
								</p>
							)}
						</div>
					)}
					<div className="owl-composer-input-row relative flex items-end gap-1.5 px-1.5 py-1">
						<Menu
							triggerClassName={`owl-context-gauge ${contextTone(percent)}`}
							triggerTitle={t("composer.viewContext") + (percent !== null ? ` · ${Math.round(percent)}%` : "")}
							panelClassName="owl-composer-menu left-0 w-72"
							trigger={
								<>
									<ContextRing percent={percent} />
									<span>{contextTokens !== null ? formatTokens(contextTokens) : sessionInfo?.contextUsage ? "—" : "0"}</span>
									{contextWindow ? <span className="owl-context-gauge__capacity">/ {formatTokens(contextWindow)}</span> : null}
									{percent !== null && percent >= 60 ? <span className="owl-context-gauge__percent">{Math.round(percent)}%</span> : null}
									{running && turnRate ? <span className="owl-context-gauge__rate">{t(turnRate.estimated ? "chat.activityTpsEstimated" : "chat.activityTps", { n: formatTokens(Math.floor(turnRate.tps)) })}</span> : null}
								</>
							}
						>
							{contextDetails}
						</Menu>
						<div className="owl-composer-draft min-w-0 flex-1" data-prediction={Boolean(suggestion) || undefined}>
							<span className="owl-composer-accept-glint" aria-hidden="true" />
							<div
								ref={editorRef}
								className="owl-composer-editor max-h-48 flex-1 text-owl-text outline-none"
								role="textbox"
								aria-multiline="true"
								aria-label={t("composer.inputAria")}
								aria-description={suggestion ? predictionText("hint") : undefined}
								data-placeholder={suggestion ?? (!connected ? t("composer.disconnectedPlaceholder") : questionPending ? t("composer.questionPendingPlaceholder") : running ? executionCopy("queuePlaceholder") : t("composer.inputPlaceholder"))}
								data-prediction={Boolean(suggestion) || undefined}
								contentEditable
								suppressContentEditableWarning
								spellCheck={false}
								onCompositionStart={() => { composing.current = true; }}
								onCompositionEnd={() => { composing.current = false; }}
								onPaste={onClipboardPaste}
								onInput={() => {
									prediction.dismiss();
									const next = syncEditorToValue(editorRef.current);
									setDraftValue(next);
									setSlashDismissed(false);
									setSlashIndex(0);
								}}
								onKeyDown={(event) => {
									if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
									// ↑ 召回：只在未开菜单、且（输入为空或正在浏览历史）时接管；↓ 在浏览中往回走。
									const recallBrowsing = recallIndex.current >= 0;
									if (event.key !== "ArrowUp" && event.key !== "ArrowDown") recallIndex.current = -1;
									else if (!mentionOpen && !slashOpen && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && recallHistory.length > 0) {
										const empty = (editorRef.current?.textContent ?? "").trim() === "";
										if (event.key === "ArrowUp" && (recallBrowsing || empty)) {
											event.preventDefault();
											const next = recallBrowsing ? Math.min(recallIndex.current + 1, recallHistory.length - 1) : 0;
											if (next !== recallIndex.current) {
												recallIndex.current = next;
												clearEditorContent(editorRef.current);
												insertPlainText(editorRef.current, recallHistory[next]!);
											}
											return;
										}
										if (event.key === "ArrowDown" && recallBrowsing) {
											event.preventDefault();
											const next = recallIndex.current - 1;
											recallIndex.current = next;
											clearEditorContent(editorRef.current);
											if (next >= 0) insertPlainText(editorRef.current, recallHistory[next]!);
											return;
										}
									}
									if (suggestion && !mentionOpen && !slashOpen) {
										if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
											&& (event.key === "Tab" || event.key === "ArrowRight" || event.key === "Enter") && acceptSuggestion()) {
											event.preventDefault();
											return;
										}
										if (event.key === "Escape") {
											event.preventDefault();
											prediction.dismiss();
											return;
										}
									}
									if (mentionOpen) {
										if (event.key === "ArrowDown") {
											event.preventDefault();
											setMentionIndex((index) => Math.max(0, Math.min(mentionItems.length - 1, index + 1)));
											return;
										}
										if (event.key === "ArrowUp") {
											event.preventDefault();
											setMentionIndex((index) => Math.max(0, index - 1));
											return;
										}
										if (event.key === "Enter" && mentionItems.length > 0) {
											event.preventDefault();
											const picked = mentionItems[mentionIndex] ?? mentionItems[0];
											if (picked) acceptMention(picked);
											return;
										}
										if (event.key === "Tab" && mentionItems.length > 0) {
											event.preventDefault();
											const picked = mentionItems[mentionIndex] ?? mentionItems[0];
											if (picked) acceptMention(picked);
											return;
										}
										if (event.key === "Escape") {
											event.preventDefault();
											setMentionOpen(false);
											return;
										}
									}
									if (slashOpen) {
										if (event.key === "ArrowDown") {
											event.preventDefault();
											setSlashIndex((index) => (index + 1) % slashItems.length);
											return;
										}
										if (event.key === "ArrowUp") {
											event.preventDefault();
											setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
											return;
										}
										// Enter/Tab 选中命令；命令名已完整敲入时回车直接执行（省一次回车）
										if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
											event.preventDefault();
											const picked = slashItems[slashActive]!;
											acceptSlashCommand(picked);
											if (event.key === "Enter" && `/${picked.name}` === value.trim()) void submit();
											return;
										}
										if (event.key === "Escape") {
											event.preventDefault();
											setSlashDismissed(true);
											return;
										}
									}
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										if (running && (event.ctrlKey || event.metaKey)) void submit("steer");
										else if (action === "resume" && !disabled && !sending && modelSelection?.status !== "pending") onResume?.();
										else void submit(running ? "steer" : undefined);
									}
								}}
							/>
							{suggestion && (
								<span className="owl-composer-prediction-ghost" aria-hidden="true">{suggestion}</span>
							)}
							{suggestion && (
								<button
									type="button"
									className="owl-composer-prediction-accept"
									aria-label={predictionText("accept")}
									aria-keyshortcuts="Tab"
									title={`${suggestion}\n${predictionText("hint")}`}
									onMouseDown={(event) => event.preventDefault()}
									onClick={acceptSuggestion}
								>
									<kbd>Tab</kbd><span>{predictionText("acceptShort")}</span>
								</button>
							)}
						</div>
						<div className="owl-composer-trailing">
							{running && hasDraft && <Menu triggerClassName="owl-composer-settings-fallback" triggerTitle={executionCopy("delivery")} panelClassName="owl-composer-menu right-0 w-64" trigger={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5" aria-label={executionCopy("delivery")}><path d="m4 6 4 4 4-4" /></svg>}>
								{(close) => <div>
									<button type="button" className={menuItemClass} disabled={disabled || sending || modelSelection?.status === "pending"} title={executionCopy("steerHint")} onClick={() => { close(); void submit("steer"); }}>{executionCopy("steer")}</button>
									<button type="button" className={menuItemClass} disabled={disabled || sending || modelSelection?.status === "pending"} title={executionCopy("queueHint")} onClick={() => { close(); void submit("queue"); }}>{executionCopy("queue")}</button>
								</div>}
							</Menu>}
							{mascotHidden && (
								<Menu
									triggerClassName={`owl-composer-settings-fallback${approvalMode === "auto" ? " is-alert" : ""}`}
									triggerTitle={settingsTitle}
									panelClassName="owl-settings-fallback-panel right-0"
									trigger={
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-label={t("composer.settingsPanel")}>
											<path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
											<circle cx="16" cy="7" r="2" />
											<circle cx="8" cy="17" r="2" />
										</svg>
									}
								>
									{settingsPanel()}
								</Menu>
							)}
						</div>
						<button
							type="button"
							aria-label={t(actionLabel)}
							title={sendBlockReason ?? t(actionLabel)}
							aria-disabled={sendBlockReason ? true : undefined}
							className="owl-composer-action"
							disabled={(action === "send" || action === "resume") && (disabled || sending || modelSelection?.status === "pending" || (action === "send" && !hasDraft))}
							onClick={(event) => {
								if (action === "send") void submit(undefined, event.currentTarget);
								else if (action === "pause") onPause?.();
								else if (action === "resume") onResume?.();
								else onAbort();
							}}
						>
							<ComposerActionIcon action={action} />
						</button>
					</div>
				</div>
				<div className="owl-composer-feedback">
					<ModelSelectionNotice feedback={modelSelection} providers={providers} onRetry={onRetryModelSelection} />
					<AttachmentPreflightNotice checking={visibleAttachmentCheck?.checking ?? false} issues={visibleAttachmentCheck?.issues.filter((issue) => attachedPaths.includes(issue.path)) ?? []} onRemove={(path) => { removeAttachment(path); setAttachmentCheck((current) => current ? { ...current, issues: current.issues.filter((issue) => issue.path !== path) } : current); }} onRetry={() => {
				if (submitInFlight.current) return;
				submitInFlight.current = true; setSending(true);
				void verifyAttachedPaths([...attachedPaths], draftRevision.current).finally(() => { submitInFlight.current = false; if (mounted.current) setSending(false); });
					}} />
				</div>
			</div>
			{zoomedImage && pendingImages.length > 0 && (
				<ImageViewer images={pendingImages.map((image, index) => ({ src: `data:${image.mimeType};base64,${image.data}`, alt: t("chat.attachment", { n: index + 1 }) }))} index={Math.max(0, pendingImages.findIndex((image) => image.id === zoomedImage.id))} onIndexChange={(index) => setZoomedImage(pendingImages[index] ?? null)} onClose={() => setZoomedImage(null)} />
			)}
			{showNewProject && (
				<NewProjectDialog
					client={client}
					onClose={() => setShowNewProject(false)}
					onCreated={(path, name) => {
						restoreProject(path, sessionScope);
						if (name !== undefined) setProjectAlias(path, name);
						setShowNewProject(false);
						onSwitchProject(path);
					}}
				/>
			)}
		</div>
	);
}
