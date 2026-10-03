import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ApprovalMode, ProviderModelsMessage, SessionStatsResult, SlashCommandEntry } from "../bridge/protocol.ts";
import { getUiLanguage, t, useT, type TextKey } from "../i18n/index.ts";
import { Menu } from "./Menu.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { projectLabel, samePath } from "../utils/paths.ts";

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

/** 审批模式小图标（16 viewBox 线性风格，与思考/上下文图标同族）。 */
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
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
			<path d="M8 1.8 13.2 3.9v4.3c0 2.9-2.2 5.1-5.2 6-3-.9-5.2-3.1-5.2-6V3.9L8 1.8Z" />
			<path d="M5.9 8 7.5 9.6l2.6-2.9" />
		</svg>
	);
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

function contextTone(percent: number | null): string {
	if (percent === null) return "text-owl-faint";
	if (percent >= 85) return "text-red-400";
	if (percent >= 60) return "text-amber-400";
	return "text-emerald-400";
}

/** 上下文用量环形指示（套在上下文选择器左侧，随时可见余量）。 */
function ContextRing({ percent }: { percent: number | null }): React.JSX.Element {
	const clamped = Math.min(100, Math.max(0, percent ?? 0));
	const circumference = 2 * Math.PI * 6;
	return (
		<svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0">
			<circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-owl-border" />
			<circle
				cx="8"
				cy="8"
				r="6"
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				stroke="currentColor"
				className={contextTone(percent)}
				strokeDasharray={`${(circumference * clamped) / 100} ${circumference}`}
				transform="rotate(-90 8 8)"
			/>
		</svg>
	);
}

/** 笔记本：本地运行位置（对照 Claude 输入框的 Local chip）。 */
function LaptopIcon({ tone = "text-owl-faint" }: { tone?: string }): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
			<rect x="3" y="2.8" width="10" height="7.2" rx="1.2" />
			<path d="M1.6 13h12.8" />
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
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0">
			<path d="M1.8 4c0-.66.54-1.2 1.2-1.2h2.9l1.5 1.7h5.6c.66 0 1.2.54 1.2 1.2v6.1c0 .66-.54 1.2-1.2 1.2H3c-.66 0-1.2-.54-1.2-1.2V4Z" />
			<path d="M8 7.2v3M6.5 8.7h3" />
		</svg>
	);
}

/** 空心文件夹：项目 chip 与项目菜单项。 */
function FolderIcon({ tone = "text-owl-faint" }: { tone?: string }): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className={`h-3.5 w-3.5 shrink-0 ${tone}`}>
			<path d="M1.8 4c0-.66.54-1.2 1.2-1.2h2.9l1.5 1.7h5.6c.66 0 1.2.54 1.2 1.2v6.1c0 .66-.54 1.2-1.2 1.2H3c-.66 0-1.2-.54-1.2-1.2V4Z" />
		</svg>
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
	"flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg bg-owl-hover/40 px-2.5 text-xs text-owl-muted " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-not-allowed disabled:opacity-40";

/** 环境行的纯图标 chip（添加项目）。 */
const envIconButtonClass =
	"flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-owl-hover/40 text-owl-muted " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text";

/**
 * 输入框底部选择器（精简 ghost 风）：无边框文字按钮，悬停才浮出底色。
 * 审批模式 / 思考强度 / 模型 / 上下文。
 */
const ghostPillClass =
	"flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs text-owl-faint " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

const menuItemClass = "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-owl-hover";

/** 斜杠命令菜单里的来源标签。 */
const SLASH_KIND_LABELS: Record<SlashCommandEntry["kind"], TextKey> = {
	builtin: "composer.slashKind.builtin",
	skill: "composer.slashKind.skill",
	prompt: "composer.slashKind.prompt",
	extension: "composer.slashKind.extension",
};

/** 随消息发送的图片附件（base64；与后端 ImageContent 同形）。 */
export type ComposerImage = { type: "image"; data: string; mimeType: string };

/** 待发送区里的附图：额外带本地 id 供列表 key 与单张移除。 */
type PendingImage = ComposerImage & { id: string };

