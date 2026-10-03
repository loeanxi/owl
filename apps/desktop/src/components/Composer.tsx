import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ApprovalMode, ProviderModelsMessage, SessionStatsResult } from "../bridge/protocol.ts";
import { Menu } from "./Menu.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { projectLabel, samePath } from "../utils/paths.ts";

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const THINKING_LABELS: Record<string, string> = {
	off: "关闭",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最高",
};

/** 审批模式三档：标准（逐次确认）/ 计划（只读工具做调研）/ 自动（全自动）。 */
const APPROVAL_MODES: { value: ApprovalMode; label: string; title: string }[] = [
	{ value: "confirm", label: "标准模式", title: "标准：每次工具调用前人工确认" },
	{ value: "plan", label: "计划模式", title: "计划：只允许只读工具（read / ls / find / grep）调研并产出计划" },
	{ value: "auto", label: "自动模式", title: "自动：全自动执行，工具调用不再确认" },
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
	"flex h-7 items-center gap-1.5 rounded-lg bg-owl-hover/40 px-2.5 text-xs text-owl-muted " +
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
	"flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-owl-faint " +
	"transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

const menuItemClass = "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-owl-hover";

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
}: {
	client: BridgeClient;
	/** 桥连接状态：本地 chip 上展示运行环境健康度。 */
	connected: boolean;
	disabled: boolean;
	running: boolean;
	onSend: (text: string) => void;
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
}): React.JSX.Element {
	const [value, setValue] = useState("");
	const [showNewProject, setShowNewProject] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const submit = (): void => {
		const text = value.trim();
		if (!text) return;
		onSend(text);
		setValue("");
	};

	// 单行起步、随内容自动长高（Claude 同款）；上限 192px 与 max-h-48 一致，发送后随 value 清空缩回。
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
	}, [value]);

	const slash = model.indexOf("/");
	const activeProvider = slash > 0 ? model.slice(0, slash) : undefined;
	const activeModelId = slash > 0 ? model.slice(slash + 1) : undefined;
	const activeName =
		providers
			.find((provider) => provider.id === activeProvider)
			?.models.find((entry) => entry.id === activeModelId)?.name ?? (activeModelId || "默认模型");
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
		return projectLabel(a).localeCompare(projectLabel(b), "zh-CN");
	});

	const modelMenu = (close: () => void): React.JSX.Element => (
		<div className="max-h-72 w-72 overflow-y-auto">
			{providers.length === 0 && <p className="px-3 py-2 text-xs text-owl-faint">无可用模型（先配置凭据）</p>}
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
								{entry.reasoning ? <span className="text-[10px] text-owl-accent/80">思考</span> : null}
								{active && <span className="text-owl-accent">✓</span>}
							</button>
						);
					})}
				</div>
			))}
		</div>
	);

	return (
		<div className="bg-owl-bg px-4 pt-2 pb-4">
			<div className="mx-auto max-w-3xl">
				{/* 环境行：搭在对话框上方（Claude 同款，与盒子左缘对齐） */}
				<div className="flex items-center gap-1.5 px-1 pb-2">
					<Menu
						triggerClassName={envChipClass}
						triggerTitle={connected ? "运行位置：本地（已连接）" : "运行位置：本地（连接断开）"}
						panelClassName="w-64"
						trigger={
							<>
								<LaptopIcon tone={connected ? "text-owl-accent" : "text-red-400"} />
								<span>本地</span>
							</>
						}
					>
						{() => (
							<div>
								<p className="px-3 pt-2 pb-1 text-[10px] tracking-wide text-owl-faint uppercase">运行位置</p>
								<button type="button" className={`${menuItemClass} bg-owl-hover text-owl-text`}>
									<LaptopIcon tone="text-owl-text" />
									<span className="flex-1">本地（此电脑）</span>
									{connected ? (
										<span className="flex items-center gap-1 text-[10px] text-emerald-400">
											<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
											已连接
										</span>
									) : (
										<span className="flex items-center gap-1 text-[10px] text-red-400">
											<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
											重连中
										</span>
									)}
								</button>
								<button type="button" className={`${menuItemClass} cursor-default text-owl-faint/60`} title="该功能开发中" disabled>
									<CloudIcon />
									<span className="flex-1">远程会话</span>
									<span className="text-[10px] text-owl-faint/70">开发中</span>
								</button>
							</div>
						)}
					</Menu>
					<Menu
						triggerClassName={envChipClass}
						triggerTitle={`项目：${workspaceDir}（点击切换）`}
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
								<p className="px-3 pt-2 pb-1 text-[10px] tracking-wide text-owl-faint uppercase">项目（工作目录）</p>
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
										<p className="px-3 py-2 text-xs text-owl-faint">尚无项目</p>
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
									<span className="flex-1">新建项目…</span>
								</button>
							</div>
						)}
					</Menu>
					<button
						type="button"
						className={envIconButtonClass}
						title="新建项目（选择或输入目录，不存在会自动创建）"
						aria-label="新建项目"
						onClick={() => setShowNewProject(true)}
					>
						<FolderPlusIcon />
					</button>
				</div>
				{/* 输入框本体：Claude 同款单行小盒，输入与发送同行，随内容自动长高；吉祥物蹲在右上角沿口 */}
				<div className="relative rounded-2xl border border-owl-border bg-owl-panel shadow-lg shadow-black/25 transition-colors focus-within:border-owl-accent/70">
					<img
						src="/owl.svg"
						alt=""
						aria-hidden="true"
						draggable={false}
						className="pointer-events-none absolute -top-5 right-3 z-10 h-8 w-8 select-none drop-shadow-[0_3px_3px_rgba(0,0,0,0.45)]"
					/>
					<div className="flex items-end gap-2 px-2 py-2">
						<textarea
							ref={textareaRef}
							className="max-h-48 min-h-[32px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm text-owl-text outline-none placeholder:text-owl-faint"
							placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
							value={value}
							rows={1}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									submit();
								}
							}}
						/>
						{running ? (
							<button
								type="button"
								aria-label="中止"
								title="中止"
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
								aria-label="发送"
								title="发送"
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
				<div className="flex items-center gap-1 px-1 pt-2">
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle={APPROVAL_MODES.find((entry) => entry.value === approvalMode)?.title}
						panelClassName="left-0 w-64"
						trigger={
							<>
								<ModeIcon mode={approvalMode} active={approvalMode !== "confirm"} />
								<span>{APPROVAL_MODES.find((entry) => entry.value === approvalMode)?.label ?? approvalMode}</span>
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
										title={entry.title}
										onClick={() => {
											onApprovalMode(entry.value);
											close();
										}}
									>
										<ModeIcon mode={entry.value} active={entry.value === approvalMode} />
										<span className="flex-1">{entry.label}</span>
										{entry.value === approvalMode && <span className="text-owl-accent">✓</span>}
									</button>
								))}
							</div>
						)}
					</Menu>
					<div className="flex-1" />
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle={thinkingDisabled ? "当前模型不支持思考" : "调整思考强度"}
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
								<span>思考·{THINKING_LABELS[thinkingLevel] ?? thinkingLevel}</span>
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
										<span className="flex-1">{THINKING_LABELS[level] ?? level}</span>
										{level === thinkingLevel && <span className="text-owl-accent">✓</span>}
									</button>
								))}
							</div>
						)}
					</Menu>
					<Menu
						triggerClassName={ghostPillClass}
						triggerTitle="切换模型"
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
						triggerTitle="查看上下文"
						panelClassName="right-0 w-72"
						trigger={
							<>
								<ContextRing percent={percent} />
								<span className={percent !== null ? contextTone(percent) : undefined}>
									{percent !== null ? `${Math.round(percent)}%` : "上下文"}
								</span>
							</>
						}
					>
						{sessionInfo ? (
							<div className="w-full px-3 py-2 text-xs text-owl-muted">
								<p className="pb-1.5 text-owl-text">上下文窗口</p>
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
										<p className="pb-1.5 text-owl-text">本次会话累计</p>
										<p className="text-owl-faint">
											输入 {formatTokens(sessionInfo.stats.tokens.input)} · 输出{" "}
											{formatTokens(sessionInfo.stats.tokens.output)} · 缓存{" "}
											{formatTokens(sessionInfo.stats.tokens.cacheRead + sessionInfo.stats.tokens.cacheWrite)}
										</p>
										<p className="text-owl-faint">
											合计 {formatTokens(sessionInfo.stats.tokens.total)} tokens · $
											{sessionInfo.stats.cost.toFixed(4)}
										</p>
									</>
								)}
							</div>
						) : (
							<p className="px-3 py-2 text-xs text-owl-faint">会话开始后可查看上下文用量</p>
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