/** 单张附图上限：10MB（base64 后约 13MB，远小于桥 WebSocket 上限；服务端会按模型输入限制再压缩）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 一条消息最多附图数。 */
const MAX_PROMPT_IMAGES = 8;

/** 剪贴板/拖入的文件按扩展名兜底识别图片（Windows 资源管理器复制的文件 type 可能为空）。 */
const IMAGE_EXT_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

function imageMimeOf(file: File): string | undefined {
	if (file.type.startsWith("image/")) return file.type;
	return IMAGE_EXT_MIME[file.name.split(".").pop()?.toLowerCase() ?? ""];
}

/** 把图片文件读成 base64；非图片或读取失败返回 undefined。 */
function readImageFile(file: File): Promise<{ data: string; mimeType: string } | undefined> {
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
			resolve({ data: result.slice(comma + 1), mimeType });
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
	onSend,
	onAbort,
	providers,
	model,
	onModel,
	thinkingLevel,
	onThinkingLevel,
	approvalMode,
	onApprovalMode,
	sessionInfo,
	workspaceDir,
	projects,
	onSwitchProject,
	commands,
	draftRequest,
}: {
	client: BridgeClient;
	/** 桥连接状态：本地 chip 上展示运行环境健康度。 */
	connected: boolean;
	disabled: boolean;
	running: boolean;
	onSend: (text: string, images?: ComposerImage[]) => void;
	onAbort: () => void;
	providers: ProviderModelsMessage[];
	model: string;
	onModel: (value: string) => void;
	thinkingLevel: string;
	onThinkingLevel: (level: string) => void;
	approvalMode: ApprovalMode;
	onApprovalMode: (mode: ApprovalMode) => void;
	sessionInfo: SessionStatsResult | undefined;
	/** 当前项目（工作目录）绝对路径。 */
	workspaceDir: string;
	/** 候选项目列表（与侧边栏同源：当前 ∪ 有会话 ∪ 到访过）。 */
	projects: string[];
	/** 切换项目 = 换工作目录并从新会话开始（与侧边栏点击项目同语义）。 */
	onSwitchProject: (path: string) => void;
	/** 斜杠命令清单（桥端 commands.list）：输入 "/" 时自动补全。 */
	commands: SlashCommandEntry[];
	/** Start-page examples fill a draft without submitting or replacing existing text. */
	draftRequest?: { id: number; text: string };
}): React.JSX.Element {
	const t = useT();
	const [value, setValue] = useState("");
	const [showNewProject, setShowNewProject] = useState(false);
	// 待发送附图：Ctrl+V 粘贴或拖入图片先进这里，随下一条消息一起发出。
	const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
	const [pasteHint, setPasteHint] = useState<string | undefined>(undefined);
	const [dragOver, setDragOver] = useState(false);
	const hintTimerRef = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(hintTimerRef.current), []);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const inputBoxRef = useRef<HTMLDivElement>(null);
	const slashMenuRef = useRef<HTMLDivElement>(null);
	// 斜杠命令菜单：整段输入还是单个 "/命令" token（没敲出空格）时弹出；
	// Esc 关闭后要等输入变化才重开，避免关不掉。
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	useEffect(() => {
		if (!draftRequest) return;
		setValue((current) => current.trim() ? `${current}\n\n${draftRequest.text}` : draftRequest.text);
		setSlashDismissed(true);
		textareaRef.current?.focus();
	}, [draftRequest]);
	const submit = (): void => {
		if (disabled) return;
		const text = value.trim();
		if (!text && pendingImages.length === 0) return;
		onSend(text, pendingImages.length > 0 ? pendingImages : undefined);
		setValue("");
		setPendingImages([]);
	};

	// 附图提示自动消退（超限/超大时给一句人话反馈，不打断输入）。
	const showHint = (text: string): void => {
		setPasteHint(text);
		window.clearTimeout(hintTimerRef.current);
		hintTimerRef.current = window.setTimeout(() => setPasteHint(undefined), 4000);
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
				image ? { id: `img-${++imageSeq}`, type: "image" as const, data: image.data, mimeType: image.mimeType } : [],
			);
			if (next.length > 0) setPendingImages((current) => [...current, ...next].slice(0, MAX_PROMPT_IMAGES));
		});
	};

	const onClipboardPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
		const files: File[] = [];
		for (const item of Array.from(event.clipboardData.items)) {
			if (item.kind !== "file") continue;
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		// 有图片文件时拦下默认行为（否则粘贴图片会把路径/乱码文本塞进输入框）；
		// 纯文本粘贴不受影响。
		if (files.length > 0) {
			event.preventDefault();
			addImageFiles(files);
		}
	};

	// 单行起步、随内容自动长高（Claude 同款）；上限 192px 与 max-h-48 一致，发送后随 value 清空缩回。
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
	}, [value]);

	// 斜杠过滤：前缀命中排前，其次子串；上限 30 条防长清单卡顿。
	// exec 不命中返回 null（≠ undefined），用 null 判「不在输入命令」。
	const slashExec = slashDismissed ? null : /^\/([a-zA-Z0-9:_-]*)$/.exec(value);
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

	const acceptSlashCommand = (entry: SlashCommandEntry): void => {
		// 填入命令留个空格：想带参数直接打字，不带就回车执行（此时菜单已因空格自动收起）
		setValue(`/${entry.name} `);
		setSlashDismissed(false);
		setSlashIndex(0);
		textareaRef.current?.focus();
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
	const activeName =
		providers
			.find((provider) => provider.id === activeProvider)
			?.models.find((entry) => entry.id === activeModelId)?.name ?? (activeModelId || t("composer.defaultModel"));
	const percent = sessionInfo?.contextUsage?.percent ?? null;
	const contextTokens = sessionInfo?.contextUsage?.tokens ?? null;
	const contextWindow = sessionInfo?.contextUsage?.contextWindow;
	const levels = sessionInfo && sessionInfo.availableThinkingLevels.length > 0
		? sessionInfo.availableThinkingLevels
		: [...ALL_THINKING_LEVELS];
	const thinkingDisabled = sessionInfo !== undefined && !sessionInfo.supportsThinking;

	// 项目选择器排序：当前项目置顶，其余按名称；显示名取路径末段。
	const sortedProjects = [...projects].sort((a, b) => {
		const aCurrent = samePath(a, workspaceDir);
		const bCurrent = samePath(b, workspaceDir);
		if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
		return projectLabel(a).localeCompare(projectLabel(b), getUiLanguage() === "en" ? "en" : "zh-CN");
	});

	const activeMode = APPROVAL_MODES.find((entry) => entry.value === approvalMode);

	const modelMenu = (close: () => void): React.JSX.Element => (
		<div className="max-h-72 w-72 overflow-y-auto">
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
							<button
								key={entry.id}
								type="button"
								className={`${menuItemClass} ${active ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
								onClick={() => {
									onModel(value);
									close();
								}}
							>
								<span className="flex-1 truncate">
									{entry.name}
									{entry.contextWindow ? (
										<span className="ml-1.5 text-owl-faint">{Math.round(entry.contextWindow / 1000)}k</span>
									) : null}
								</span>
								{entry.reasoning ? <span className="text-[10px] text-owl-accent/80">{t("composer.reasoningBadge")}</span> : null}
								{active && <span className="text-owl-accent">✓</span>}
							</button>
						);
					})}
				</div>
			))}
		</div>
	);

	return (
		<div className="owl-composer-surface px-4 pt-2 pb-4">
			<div className="mx-auto max-w-3xl">
				{/* 环境行：搭在对话框上方（Claude 同款，与盒子左缘对齐） */}
				<div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
					<Menu
						triggerClassName={envChipClass}
						triggerTitle={connected ? t("composer.runLocationLocalConnected") : t("composer.runLocationLocalDisconnected")}
						panelClassName="w-64"
						trigger={
							<>
								<LaptopIcon tone={connected ? "text-owl-accent" : "text-red-400"} />
								<span>{t("composer.runLocation.local")}</span>
							</>
						}
					>
						{() => (
							<div>
								<p className="px-3 pt-2 pb-1 text-[10px] tracking-wide text-owl-faint uppercase">{t("composer.runLocation.title")}</p>
								<button type="button" className={`${menuItemClass} bg-owl-hover text-owl-text`}>
									<LaptopIcon tone="text-owl-text" />
									<span className="flex-1">{t("composer.runLocation.localFull")}</span>
									{connected ? (
										<span className="flex items-center gap-1 text-[10px] text-emerald-400">
											<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
											{t("composer.connected")}
										</span>
									) : (
										<span className="flex items-center gap-1 text-[10px] text-red-400">
											<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
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
					<Menu
						triggerClassName={envChipClass}
						triggerTitle={t("composer.projectChipTitle", { dir: workspaceDir })}
						panelClassName="w-64"
						trigger={
							<>
								<FolderIcon />
								<span className="max-w-40 truncate">{projectLabel(workspaceDir)}</span>
								<Chevron />
							</>
						}
					>
						{(close) => (
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
												<span className="flex-1 truncate">{projectLabel(path)}</span>
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
						)}
					</Menu>
					<button
						type="button"
						className={envIconButtonClass}
						title={t("composer.newProjectTitle")}
						aria-label={t("composer.newProjectAria")}
						onClick={() => setShowNewProject(true)}
					>
						<FolderPlusIcon />
					</button>
				</div>
				{/* 输入框本体：Claude 同款单行小盒，输入与发送同行，随内容自动长高；吉祥物蹲在右上角沿口 */}
				<div
					className={"relative rounded-2xl border border-owl-border bg-owl-panel shadow-lg shadow-black/25 transition-colors focus-within:border-owl-accent/70" + (dragOver ? " border-owl-accent" : "")}
					ref={inputBoxRef}
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={(event) => {
						// 移到盒子内部子元素上也会触发 dragleave，relatedTarget 还在盒内就不收
						if (inputBoxRef.current?.contains(event.relatedTarget as Node)) return;
						setDragOver(false);
					}}
					onDrop={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						setDragOver(false);
						addImageFiles(Array.from(event.dataTransfer.files));
					}}
				>
					{slashExec !== null && (
						<div
							ref={slashMenuRef}
							className="absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-owl-border bg-owl-panel py-1 shadow-xl shadow-black/50"
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
					{/* 待发送附图：粘贴/拖入后悬在输入行上方（对齐 Claude/VS Code 的附件预览），可逐张移除 */}
					{pendingImages.length > 0 && (
						<div className="flex flex-wrap gap-2 px-3 pt-2.5">
							{pendingImages.map((image) => (
								<div key={image.id} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-owl-border bg-owl-sidebar">
									<img src={`data:${image.mimeType};base64,${image.data}`} alt="" className="h-full w-full object-cover" />
									<button
										type="button"
										aria-label={t("composer.removeImage")}
										title={t("composer.removeImage")}
										className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] leading-none text-white opacity-0 transition-opacity hover:bg-black focus-visible:opacity-100 group-hover:opacity-100"
										onClick={() => setPendingImages((current) => current.filter((entry) => entry.id !== image.id))}
									>
										✕
									</button>
								</div>
							))}
						</div>
					)}
					{pasteHint && <p className="px-3 pt-1.5 text-[11px] text-amber-400">{pasteHint}</p>}
					<div className="flex items-end gap-2 px-2 py-2">
						<textarea
							ref={textareaRef}
							className="max-h-48 min-h-[32px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm text-owl-text outline-none placeholder:text-owl-faint"
							aria-label={t("composer.inputAria")}
							placeholder={t("composer.inputPlaceholder")}
							value={value}
							rows={1}
							onPaste={onClipboardPaste}
							onChange={(event) => {
								setValue(event.target.value);
								setSlashDismissed(false);
								setSlashIndex(0);
							}}
							onKeyDown={(event) => {
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
										if (event.key === "Enter" && `/${picked.name}` === value.trim()) submit();
										return;
									}
									if (event.key === "Escape") {
										event.preventDefault();
										setSlashDismissed(true);
										return;
									}
								}
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									submit();
								}
							}}
						/>
						{running ? (
							<button
								type="button"
								aria-label={t("composer.abort")}
								title={t("composer.abort")}
								className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-owl-accent text-white transition-colors hover:bg-owl-accent-hover"
								onClick={onAbort}
							>
								<svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
									<rect x="2" y="2" width="8" height="8" rx="1" />
								</svg>
							</button>
						) : (
							<button
								type="button"
								aria-label={t("composer.send")}
								title={t("composer.send")}
								className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-owl-accent text-white transition-colors hover:bg-owl-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
								disabled={disabled}
								onClick={submit}
							>
								<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4">
									<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
								</svg>
							</button>
						)}
					</div>
				</div>
				{/* 选择行：搭在对话框下方（Claude 的 + Manual / 模型名同位） */}
				<div className="flex flex-wrap items-center gap-1 px-1 pt-2">
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle={activeMode ? t(activeMode.titleKey) : undefined}
						panelClassName="left-0 w-64"
						trigger={
							<>
								<ModeIcon mode={approvalMode} active={approvalMode !== "confirm"} />
								<span>{activeMode ? t(activeMode.labelKey) : approvalMode}</span>
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
					<div className="flex-1" />
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle={thinkingDisabled ? t("composer.thinkingUnsupported") : t("composer.thinkingTitle")}
						panelClassName="right-0 w-36"
						trigger={
							<>
								<svg
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.3"
									className={`h-3.5 w-3.5 shrink-0 ${thinkingDisabled ? "text-owl-faint" : "text-owl-accent"}`}
								>
									<path d="M8 1.5c2 2.2 4.5 3.8 4.5 7a4.5 4.5 0 1 1-9 0c0-3.2 2.5-4.8 4.5-7Z" />
									<circle cx="8" cy="9" r="1.6" fill="currentColor" stroke="none" />
								</svg>
								<span>{t("composer.thinkingChip", { level: THINKING_LABELS[thinkingLevel] ? t(THINKING_LABELS[thinkingLevel]) : thinkingLevel })}</span>
								<Chevron />
							</>
						}
					>
						{(close) => (
							<div>
								{levels.map((level) => (
									<button
										key={level}
										type="button"
										className={`${menuItemClass} ${level === thinkingLevel ? "bg-owl-hover text-owl-text" : "text-owl-muted"}`}
										onClick={() => {
											onThinkingLevel(level);
											close();
										}}
									>
										<span className="flex-1">{THINKING_LABELS[level] ? t(THINKING_LABELS[level]) : level}</span>
										{level === thinkingLevel && <span className="text-owl-accent">✓</span>}
									</button>
								))}
							</div>
						)}
					</Menu>
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle={t("composer.switchModel")}
						panelClassName="right-0 w-72"
						trigger={
							<>
								<span className="max-w-44 truncate">{activeName}</span>
								<Chevron />
							</>
						}
					>
						{(close: () => void) => modelMenu(close)}
					</Menu>
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle={t("composer.viewContext")}
						panelClassName="right-0 w-72"
						trigger={
							<>
								<ContextRing percent={percent} />
								<span className={percent !== null ? contextTone(percent) : undefined}>
									{percent !== null ? `${Math.round(percent)}%` : t("composer.context")}
								</span>
							</>
						}
					>
						{sessionInfo ? (
							<div className="w-full px-3 py-2 text-xs text-owl-muted">
								<p className="pb-1.5 text-owl-text">{t("composer.contextWindow")}</p>
								<div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-owl-hover">
									<div
										className={`h-full rounded-full ${
											(percent ?? 0) >= 85 ? "bg-red-500" : (percent ?? 0) >= 60 ? "bg-amber-500" : "bg-emerald-500"
										}`}
										style={{ width: `${Math.min(100, Math.max(2, percent ?? 0))}%` }}
									/>
								</div>
								<p className="pb-2 text-owl-faint">
									{contextTokens !== null ? formatTokens(contextTokens) : "—"}
									{contextWindow ? ` / ${formatTokens(contextWindow)}` : ""}
									{percent !== null ? ` · ${Math.round(percent)}%` : ""}
								</p>
								{sessionInfo.stats && (
									<>
										<p className="pb-1.5 text-owl-text">{t("composer.sessionTotals")}</p>
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
							</div>
						) : (
							<p className="px-3 py-2 text-xs text-owl-faint">{t("composer.contextEmptyHint")}</p>
						)}
					</Menu>
				</div>
			</div>
			{showNewProject && (
				<NewProjectDialog
					client={client}
					onClose={() => setShowNewProject(false)}
					onCreated={(path) => {
						setShowNewProject(false);
						onSwitchProject(path);
					}}
				/>
			)}
		</div>
	);
}
