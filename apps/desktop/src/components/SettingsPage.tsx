import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type {
	ImageConfigGetResult,
	MemoryListResult,
	ProviderModelsMessage,
	SkillCenterEntry,
	SkillCenterTab,
	SkillsListResult,
	SkillsReadResult,
	SystemPromptPreviewResult,
	OwlImageConfigPublic,
	OwlImageProvider,
} from "../bridge/protocol.ts";
import { applyChatAppearance, DEFAULT_CHAT_APPEARANCE, parseChatAppearance, type ChatAppearance } from "../chat-appearance.ts";
import { isThemePreference, setThemePreference } from "../theme.ts";
import { getUiLanguage, parseUiLanguage, setUiLanguage, t, useT, type TextKey } from "../i18n/index.ts";
import { isTabKindEnabled, parseSidebarSettings, setSidebarConfig, type SidebarConfig } from "../sidebar/config.ts";
import { QUICK_ACTIONS } from "../sidebar/quick.tsx";
import { IconPanelRight } from "../sidebar/icons.tsx";
import { IconArchive, IconCode, IconCompose, IconImage, IconInfo, IconLightbulb, IconList, IconPlug, IconSettings, IconSliders, IconSun, IconTrash } from "./icons.tsx";
import "./settings-redesign.css";

const API_OPTIONS = [
	{ value: "openai-completions", labelKey: "settings.models.apiOpenaiCompat" },
	{ value: "anthropic-messages", labelKey: "settings.models.apiAnthropicCompat" },
	{ value: "openai-responses", labelKey: "settings.models.apiOpenaiResponses" },
] as const;

const CHAT_READING_FIELDS = [
	{ key: "fontSize", titleKey: "settings.general.fieldFontSize", descKey: "settings.general.fieldFontSizeDesc", min: 14, max: 22, step: 1, unit: "px" },
	{ key: "codeFontSize", titleKey: "settings.general.fieldCodeFontSize", descKey: "settings.general.fieldCodeFontSizeDesc", min: 11, max: 18, step: 1, unit: "px" },
	{ key: "lineHeight", titleKey: "settings.general.fieldLineHeight", descKey: "settings.general.fieldLineHeightDesc", min: 1.5, max: 2, step: 0.05, unitKey: "settings.general.unitLines" },
	{ key: "width", titleKey: "settings.general.fieldWidth", descKey: "settings.general.fieldWidthDesc", min: 640, max: 960, step: 1, unit: "px" },
] as const;

type SettingsSection = "general" | "models" | "plugins" | "skills" | "sidebar" | "prompts" | "memory" | "image" | "appearance" | "archived" | "json" | "about";

/** owl-image 的 provider 清单（顺序即下拉顺序；标签走 settings.image.p.* 字典）。 */
const OWL_IMAGE_PROVIDERS: readonly OwlImageProvider[] = [
	"google",
	"openai",
	"openai-compat",
	"seedream",
	"dashscope",
	"xai",
	"zhipu",
	"comfyui",
	"google-sub",
];

/** owl-image 的 BYOK provider（有 API key 输入行的子集）。 */
const OWL_IMAGE_BYOK: readonly Exclude<OwlImageProvider, "comfyui" | "google-sub">[] = ["google", "openai", "openai-compat", "seedream", "dashscope", "xai", "zhipu"];

const OWL_IMAGE_PROVIDER_LABEL_KEYS: Record<OwlImageProvider, TextKey> = {
	google: "settings.image.p.google",
	openai: "settings.image.p.openai",
	"openai-compat": "settings.image.p.openai-compat",
	seedream: "settings.image.p.seedream",
	dashscope: "settings.image.p.dashscope",
	xai: "settings.image.p.xai",
	zhipu: "settings.image.p.zhipu",
	comfyui: "settings.image.p.comfyui",
	"google-sub": "settings.image.p.google-sub",
};

/** 技能中心的 tab 元数据：与 skills.list 的三级根一一对应（label/desc 为字典 key，渲染时解析）。 */
const SKILL_TABS: { tab: SkillCenterTab; labelKey: TextKey; descKey: TextKey }[] = [
	{ tab: "personal", labelKey: "settings.skills.tabPersonal", descKey: "settings.skills.tabPersonalDesc" },
	{ tab: "global", labelKey: "settings.skills.tabGlobal", descKey: "settings.skills.tabGlobalDesc" },
	{ tab: "project", labelKey: "settings.skills.tabProject", descKey: "settings.skills.tabProjectDesc" },
];

/** settings.json 的 plugins 条目：npm:/git/本地目录/本地单文件统一形态。 */
type PluginEntry =
	| string
	| {
			source: string;
			disabled?: boolean;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

type PluginType = "npm" | "git" | "local-file" | "local-dir";

type ArchiveEntry = { sessionId: string; archivedAt: string };

type ArchiveConfigResult = { retentionDays: number; sessions: ArchiveEntry[] };

type SessionListRow = { id?: string; name?: string; firstMessage?: string; cwd?: string };

/** 内置提示词分区的展示名（顺序即渲染顺序）。 */
const BUILTIN_SECTION_TITLES: Record<string, TextKey> = {
	preamble: "settings.prompts.secPreamble",
	tools: "settings.prompts.secTools",
	rules: "settings.prompts.secRules",
	docs: "settings.prompts.secDocs",
	addendum: "settings.prompts.secAddendum",
	project_context: "settings.prompts.secProjectContext",
	skills: "settings.prompts.secSkills",
	cwd: "settings.prompts.secCwd",
};

/** 会话显示名（与侧边栏同规则）：自定义名 > 首条用户消息 > id 前缀。 */
function sessionDisplayName(row: SessionListRow): string {
	const named = row.name?.trim();
	if (named) return named;
	const first = row.firstMessage?.trim().replace(/\s+/g, " ");
	if (first) return first.length > 48 ? `${first.slice(0, 48)}…` : first;
	return row.id ? t("settings.sessionFallback", { id: row.id.slice(0, 8) }) : t("settings.sessionUnnamed");
}

/** 距自动删除还剩几天（保留期 - 已归档天数）。 */
function daysLeft(archivedAt: string, retentionDays: number): number {
	const t = Date.parse(archivedAt);
	if (!Number.isFinite(t)) return retentionDays;
	return retentionDays - Math.floor((Date.now() - t) / 86_400_000);
}

function formatDateTime(iso: string): string {
	const t = new Date(iso);
	return Number.isFinite(t.getTime())
		? t.toLocaleString(getUiLanguage() === "en" ? "en-US" : "zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
		: iso;
}

/** 项目显示名：路径末段（与侧边栏同规则）。 */
function projectLabel(cwd: string): string {
	const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || cwd;
}

function pluginSourceLabel(entry: PluginEntry): string {
	return typeof entry === "string" ? entry : entry.source;
}

/** 按来源字符串判定插件类型（与加载管线的路由一致）。 */
function pluginType(source: string): PluginType {
	if (source.startsWith("npm:")) return "npm";
	if (/^(git|ssh|https?):/i.test(source) || source.endsWith(".git") || /^git@/i.test(source)) return "git";
	if (/\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(source)) return "local-file";
	return "local-dir";
}

/** 插件类型的展示名（npm/git 本身就是通用写法，原样展示）。 */
function pluginTypeLabel(type: PluginType): string {
	if (type === "local-file") return t("settings.plugins.typeLocalFile");
	if (type === "local-dir") return t("settings.plugins.typeLocalDir");
	return type;
}

function pluginBadgeClass(type: PluginType): string {
	switch (type) {
		case "npm":
			return "border-sky-400/30 text-sky-400";
		case "git":
			return "border-violet-400/30 text-violet-400";
		case "local-file":
			return "border-emerald-400/30 text-emerald-400";
		default:
			return "border-amber-400/30 text-amber-400";
	}
}

/** 启停切换：字符串 → 对象（停用）；重新启用且对象只剩 source 时折叠回字符串。 */
function togglePluginEntry(entry: PluginEntry): PluginEntry {
	if (typeof entry === "string") return { source: entry, disabled: true };
	if (!entry.disabled) return { ...entry, disabled: true };
	const { disabled: _disabled, ...rest } = entry;
	return Object.keys(rest).length === 1 ? rest.source : rest;
}

/** 设置侧栏导航项 */
function NavItem({
	icon,
	label,
	active,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={`owl-settings-nav-item ${active ? "is-active" : ""}`}
		>
			{icon}
			{label}
		</button>
	);
}

/** 设置分区标题 + 描述（对齐 Claude/ChatGPT 设置页的版式） */
function SectionHeader({ title, desc }: { title: string; desc?: string }): React.JSX.Element {
	return (
		<div className="owl-settings-heading">
			<h2>{title}</h2>
			{desc && <p>{desc}</p>}
		</div>
	);
}

/** 设置行：左侧标题/说明，右侧控件；长路径类设置可传 children 全宽铺开 */
function SettingRow({
	title,
	desc,
	control,
	children,
}: {
	title: string;
	desc?: string;
	control?: React.ReactNode;
	children?: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="owl-settings-row">
			<div className="owl-settings-row-heading">
				<div className="min-w-0">
					<div className="owl-settings-row-title">{title}</div>
					{desc && <div className="owl-settings-row-description">{desc}</div>}
				</div>
				{control && <div className="owl-settings-row-control">{control}</div>}
			</div>
			{children && <div className="owl-settings-row-body">{children}</div>}
		</div>
	);
}

/** 开关（DSH 设置页同款胶囊样式；用按钮自绘，不依赖原生 checkbox 外观）。 */
function Switch({
	checked,
	onChange,
	disabled,
	title,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	title?: string;
}): React.JSX.Element {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			title={title}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-default disabled:opacity-40 ${
				checked ? "bg-owl-accent" : "bg-owl-border"
			}`}
		>
			<span
				className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-150 ${
					checked ? "left-[18px]" : "left-0.5"
				}`}
			/>
		</button>
	);
}

/** 独立设置工作区，保留桌面窗口顶栏和原有配置接口。 */
export function SettingsPage({
	client,
	workspaceDir,
	onWorkspaceDir,
	onClose,
	onSessionsChanged,
	initialTab = "general",
}: {
	client: BridgeClient;
	workspaceDir: string;
	onWorkspaceDir: (dir: string) => void;
	onClose: () => void;
	/** 会话列表发生变化（恢复/删除归档会话）：让侧边栏同步重拉，避免两边状态对不上。 */
	onSessionsChanged?: () => void;
	initialTab?: "general" | "about";
}): React.JSX.Element {
	const t = useT();
	const [section, setSection] = useState<SettingsSection>(initialTab);
	const [agentDir, setAgentDir] = useState("");
	const [settingsObj, setSettingsObj] = useState<Record<string, unknown>>({});
	const [chatAppearance, setChatAppearance] = useState<ChatAppearance>(() => ({ ...DEFAULT_CHAT_APPEARANCE }));
	const [chatAppearanceLoaded, setChatAppearanceLoaded] = useState(false);
	const [raw, setRaw] = useState("");
	const [shellPath, setShellPath] = useState("");
	const [customPrompt, setCustomPrompt] = useState("");
	const [userImpression, setUserImpression] = useState("");
	const [builtinSections, setBuiltinSections] = useState<Record<string, string>>({});
	const [savedMsg, setSavedMsg] = useState("");
	const [groups, setGroups] = useState<ProviderModelsMessage[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pageRef = useRef<HTMLDivElement>(null);
	const backRef = useRef<HTMLButtonElement>(null);

	// 添加供应商表单
	const [showProviderForm, setShowProviderForm] = useState(false);
	const [confirmProviderId, setConfirmProviderId] = useState<string | null>(null);
	const [pKey, setPKey] = useState("");
	const [pName, setPName] = useState("");
	const [pUrl, setPUrl] = useState("");
	const [pApi, setPApi] = useState("openai-completions");
	const [pApiKey, setPApiKey] = useState("");

	// 添加模型表单（按供应商）
	const [modelFormFor, setModelFormFor] = useState<string | null>(null);
	const [mId, setMId] = useState("");
	const [mName, setMName] = useState("");
	const [mCtx, setMCtx] = useState("");
	const [mMax, setMMax] = useState("");
	const [mReasoning, setMReasoning] = useState(false);

	// 快捷接入（像 /login：选厂商 → 登录或贴 Key）
	const [catalog, setCatalog] = useState<{ id: string; name: string; oauth: boolean; apiKey: boolean }[]>([]);
	const [quickProvider, setQuickProvider] = useState("");
	const [quickKey, setQuickKey] = useState("");
	const [quickHint, setQuickHint] = useState("");
	const [loginAsk, setLoginAsk] = useState<{ type: string; message?: string; placeholder?: string; options?: { id: string; label: string }[] } | null>(null);
	const [askAnswer, setAskAnswer] = useState("");
	// 登录 / 保存 Key 成功的弹窗内容（null = 不显示）
	const [authSuccess, setAuthSuccess] = useState<{ title: string; message: string } | null>(null);
	// GitHub 企业版登录：勾选后桥不再自动代答「企业域名」，把提问转给界面
	const [enterpriseLogin, setEnterpriseLogin] = useState(false);

	// 归档：保留期 + 已归档会话列表（session.list 拿标题，两步确认删除）
	const [archiveCfg, setArchiveCfg] = useState<ArchiveConfigResult>({ retentionDays: 15, sessions: [] });
	const [retentionInput, setRetentionInput] = useState("15");
	const [sessionTitles, setSessionTitles] = useState<Record<string, SessionListRow>>({});
	const [confirmDelId, setConfirmDelId] = useState<string | null>(null);

	// 跨会话记忆：条目列表 + 开关（memory.list / memory.delete / memory.clear）
	const [memory, setMemory] = useState<MemoryListResult>({ enabled: true, entries: [] });
	const [confirmDelMemoryId, setConfirmDelMemoryId] = useState<string | null>(null);
	const [confirmClearMemory, setConfirmClearMemory] = useState(false);

	// 图像生成（owl-image）：配置/密钥状态/订阅状态（imageConfig.* / imageSub.*）。
	// keyStatus 只拿存在性；imageKeys/imageKeyClear 是「待保存」的输入缓冲。
	const [imageData, setImageData] = useState<ImageConfigGetResult | null>(null);
	const [imageCfg, setImageCfg] = useState<OwlImageConfigPublic>({});
	const [imageKeys, setImageKeys] = useState<Partial<Record<string, string>>>({});
	const [imageKeyClear, setImageKeyClear] = useState<Partial<Record<string, boolean>>>({});
	const [imageSaved, setImageSaved] = useState(false);
	const [imageSubHint, setImageSubHint] = useState("");
	const [comfyForm, setComfyForm] = useState<{ name: string; json: string; preset: string }>({ name: "", json: "", preset: "" });

	// 插件：新增输入框
	const [pluginInput, setPluginInput] = useState("");

	// 技能中心：三级 tab + 列表 + 搜索 + 行内编辑/创建表单
	const [skillsData, setSkillsData] = useState<SkillsListResult>({
		roots: { personal: "", global: "", project: "" },
		skills: [],
		projectTrusted: false,
		projectSkillPatterns: [],
	});
	const [skillsTab, setSkillsTab] = useState<SkillCenterTab>("personal");
	const [skillsQuery, setSkillsQuery] = useState("");
	const [skillsLoading, setSkillsLoading] = useState(false);
	const [skillForm, setSkillForm] = useState<{ mode: "create" } | { mode: "edit"; entry: SkillCenterEntry } | null>(null);
	const [skName, setSkName] = useState("");
	const [skDesc, setSkDesc] = useState("");
	const [skBody, setSkBody] = useState("");
	const [confirmDelSkill, setConfirmDelSkill] = useState<SkillCenterEntry | null>(null);
	// 项目 tab：查看哪个项目 + 勾选本项目需要的技能
	const [skillProjects, setSkillProjects] = useState<string[]>([]);
	const [skillProject, setSkillProject] = useState("");
	const [skillAddProject, setSkillAddProject] = useState("");
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);

	useEffect(() => {
		const off = client.onSessionEvent((msg) => {
			const ev = msg.event as {
				type?: string;
				ask?: { type: string; message?: string; placeholder?: string; options?: { id: string; label: string }[] };
				detail?: { type?: string; message?: string; userCode?: string; verificationUri?: string };
			};
			if (ev?.type === "auth_prompt" && ev.ask) {
				setLoginAsk(ev.ask);
				setAskAnswer("");
			} else if (ev?.type === "auth_notify" && ev.detail) {
				const d = ev.detail;
				if (d.type === "device_code") setQuickHint(t("settings.models.deviceCodeHint", { code: d.userCode ?? "" }));
				else if (d.type === "auth_url") setQuickHint(t("settings.models.browserOpened"));
				else if (d.message) setQuickHint(d.message);
			}
		});
		return off;
	}, [client]);

	useEffect(() => {
		return () => {
			if (savedTimer.current) clearTimeout(savedTimer.current);
		};
	}, []);

	useEffect(() => {
		const previous = document.activeElement;
		backRef.current?.focus();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);

	useEffect(() => setSection(initialTab), [initialTab]);

	function respondPrompt(answer: string) {
		setLoginAsk(null);
		setAskAnswer("");
		setQuickHint(t("settings.models.submitted"));
		void client.request({ type: "auth.prompt.respond", answer });
	}

	/**
	 * auth.login 的收尾。它的 result 是对象（{ provider, authType }）而非数组，
	 * 不能走 apply()——数组判断会把成功误判成「操作失败」，这里只看 ok。
	 * 成功：弹窗提醒 + 后台刷新模型列表；用户取消（「登录已取消」）保持静默。
	 */
	function finishAuthLogin(response: { ok: boolean; error?: string }, providerId: string, title: string): void {
		if (!response.ok) {
			if (!/取消/.test(response.error ?? "")) setError(response.error ?? t("common.operationFailed"));
			return;
		}
		setQuickHint(t("settings.models.loginSucceeded", { title }));
		const name = catalog.find((p) => p.id === providerId)?.name ?? providerId;
		setAuthSuccess({ title, message: t("settings.models.loginSuccessMessage", { name }) });
		void client.request<ProviderModelsMessage[]>({ type: "models.list" }).then(apply);
	}

	function apply(response: { ok: boolean; result?: unknown; error?: string }): boolean {
		if (response.ok && Array.isArray(response.result)) {
			setGroups(response.result as ProviderModelsMessage[]);
			setError("");
			return true;
		}
		if (!/取消/.test(response.error ?? "")) setError(response.error ?? t("common.operationFailed"));
		return false;
	}

	useEffect(() => {
		void (async () => {
			const [settings, models, providers] = await Promise.all([
				client.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" }),
				client.request<ProviderModelsMessage[]>({ type: "models.list" }),
				client.request<{ id: string; name: string; oauth: boolean; apiKey: boolean }[]>({ type: "auth.providers" }),
			]);
			if (settings.ok && settings.result) {
				const obj = (settings.result.settings ?? {}) as Record<string, unknown>;
				setAgentDir(settings.result.agentDir);
				setSettingsObj(obj);
				setChatAppearance(parseChatAppearance(obj.desktopChatAppearance));
				setChatAppearanceLoaded(true);
				setRaw(JSON.stringify(obj, null, 2));
				if (typeof obj.shellPath === "string") setShellPath(obj.shellPath);
				if (typeof obj.owlCustomPrompt === "string") setCustomPrompt(obj.owlCustomPrompt);
				if (typeof obj.owlUserImpression === "string") setUserImpression(obj.owlUserImpression);
				// 设置页打开时同步界面语言（App 启动已拉过一次；JSON 分区手改 settings.json 后以此为准）
				setUiLanguage(parseUiLanguage(obj.uiLanguage));
				if (obj.owlMemory && typeof obj.owlMemory === "object") {
					const enabled = (obj.owlMemory as { enabled?: unknown }).enabled;
					setMemory((prev) => ({ ...prev, enabled: enabled !== false }));
				}
			}
			if (models.ok && Array.isArray(models.result)) setGroups(models.result as ProviderModelsMessage[]);
			if (providers.ok && Array.isArray(providers.result)) setCatalog(providers.result);
			const preview = await client.request<SystemPromptPreviewResult>({ type: "systemPrompt.preview" });
			if (preview.ok && preview.result?.sections) setBuiltinSections(preview.result.sections);
		})();
		void loadArchive();
		void loadMemory();
	}, [client]); // eslint-disable-line react-hooks/exhaustive-deps

	/** 拉取跨会话记忆（条目 + 开关）。 */
	async function loadMemory(): Promise<void> {
		const response = await client.request<MemoryListResult>({ type: "memory.list" });
		if (response.ok && response.result) setMemory(response.result);
	}

	/** 开/关跨会话记忆：写 settings.owlMemory.enabled，新会话生效。 */
	async function toggleMemory(): Promise<void> {
		const enabled = !memory.enabled;
		setBusy(true);
		setError("");
		try {
			const ok = await saveSettings({ owlMemory: { enabled } });
			if (ok) setMemory((prev) => ({ ...prev, enabled }));
		} finally {
			setBusy(false);
		}
	}

	/** 删除单条记忆（设置页与 /memory 操作同一份 entries.json）。 */
	async function deleteMemoryEntry(entryId: string): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request<{ ok: boolean }>({ type: "memory.delete", entryId });
			if (response.ok) {
				setMemory((prev) => ({ ...prev, entries: prev.entries.filter((entry) => entry.id !== entryId) }));
			} else {
				setError(response.error ?? t("common.deleteFailed"));
			}
		} finally {
			setBusy(false);
			setConfirmDelMemoryId(null);
		}
	}

	/** 清空全部记忆。 */
	async function clearAllMemory(): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request<{ ok: boolean }>({ type: "memory.clear" });
			if (response.ok) setMemory((prev) => ({ ...prev, entries: [] }));
			else setError(response.error ?? t("common.clearFailed"));
		} finally {
			setBusy(false);
			setConfirmClearMemory(false);
		}
	}

	// ---- 技能中心：三级浏览 + CRUD（skills.* 路由；写操作后桥端热刷新挂载会话）----

	/** 拉取技能列表（个人/全局/项目三个根一起返回；cwd 决定项目根与 projectEnabled 的计算对象）。 */
	async function loadSkillsList(cwdOverride?: string): Promise<void> {
		const cwd = cwdOverride ?? skillProject ?? workspaceDir;
		setSkillsLoading(true);
		try {
			const response = await client.request<SkillsListResult>({
				type: "skills.list",
				...(cwd ? { cwd } : {}),
			});
			if (response.ok && response.result) setSkillsData(response.result);
			else setError(response.error ?? t("settings.skills.listFailed"));
		} finally {
			setSkillsLoading(false);
		}
	}

	/** 打开技能面板时拉一次；工作区切换后项目根会变，也要重拉。 */
	useEffect(() => {
		if (section === "skills") {
			void loadSkillsList();
			// 候选项目 = 手动添加过（localStorage）+ 历史会话的 cwd
			void (async () => {
				let stored: string[] = [];
				try {
					const raw = JSON.parse(localStorage.getItem("owl-skill-projects") ?? "[]") as unknown;
					if (Array.isArray(raw)) stored = raw.filter((p): p is string => typeof p === "string");
				} catch {
					stored = [];
				}
				const response = await client.request<SessionListRow[]>({ type: "session.list" });
				const fromSessions = (response.ok && Array.isArray(response.result) ? response.result : [])
					.map((row) => row.cwd ?? "")
					.filter((cwd) => cwd && cwd.toLowerCase() !== workspaceDir.toLowerCase());
				setSkillProjects([...new Set([...stored, ...fromSessions])]);
			})();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [section, client, workspaceDir]);

	/** 启停 = 改写 SKILL.md frontmatter，落盘后桥端自动热刷新挂载会话。 */
	async function toggleSkill(entry: SkillCenterEntry, enabled: boolean): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request({
				type: "skills.setEnabled",
				name: entry.name,
				path: entry.path,
				tab: entry.tab,
				enabled,
				...(workspaceDir ? { cwd: workspaceDir } : {}),
			});
			if (response.ok) await loadSkillsList();
			else setError(response.error ?? t("common.operationFailed"));
		} finally {
			setBusy(false);
		}
	}

	/** 切换查看的项目（项目 tab 的列表、根目录与勾选都以该项目为准）。 */
	function switchSkillProject(cwd: string): void {
		setSkillProject(cwd);
		setSkillPickerOpen(false);
		setSkillForm(null);
		void loadSkillsList(cwd || undefined);
	}

	/** 手动添加项目到候选列表（localStorage 持久化），并立即切换过去。 */
	function addSkillProject(): void {
		const trimmed = skillAddProject.trim();
		if (!trimmed) return;
		const next = [...new Set([trimmed, ...skillProjects])];
		setSkillProjects(next);
		setSkillAddProject("");
		try {
			localStorage.setItem("owl-skill-projects", JSON.stringify(next));
		} catch {
			// localStorage 不可用就只在本会话内生效
		}
		switchSkillProject(trimmed);
	}

	/** 项目 tab 的勾选范围：三个 tab 的全部技能按名字去重（同名个人优先，与 core 一致）。 */
	function projectSkillChoices(): SkillCenterEntry[] {
		const seen = new Set<string>();
		const choices: SkillCenterEntry[] = [];
		for (const entry of skillsData.skills) {
			if (seen.has(entry.name)) continue;
			seen.add(entry.name);
			choices.push(entry);
		}
		return choices;
	}

	/** 勾选/取消一个技能（opt-out）：把当前项目内禁用的名字集合整体写回项目 settings.json。 */
	async function toggleProjectSkill(name: string, enabled: boolean): Promise<void> {
		const cwd = skillProject || workspaceDir;
		if (!cwd) return;
		setBusy(true);
		setError("");
		try {
			const disabled = new Set(skillsData.skills.filter((s) => !s.projectEnabled).map((s) => s.name));
			if (enabled) disabled.delete(name);
			else disabled.add(name);
			const response = await client.request({
				type: "skills.setProjectSelection",
				cwd,
				mode: "set",
				names: [...disabled],
			});
			if (response.ok) await loadSkillsList(cwd);
			else setError(response.error ?? t("settings.skills.saveSelectionFailed"));
		} finally {
			setBusy(false);
		}
	}

	/** 清空项目覆盖模式，恢复默认（全部技能可用）。 */
	async function resetProjectSkillSelection(): Promise<void> {
		const cwd = skillProject || workspaceDir;
		if (!cwd) return;
		setBusy(true);
		setError("");
		try {
			const response = await client.request({ type: "skills.setProjectSelection", cwd, mode: "clear", names: [] });
			if (response.ok) await loadSkillsList(cwd);
			else setError(response.error ?? t("settings.skills.saveSelectionFailed"));
		} finally {
			setBusy(false);
		}
	}

	/** 打开编辑器：先经桥读取正文（列表只带元数据）。 */
	async function openSkillEditor(entry: SkillCenterEntry): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request<SkillsReadResult>({
				type: "skills.read",
				name: entry.name,
				path: entry.path,
				tab: entry.tab,
				...(workspaceDir ? { cwd: workspaceDir } : {}),
			});
			if (response.ok && response.result) {
				setSkillForm({ mode: "edit", entry });
				setSkDesc(response.result.description);
				setSkBody(response.result.body);
			} else {
				setError(response.error ?? t("settings.skills.readFailed"));
			}
		} finally {
			setBusy(false);
		}
	}

	/** 保存创建/编辑（编辑不改名称与位置，启停状态原样保留）。 */
	async function saveSkillForm(): Promise<void> {
		if (!skillForm) return;
		setBusy(true);
		setError("");
		try {
			const response =
				skillForm.mode === "create"
					? await client.request({
							type: "skills.create",
							tab: skillsTab,
							name: skName.trim(),
							description: skDesc,
							body: skBody,
							...(workspaceDir ? { cwd: workspaceDir } : {}),
						})
					: await client.request({
							type: "skills.update",
							name: skillForm.entry.name,
							path: skillForm.entry.path,
							tab: skillForm.entry.tab,
							description: skDesc,
							body: skBody,
							...(workspaceDir ? { cwd: workspaceDir } : {}),
						});
			if (response.ok) {
				setSkillForm(null);
				setSkName("");
				setSkDesc("");
				setSkBody("");
				await loadSkillsList();
			} else {
				setError(response.error ?? t("common.saveFailed"));
			}
		} finally {
			setBusy(false);
		}
	}

	/** 删除（移入 .trash 回收站，可手工恢复）。 */
	async function deleteSkillEntry(entry: SkillCenterEntry): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request({
				type: "skills.delete",
				name: entry.name,
				path: entry.path,
				tab: entry.tab,
				...(workspaceDir ? { cwd: workspaceDir } : {}),
			});
			if (response.ok) await loadSkillsList();
			else setError(response.error ?? t("common.deleteFailed"));
		} finally {
			setBusy(false);
			setConfirmDelSkill(null);
		}
	}

	/** 拉取归档配置 + 会话列表（只为了拿标题）。 */
	async function loadArchive(): Promise<void> {
		const [cfg, list] = await Promise.all([
			client.request<ArchiveConfigResult>({ type: "session.archiveConfig" }),
			client.request<SessionListRow[]>({ type: "session.list" }),
		]);
		if (cfg.ok && cfg.result) {
			setArchiveCfg(cfg.result);
			setRetentionInput(String(cfg.result.retentionDays));
		}
		if (list.ok && Array.isArray(list.result)) {
			const map: Record<string, SessionListRow> = {};
			for (const row of list.result as SessionListRow[]) {
				if (row.id) map[row.id] = row;
			}
			setSessionTitles(map);
		}
	}

	/** 保存保留期：桥端写 archive.json 并立即巡检一次。 */
	async function saveRetention(): Promise<void> {
		const days = Number(retentionInput);
		if (!Number.isInteger(days) || days < 1) {
			setError(t("settings.archive.retentionInvalid"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const response = await client.request<ArchiveConfigResult>({
				type: "session.archiveConfig",
				retentionDays: days,
			});
			if (response.ok && response.result) {
				setArchiveCfg(response.result);
				setRetentionInput(String(response.result.retentionDays));
				flashSaved();
			} else {
				setError(response.error ?? t("common.saveFailed"));
			}
		} finally {
			setBusy(false);
		}
	}

	/** 恢复归档会话：放回原项目分组，并同步刷新侧边栏。 */
	async function restoreArchived(sessionId: string): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request({ type: "session.unarchive", sessionId });
			if (response.ok) {
				onSessionsChanged?.();
				await loadArchive();
			} else {
				setError(response.error ?? t("common.restoreFailed"));
			}
		} finally {
			setBusy(false);
		}
	}

	/** 立即删除归档会话（JSONL 文件真删，不可恢复）。 */
	async function deleteArchived(sessionId: string): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request({ type: "session.delete", sessionId });
			if (response.ok) {
				setConfirmDelId(null);
				onSessionsChanged?.();
				await loadArchive();
			} else {
				setError(response.error ?? t("common.deleteFailed"));
			}
		} finally {
			setBusy(false);
		}
	}

	function flashSaved() {
		setSavedMsg(t("common.saved"));
		if (savedTimer.current) clearTimeout(savedTimer.current);
		savedTimer.current = setTimeout(() => setSavedMsg(""), 2000);
	}

	/**
	 * 写回 settings.json。桥端 applyGlobalOverridesAndSave 做深合并：
	 * 对象键增量合并、数组整体替换 —— 所以改 plugins/packages/extensions 必须传完整数组。
	 */
	async function saveSettings(partial: Record<string, unknown>): Promise<boolean> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request<Record<string, unknown>>({ type: "settings.set", values: partial });
			if (response.ok) {
				if (response.result && typeof response.result === "object") {
					setSettingsObj(response.result);
					setRaw(JSON.stringify(response.result, null, 2));
					// 侧边卡片配置的 UI 镜像即时同步（含 JSON 分区手改 settings.json 的路径）
					setSidebarConfig(parseSidebarSettings((response.result as Record<string, unknown>).owlSidebar));
					const appearance = parseChatAppearance(response.result.desktopChatAppearance);
					applyChatAppearance(appearance);
					if ("desktopChatAppearance" in partial) setChatAppearance(appearance);
				}
				flashSaved();
				return true;
			}
			setError(response.error ?? t("common.saveFailed"));
			return false;
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			setBusy(false);
		}
	}

	function resetProviderForm() {
		setPKey("");
		setPName("");
		setPUrl("");
		setPApi("openai-completions");
		setPApiKey("");
	}

	/** 保存侧边卡片配置：settings.set 深合并对象、整体替换数组，所以传完整对象。 */
	function saveSidebar(next: SidebarConfig): void {
		void saveSettings({ owlSidebar: next });
	}

	/** 开/停一张侧边卡片（数组全量写回）。 */
	function toggleSidebarTab(kind: string, enabled: boolean): void {
		const set = new Set(sidebarCfg.disabledTabs);
		if (enabled) set.delete(kind);
		else set.add(kind);
		saveSidebar({ ...sidebarCfg, disabledTabs: [...set] });
	}

	/** 开/停一个文件预览 viewer。 */
	function toggleSidebarViewer(kind: string, enabled: boolean): void {
		const set = new Set(sidebarCfg.disabledViewers);
		if (enabled) set.delete(kind);
		else set.add(kind);
		saveSidebar({ ...sidebarCfg, disabledViewers: [...set] });
	}

	/** 打开配置文件（settings.json，系统默认编辑器）。 */
	function openSidebarConfigFile(): void {
		if (!agentDir) return;
		void client
			.request({ type: "open.external", action: "url", target: encodeURI(`file:///${agentDir.replace(/\\/g, "/").replace(/^\/+/, "")}/settings.json`) })
			.catch(() => {});
	}

	async function run(request: Parameters<BridgeClient["request"]>[0]) {
		setBusy(true);
		setError("");
		try {
			apply(await client.request(request));
		} finally {
			setBusy(false);
		}
	}

	const plugins = Array.isArray(settingsObj.plugins) ? (settingsObj.plugins as PluginEntry[]) : [];
	const packages = Array.isArray(settingsObj.packages) ? (settingsObj.packages as PluginEntry[]) : [];
	const extensions = Array.isArray(settingsObj.extensions) ? (settingsObj.extensions as string[]) : [];
	const sidebarCfg = parseSidebarSettings(settingsObj.owlSidebar);
	const theme = typeof settingsObj.theme === "string" ? settingsObj.theme : "dark";
	const version = typeof settingsObj.lastChangelogVersion === "string" ? settingsObj.lastChangelogVersion : "";
	const modelCount = groups.reduce((n, g) => n + g.models.length, 0);

	const input = "owl-settings-input mt-1 w-full font-mono";
	const smallInput = input;
	const btn = "owl-settings-button";
	const btnAccent = "owl-settings-button is-primary";
	const confirmProvider = groups.find((group) => group.id === confirmProviderId);

	return (
		<div
			ref={pageRef}
			className="owl-settings-page"
			role="dialog"
			aria-modal="true"
			aria-labelledby="owl-settings-title"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					if (authSuccess) setAuthSuccess(null);
					else if (confirmProviderId) setConfirmProviderId(null);
					else onClose();
				}
				if (event.key !== "Tab") return;
				const scope = pageRef.current?.querySelector<HTMLElement>(".owl-settings-modal") ?? pageRef.current;
				const items = scope?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]');
				if (!items?.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (event.shiftKey && (document.activeElement === first || !scope?.contains(document.activeElement))) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && (document.activeElement === last || !scope?.contains(document.activeElement))) {
					event.preventDefault();
					first.focus();
				}
			}}
		>
			<div className="owl-settings-frame">
				{/* ============ 头部 ============ */}
				<div className="owl-settings-topbar">
					<button ref={backRef} type="button" className="owl-settings-back" onClick={onClose}>
						<span aria-hidden="true">←</span> {t("settings.backToWorkspace")}
					</button>
					<span className="owl-settings-topbar-divider" />
					<IconSettings />
					<h1 id="owl-settings-title">{t("settings.title")}</h1>
					<span className="owl-settings-topbar-hint">{t("settings.tagline")}</span>
				</div>

				<div className="owl-settings-layout">
					{/* ============ 左侧分类导航 ============ */}
					<nav className="owl-settings-nav" aria-label={t("settings.navAria")}>
						<div className="owl-settings-nav-label">{t("settings.navGroupEnv")}</div>
						<NavItem icon={<IconSettings />} label={t("settings.navGeneral")} active={section === "general"} onClick={() => setSection("general")} />
						<NavItem icon={<IconSliders />} label={t("settings.navModels")} active={section === "models"} onClick={() => setSection("models")} />
						<NavItem icon={<IconPlug />} label={t("settings.navPlugins")} active={section === "plugins"} onClick={() => setSection("plugins")} />
						<NavItem icon={<IconList />} label={t("settings.navSkills")} active={section === "skills"} onClick={() => setSection("skills")} />
						<NavItem icon={<IconPanelRight size={14} />} label={t("settings.navSidebar")} active={section === "sidebar"} onClick={() => setSection("sidebar")} />
						<NavItem icon={<IconSun />} label={t("settings.navAppearance")} active={section === "appearance"} onClick={() => setSection("appearance")} />
						<NavItem icon={<IconCompose />} label={t("settings.navPrompts")} active={section === "prompts"} onClick={() => setSection("prompts")} />
					<NavItem icon={<IconLightbulb />} label={t("settings.navMemory")} active={section === "memory"} onClick={() => setSection("memory")} />
						<div className="owl-settings-nav-label">{t("settings.navGroupData")}</div>
						<NavItem icon={<IconArchive />} label={t("settings.navArchive")} active={section === "archived"} onClick={() => setSection("archived")} />
						<NavItem icon={<IconCode />} label="settings.json" active={section === "json"} onClick={() => setSection("json")} />
						<NavItem icon={<IconInfo />} label={t("settings.navAbout")} active={section === "about"} onClick={() => setSection("about")} />
					</nav>

					{/* ============ 右侧内容区 ============ */}
					<div className="owl-settings-content" key={section}>
						{error && <div className="owl-settings-notice is-error" role="alert">{error}</div>}

						{/* -------- 常规 -------- */}
						{section === "general" && (
							<>
								<SectionHeader title={t("settings.general.title")} desc={t("settings.general.desc")} />
								<SettingRow title={t("settings.general.workspaceDir")} desc={t("settings.general.workspaceDirDesc")}>
									<input className={input} value={workspaceDir} onChange={(event) => onWorkspaceDir(event.target.value)} />
								</SettingRow>
								<SettingRow title={t("settings.general.agentDir")} desc={t("settings.general.agentDirDesc")}>
									<input
										className="w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 font-mono text-xs text-owl-faint outline-none"
										value={agentDir}
										readOnly
									/>
								</SettingRow>
								<SettingRow
									title={t("settings.general.shellPath")}
									desc={t("settings.general.shellPathDesc")}
									control={
										<button type="button" className={btnAccent} disabled={busy} onClick={() => void saveSettings({ shellPath })}>
											{t("common.save")}
										</button>
									}
								>
									<input className={smallInput} value={shellPath} onChange={(event) => setShellPath(event.target.value)} placeholder={t("settings.general.shellPathPlaceholder")} />
								</SettingRow>
								<SettingRow title={t("settings.general.uiLanguage")} desc={t("settings.general.uiLanguageDesc")}>
									<select
										aria-label={t("settings.general.uiLanguage")}
										className="rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none focus:border-owl-accent"
										value={getUiLanguage()}
										disabled={busy}
										onChange={(event) => {
											const next = parseUiLanguage(event.target.value);
											// 先切语言（全界面即时生效），再落盘 settings.json
											setUiLanguage(next);
											void saveSettings({ uiLanguage: next });
										}}
									>
										<option value="zh">{t("settings.general.uiLanguageZh")}</option>
										<option value="en">{t("settings.general.uiLanguageEn")}</option>
									</select>
								</SettingRow>
								<div className="flex items-center justify-between gap-3 pt-3">
									<div>
										<h3 className="text-sm font-semibold text-owl-text">{t("settings.general.readingTitle")}</h3>
										<p className="mt-1 text-[11px] text-owl-faint">{t("settings.general.readingDesc")}</p>
									</div>
									<button
										type="button"
										className={btn}
										disabled={busy || !chatAppearanceLoaded}
										onClick={() => setChatAppearance({ ...DEFAULT_CHAT_APPEARANCE })}
									>
										{t("settings.general.resetDefaults")}
									</button>
								</div>
								{CHAT_READING_FIELDS.map((field) => (
									<SettingRow
										key={field.key}
										title={t(field.titleKey)}
										desc={t(field.descKey)}
										control={<span className="text-xs tabular-nums text-owl-text">{chatAppearance[field.key]} {"unitKey" in field ? t(field.unitKey) : field.unit}</span>}
									>
										<input
											type="range"
											aria-label={t(field.titleKey)}
											className="w-full accent-owl-accent disabled:opacity-40"
											min={field.min}
											max={field.max}
											step={field.step}
											value={chatAppearance[field.key]}
											disabled={busy || !chatAppearanceLoaded}
											onChange={(event) => {
												const value = event.currentTarget.valueAsNumber;
												setChatAppearance((current) => parseChatAppearance({ ...current, [field.key]: value }));
											}}
										/>
									</SettingRow>
								))}
								<SettingRow
									title={t("settings.general.toolRecords")}
									desc={t("settings.general.toolRecordsDesc")}
									control={
										<select
											aria-label={t("settings.general.toolRecords")}
											className="rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none focus:border-owl-accent"
											value={chatAppearance.toolRecords}
											disabled={busy || !chatAppearanceLoaded}
											onChange={(event) => setChatAppearance((current) => ({
												...current,
												toolRecords: event.target.value === "expanded" ? "expanded" : "compact",
											}))}
										>
											<option value="compact">{t("settings.general.toolRecordsCompact")}</option>
											<option value="expanded">{t("settings.general.toolRecordsExpanded")}</option>
										</select>
									}
								/>
								<SettingRow
									title={t("settings.general.motion")}
									desc={t("settings.general.motionDesc")}
									control={
										<Switch
											title={t("settings.general.motion")}
											checked={chatAppearance.motion}
											disabled={busy || !chatAppearanceLoaded}
											onChange={(motion) => setChatAppearance((current) => ({ ...current, motion }))}
										/>
									}
								/>
								<div className="flex justify-end">
									<button
										type="button"
										className={btnAccent}
										disabled={busy || !chatAppearanceLoaded}
										onClick={() => void saveSettings({ desktopChatAppearance: parseChatAppearance(chatAppearance) })}
									>
										{t("settings.general.saveReading")}
									</button>
								</div>
							</>
						)}

						{/* -------- 模型与供应商 -------- */}
						{section === "models" && (
							<>
								<SectionHeader
									title={t("settings.models.title")}
										desc={t("settings.models.desc")}
								/>

								{/* 快捷接入：像 /login 一样选厂商 */}
								<div className="owl-settings-card">
									<div className="owl-settings-row-title">{t("settings.models.quickConnectTitle")}</div>
									<p className="owl-settings-row-description">{t("settings.models.quickConnectDesc")}</p>
									<select
										className="mt-2 w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-sm text-owl-text outline-none focus:border-owl-accent"
										value={quickProvider}
										onChange={(e) => {
											setQuickProvider(e.target.value);
											setQuickKey("");
											setQuickHint("");
										}}
									>
										<option value="">{t("settings.models.pickProvider")}</option>
										{catalog.map((p) => (
											<option key={p.id} value={p.id}>
												{p.name} ({p.id}){p.oauth ? t("settings.models.oauthHintSuffix") : ""}
											</option>
										))}
									</select>
									{quickProvider && (
										<div className="mt-2 space-y-2">
											<div className="flex gap-2">
												<input
													type="password"
													autoComplete="off"
													className="flex-1 rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
													value={quickKey}
													onChange={(e) => setQuickKey(e.target.value)}
													placeholder={t("settings.models.apiKeyPlaceholder")}
												/>
												<button
													type="button"
													className={btnAccent}
													disabled={busy || !quickKey.trim()}
													onClick={() => {
														setQuickHint(t("settings.models.savingKey"));
														void client
															.request({ type: "auth.login", provider: quickProvider, authType: "api_key", apiKey: quickKey.trim() })
															.then((response) => {
																if (response.ok) setQuickKey("");
																finishAuthLogin(response, quickProvider, t("settings.models.apiKeySavedTitle"));
															});
													}}
												>
													{t("settings.models.saveApiKey")}
												</button>
											</div>
											{catalog.find((p) => p.id === quickProvider)?.oauth && (
												<div className="flex items-center gap-3">
													<button
														type="button"
														className={btn}
														disabled={busy}
														onClick={() => {
															setQuickHint(t("settings.models.oauthStarting"));
															void client
																.request({ type: "auth.login", provider: quickProvider, authType: "oauth", enterprise: enterpriseLogin })
																.then((response) => finishAuthLogin(response, quickProvider, t("settings.models.oauthLoginSuccessTitle")));
														}}
													>
														{t("settings.models.oauthLogin")}
													</button>
													<label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-owl-muted">
														<input
															type="checkbox"
															checked={enterpriseLogin}
															onChange={(e) => setEnterpriseLogin(e.target.checked)}
														/>
														{t("settings.models.enterpriseCheckbox")}
													</label>
												</div>
											)}
											{quickHint && <div className="text-[11px] text-owl-muted">{quickHint}</div>}
											{loginAsk && (
												<div className="owl-settings-notice is-warning">
													<div className="text-[11px] text-amber-200">{loginAsk.message ?? t("settings.models.loginNeedsInput")}</div>
													{(loginAsk.type === "text" || loginAsk.type === "secret" || loginAsk.type === "manual_code") && (
														<div className="mt-1.5 flex gap-2">
															<input
																autoFocus
																type={loginAsk.type === "secret" ? "password" : "text"}
																className="flex-1 rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
																value={askAnswer}
																placeholder={loginAsk.placeholder}
																onChange={(e) => setAskAnswer(e.target.value)}
																onKeyDown={(e) => {
																	if (e.key === "Enter" && askAnswer.trim()) respondPrompt(askAnswer.trim());
																}}
															/>
															<button type="button" className={btnAccent} onClick={() => respondPrompt(askAnswer.trim())}>
																{t("common.submit")}
															</button>
														</div>
													)}
													{loginAsk.type === "select" && (
														<div className="mt-1.5 flex flex-wrap gap-1">
															{(loginAsk.options ?? []).map((o) => (
																<button key={o.id} type="button" className={btn} onClick={() => respondPrompt(o.id)}>
																	{o.label}
																</button>
															))}
														</div>
													)}
													<div className="mt-1.5 text-right">
														<button
															type="button"
															className="text-[11px] text-owl-faint transition-colors hover:text-red-400"
															onClick={() => {
																setLoginAsk(null);
																void client.request({ type: "auth.cancel" }).then(() => setQuickHint(t("settings.models.loginCanceled")));
															}}
														>
															{t("settings.models.cancelLogin")}
														</button>
													</div>
												</div>
											)}
										</div>
									)}
								</div>

								<div className="flex items-center justify-between">
									<div className="text-xs font-semibold text-owl-muted">{t("settings.models.providerModelCount", { providers: groups.length, models: modelCount })}</div>
									<button
										type="button"
										className={btn}
										disabled={busy}
										onClick={() => {
											setShowProviderForm((v) => !v);
											setModelFormFor(null);
										}}
									>
										{showProviderForm ? t("common.collapse") : t("settings.models.addProvider")}
									</button>
								</div>

								{showProviderForm && (
									<div className="owl-settings-form space-y-4">
										<h3 className="owl-settings-row-title">{t("settings.models.addCustom")}</h3>
										<div className="grid grid-cols-2 gap-4">
											<label className="block text-[11px] text-owl-muted">
												{t("settings.models.providerIdLabel")}
												<input className={input} value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder={t("settings.models.providerIdPlaceholder")} />
											</label>
											<label className="block text-[11px] text-owl-muted">
												{t("settings.models.displayName")}
												<input className={input} value={pName} onChange={(e) => setPName(e.target.value)} placeholder={t("settings.models.displayNamePlaceholder")} />
											</label>
											<label className="block text-[11px] text-owl-muted">
												{t("settings.models.baseUrlLabel")}
												<input className={input} value={pUrl} onChange={(e) => setPUrl(e.target.value)} placeholder="https://..." />
											</label>
											<label className="block text-[11px] text-owl-muted">
												{t("settings.models.apiLabel")}
												<select className={input} value={pApi} onChange={(e) => setPApi(e.target.value)}>
													{API_OPTIONS.map((o) => (
														<option key={o.value} value={o.value}>
															{t(o.labelKey)}
														</option>
													))}
												</select>
											</label>
										</div>
										<label className="block text-[11px] text-owl-muted">
											{t("settings.models.apiKeyEnvLabelPre")}
											<code>{t("settings.models.apiKeyEnvLabelCode")}</code>
											{t("settings.models.apiKeyEnvLabelPost")}
											<input type="password" autoComplete="off" className={input} value={pApiKey} onChange={(e) => setPApiKey(e.target.value)} placeholder="sk-..." />
										</label>
										<div className="flex justify-end gap-2">
											<button type="button" className={btn} onClick={resetProviderForm}>
												{t("settings.models.clearForm")}
											</button>
											<button
												type="button"
												className={btnAccent}
												disabled={busy || !pKey.trim() || !pUrl.trim()}
												onClick={() => {
													void run({
														type: "models.putProvider",
														provider: {
															key: pKey.trim(),
															...(pName.trim() ? { name: pName.trim() } : {}),
															baseUrl: pUrl.trim(),
															api: pApi,
															...(pApiKey.trim() ? { apiKey: pApiKey.trim() } : {}),
														},
													}).then(() => {
														resetProviderForm();
														setShowProviderForm(false);
													});
												}}
											>
												{t("settings.models.saveProvider")}
											</button>
										</div>
									</div>
								)}

								<div className="space-y-2">
									{groups.length === 0 && (
										<div className="rounded-xl border border-dashed border-owl-border px-3 py-4 text-center text-xs text-owl-faint">
											{t("settings.models.empty")}
										</div>
									)}
									{groups.map((group) => (
										<div key={group.id} className="owl-settings-provider">
											<div className="owl-settings-provider-header">
												<div className="owl-settings-provider-identity">
													<span className="owl-settings-provider-mark" aria-hidden="true">{(group.name ?? group.id).slice(0, 1).toUpperCase()}</span>
													<div className="min-w-0">
														<div className="owl-settings-provider-name">{group.name ?? group.id}</div>
														<div className="owl-settings-provider-subtitle">{group.id} · {t("settings.models.modelCountSuffix", { n: group.models.length })}</div>
													</div>
												</div>
												<button
													type="button"
													className="owl-settings-link is-danger"
													disabled={busy}
													onClick={() => setConfirmProviderId(group.id)}
												>
													{t("settings.models.deleteProviderLink")}
												</button>
											</div>
											{group.models.length > 0 ? (
												<table className="owl-settings-model-table">
													<thead><tr><th scope="col">{t("settings.models.colModel")}</th><th scope="col">{t("settings.models.colContext")}</th><th scope="col">{t("settings.models.colCapabilities")}</th><th scope="col"><span className="sr-only">{t("settings.models.colActions")}</span></th></tr></thead>
													<tbody>
														{group.models.map((model) => (
															<tr key={model.id}>
																<td><div>{model.name || model.id}</div><div className="owl-settings-model-id">{model.id}</div></td>
																<td className="whitespace-nowrap">{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "—"}</td>
																<td className="whitespace-nowrap text-owl-muted">{model.reasoning ? t("settings.models.reasoning") : t("settings.models.general")}</td>
																<td><button type="button" className="owl-settings-link is-danger" disabled={busy} aria-label={t("settings.models.deleteModelAria", { name: model.name || model.id })} onClick={() => void run({ type: "models.removeModel", providerKey: group.id, modelId: model.id })}>{t("common.delete")}</button></td>
															</tr>
														))}
													</tbody>
												</table>
											) : <div className="owl-settings-notice mt-4">{t("settings.models.noModels")}</div>}

											{modelFormFor === group.id ? (
												<div className="owl-settings-form mt-4 space-y-4">
													<div className="grid grid-cols-2 gap-4">
														<label className="block text-[11px] text-owl-muted">
															{t("settings.models.modelIdLabel")}
															<input className={smallInput} value={mId} onChange={(e) => setMId(e.target.value)} placeholder={t("settings.models.modelIdPlaceholder")} />
														</label>
														<label className="block text-[11px] text-owl-muted">
															{t("settings.models.displayName")}
															<input className={smallInput} value={mName} onChange={(e) => setMName(e.target.value)} />
														</label>
														<label className="block text-[11px] text-owl-muted">
															{t("settings.models.contextWindowLabel")}
															<input className={smallInput} value={mCtx} onChange={(e) => setMCtx(e.target.value)} placeholder="128000" />
														</label>
														<label className="block text-[11px] text-owl-muted">
															{t("settings.models.maxOutputLabel")}
															<input className={smallInput} value={mMax} onChange={(e) => setMMax(e.target.value)} placeholder="8192" />
														</label>
													</div>
													<label className="flex items-center gap-1.5 text-[11px] text-owl-muted">
														<input type="checkbox" checked={mReasoning} onChange={(e) => setMReasoning(e.target.checked)} />
														{t("settings.models.reasoningModel")}
													</label>
													<div className="flex justify-end gap-2">
														<button type="button" className={btn} onClick={() => setModelFormFor(null)}>
															{t("common.cancel")}
														</button>
														<button
															type="button"
															className={btnAccent}
															disabled={busy || !mId.trim()}
															onClick={() => {
																void run({
																	type: "models.putModel",
																	providerKey: group.id,
																	model: {
																		id: mId.trim(),
																		...(mName.trim() ? { name: mName.trim() } : {}),
																		...(Number(mCtx) > 0 ? { contextWindow: Number(mCtx) } : {}),
																		...(Number(mMax) > 0 ? { maxTokens: Number(mMax) } : {}),
																		reasoning: mReasoning,
																	},
																}).then(() => {
																	setMId("");
																	setMName("");
																	setMCtx("");
																	setMMax("");
																	setMReasoning(false);
																	setModelFormFor(null);
																});
															}}
														>
															{t("settings.models.saveModel")}
														</button>
													</div>
												</div>
											) : (
												<button
													type="button"
															className={`mt-4 ${btn}`}
													disabled={busy}
													onClick={() => {
														setModelFormFor(group.id);
														setShowProviderForm(false);
													}}
												>
													{t("settings.models.addModel")}
												</button>
											)}
										</div>
									))}
								</div>
							</>
						)}

						{/* -------- 插件 -------- */}
						{section === "plugins" && (
							<>
								<SectionHeader title={t("settings.plugins.title")} desc={t("settings.plugins.desc")} />
								{(packages.length > 0 || extensions.length > 0) && (
									<div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2">
										<div className="text-[11px] leading-relaxed text-owl-muted">
											{t("settings.plugins.legacyNotice", { p: packages.length, e: extensions.length })}
										</div>
										<button
											type="button"
											className={`${btn} shrink-0`}
											disabled={busy}
											onClick={() =>
												void saveSettings({
													plugins: [...plugins, ...packages, ...extensions],
													packages: [],
													extensions: [],
												})
											}
										>
											{t("settings.plugins.migrate")}
										</button>
									</div>
								)}
								<SettingRow title={t("settings.plugins.rowTitle", { n: plugins.length })} desc={t("settings.plugins.rowDesc")}>
									<div className="flex gap-2">
										<input
											className={`${smallInput} min-w-0 flex-1`}
											value={pluginInput}
											onChange={(event) => setPluginInput(event.target.value)}
											placeholder={t("settings.plugins.inputPlaceholder")}
											onKeyDown={(event) => {
												if (event.key === "Enter" && pluginInput.trim()) {
													void saveSettings({ plugins: [...plugins, pluginInput.trim()] }).then((ok) => {
														if (ok) setPluginInput("");
													});
												}
											}}
										/>
										<button
											type="button"
											className={`${btnAccent} shrink-0`}
											disabled={busy || !pluginInput.trim()}
											onClick={() => {
												void saveSettings({ plugins: [...plugins, pluginInput.trim()] }).then((ok) => {
													if (ok) setPluginInput("");
												});
											}}
										>
											{t("common.add")}
										</button>
									</div>
								</SettingRow>
								<div className="owl-settings-plugin-list">
									{plugins.length === 0 && (
										<div className="rounded-xl border border-dashed border-owl-border px-3 py-3 text-center text-xs text-owl-faint">
											{t("settings.plugins.empty")}
										</div>
									)}
									{plugins.map((entry, index) => {
										const label = pluginSourceLabel(entry);
										const type = pluginType(label);
										const disabled = typeof entry === "object" && entry.disabled === true;
										return (
											<div
												key={`${label}-${index}`}
												className={`owl-settings-plugin-row ${disabled ? "opacity-55" : ""}`}
											>
												<div className="flex min-w-0 items-center gap-2">
													<span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${pluginBadgeClass(type)}`}>
														{pluginTypeLabel(type)}
													</span>
													<div className="min-w-0">
														<span className="block truncate font-mono text-xs text-owl-text">{label}</span>
														{typeof entry === "object" && entry.extensions && entry.extensions.length > 0 && (
															<span className="mt-0.5 block text-[10px] text-owl-faint">
																{t("settings.plugins.extEntries", { list: entry.extensions.join(", ") })}
															</span>
														)}
													</div>
												</div>
												<div className="ml-2 flex shrink-0 items-center gap-2.5">
													<button
														type="button"
														className={`text-[11px] transition-colors disabled:opacity-40 ${disabled ? "text-owl-faint hover:text-owl-text" : "text-emerald-400 hover:text-emerald-300"}`}
														disabled={busy}
														title={disabled ? t("settings.plugins.enableTitle") : t("settings.plugins.disableTitle")}
														onClick={() => {
															const next = [...plugins];
															next[index] = togglePluginEntry(entry);
															void saveSettings({ plugins: next });
														}}
													>
														{disabled ? t("settings.plugins.disabledLabel") : t("settings.plugins.enabledLabel")}
													</button>
													<button
														type="button"
														className="text-[11px] text-owl-faint transition-colors hover:text-red-400 disabled:opacity-40"
														disabled={busy}
														onClick={() => void saveSettings({ plugins: plugins.filter((_, i) => i !== index) })}
													>
														{t("common.delete")}
													</button>
												</div>
											</div>
										);
									})}
								</div>
							</>
						)}

						{/* -------- 技能 -------- */}
						{section === "skills" && (() => {
							const skillsInTab = skillsData.skills.filter((s) => s.tab === skillsTab);
							const query = skillsQuery.trim().toLowerCase();
							const nameHits = query ? skillsInTab.filter((s) => s.name.toLowerCase().includes(query)) : skillsInTab;
							const visibleSkills = query
								? [...nameHits, ...skillsInTab.filter((s) => !s.name.toLowerCase().includes(query) && s.description.toLowerCase().includes(query))]
								: skillsInTab;
							const activeRoot = skillsData.roots[skillsTab];
							const projectLocked = skillsTab === "project" && !skillsData.projectTrusted;
							return (
								<>
									<SectionHeader title={t("settings.skills.title")} desc={t("settings.skills.desc")} />

									{/* 三级 tab：个人 / 全局 / 项目 */}
									<div className="mb-1 flex items-center gap-2">
										{SKILL_TABS.map(({ tab, labelKey }) => (
											<button
												key={tab}
												type="button"
												className={`${skillsTab === tab ? "owl-settings-button is-primary" : "owl-settings-button"} px-3 py-1 text-[11px]`}
												onClick={() => {
													setSkillsTab(tab);
													setSkillForm(null);
												}}
											>
												{t(labelKey)}
												<span className="ml-1.5 text-[10px] opacity-70">
													{skillsData.skills.filter((s) => s.tab === tab).length}
												</span>
											</button>
										))}
									</div>
									<div className="mb-3 truncate font-mono text-[10px] text-owl-faint">{activeRoot || "—"}</div>

									{projectLocked && (
										<div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-owl-muted">
											{t("settings.skills.projectLocked")}
										</div>
									)}

									{/* 项目 tab：选择要管理的项目 + 勾选本项目需要的技能 */}
									{skillsTab === "project" && !projectLocked && (() => {
										const choices = projectSkillChoices();
										const enabledCount = choices.filter((s) => s.projectEnabled).length;
										const customPatterns = skillsData.projectSkillPatterns.some(
											(p) => p.startsWith("+") || p.startsWith("-") || p.startsWith("!"),
										);
										const tabBadge = { personal: t("settings.skills.tabPersonal"), global: t("settings.skills.tabGlobal"), project: t("settings.skills.tabProject") } as const;
										return (
											<>
												<div className="mb-3 text-[11px] leading-relaxed text-owl-muted">{t("settings.skills.projectTabDesc")}</div>

												{/* 项目选择 + 添加项目 */}
												<div className="mb-2 flex items-center gap-2">
													<span className="shrink-0 text-[11px] text-owl-muted">{t("settings.skills.projectPickerLabel")}</span>
													<select
														className={`${smallInput} min-w-0 flex-1`}
														value={skillProject}
														onChange={(event) => switchSkillProject(event.target.value)}
													>
														<option value="">{t("settings.skills.projectCurrentWorkspace")}{workspaceDir ? `（${workspaceDir}）` : ""}</option>
														{skillProjects.map((project) => (
															<option key={project} value={project}>
																{project}
															</option>
														))}
													</select>
												</div>
												<div className="mb-3 flex items-center gap-2">
													<input
														className={`${smallInput} min-w-0 flex-1`}
														value={skillAddProject}
														onChange={(event) => setSkillAddProject(event.target.value)}
														placeholder={t("settings.skills.addProjectPlaceholder")}
														onKeyDown={(event) => {
															if (event.key === "Enter") addSkillProject();
														}}
													/>
													<button type="button" className={`${btn} shrink-0`} disabled={busy || !skillAddProject.trim()} onClick={addSkillProject}>
														{t("settings.skills.addProjectBtn")}
													</button>
												</div>

												{/* 勾选本项目需要的技能 */}
												<div className="relative mb-3">
													<button
														type="button"
														className={`${btn} w-full justify-between`}
														onClick={() => setSkillPickerOpen((open) => !open)}
													>
														<span>{t("settings.skills.pickerBtn", { enabled: enabledCount, total: choices.length })}</span>
														<span aria-hidden="true">{skillPickerOpen ? "▲" : "▼"}</span>
													</button>
													{skillPickerOpen && (
														<div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-owl-border bg-owl-panel shadow-lg">
															{customPatterns && (
																<div className="border-b border-owl-border/60 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-owl-muted">
																	{t("settings.skills.pickerCustomNotice")}
																</div>
															)}
															{choices.length === 0 && (
																<div className="px-3 py-3 text-center text-xs text-owl-faint">{t("settings.skills.emptyDir")}</div>
															)}
															{choices.map((entry) => (
																<label
																	key={`${entry.tab}:${entry.name}`}
																	className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-owl-border/20"
																>
																	<input
																		type="checkbox"
																		checked={entry.projectEnabled}
																		disabled={busy}
																		onChange={(event) => void toggleProjectSkill(entry.name, event.target.checked)}
																	/>
																	<span className="min-w-0 flex-1 truncate font-mono text-owl-text">{entry.name}</span>
																	<span className="shrink-0 rounded border border-owl-border px-1.5 py-px text-[10px] text-owl-faint">
																		{tabBadge[entry.tab]}
																	</span>
																</label>
															))}
															<div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-owl-border/60 bg-owl-panel px-3 py-2">
																<button
																	type="button"
																	className="owl-settings-link"
																	disabled={busy || skillsData.projectSkillPatterns.length === 0}
																	onClick={() => void resetProjectSkillSelection()}
																>
																	{t("settings.skills.pickerReset")}
																</button>
																<button type="button" className="owl-settings-link" onClick={() => setSkillPickerOpen(false)}>
																	{t("settings.skills.pickerClose")}
																</button>
															</div>
														</div>
													)}
												</div>
											</>
										);
									})()}

									{/* 搜索 + 新建 */}
									<div className="mb-3 flex items-center gap-2">
										<input
											className={`${smallInput} min-w-0 flex-1`}
											value={skillsQuery}
											onChange={(event) => setSkillsQuery(event.target.value)}
											placeholder={t("settings.skills.searchPlaceholder")}
											onKeyDown={(event) => {
												if (event.key === "Escape") setSkillsQuery("");
											}}
										/>
										<button
											type="button"
											className={`${btnAccent} shrink-0`}
											disabled={busy || projectLocked}
											onClick={() => {
												setSkName("");
												setSkDesc("");
												setSkBody("");
												setSkillForm({ mode: "create" });
											}}
										>
											{t("settings.skills.create")}
										</button>
									</div>

									{/* 创建 / 编辑表单 */}
									{skillForm && (
										<div className="owl-settings-card mb-3 space-y-3">
											{skillForm.mode === "create" ? (
												<label className="block text-[11px] text-owl-muted">
													{t("settings.skills.nameLabel")}
													<input
														className={`${smallInput} mt-1`}
														value={skName}
														onChange={(event) => setSkName(event.target.value)}
														placeholder={t("settings.skills.namePlaceholder")}
													/>
												</label>
											) : (
												<div className="text-[11px] text-owl-muted">
													{t("settings.skills.editingPrefix")} <span className="font-mono text-owl-text">{skillForm.entry.name}</span>
													<span className="ml-2 font-mono text-[10px] text-owl-faint">{skillForm.entry.path}</span>
												</div>
											)}
											<label className="block text-[11px] text-owl-muted">
												{t("settings.skills.descLabel")}
												<input
													className={`${smallInput} mt-1`}
													value={skDesc}
													onChange={(event) => setSkDesc(event.target.value)}
													placeholder={t("settings.skills.descPlaceholder")}
												/>
											</label>
											<label className="block text-[11px] text-owl-muted">
												{t("settings.skills.bodyLabel")}
												<textarea
													className={`${smallInput} mt-1 min-h-[180px] font-mono text-[11px]`}
													value={skBody}
													onChange={(event) => setSkBody(event.target.value)}
													placeholder={t("settings.skills.bodyPlaceholder")}
												/>
											</label>
											<div className="flex justify-end gap-2">
												<button type="button" className={btn} onClick={() => setSkillForm(null)}>
													{t("common.cancel")}
												</button>
												<button
													type="button"
													className={btnAccent}
													disabled={busy || (skillForm.mode === "create" ? !skName.trim() : false) || !skDesc.trim()}
													onClick={() => void saveSkillForm()}
												>
													{skillForm.mode === "create" ? t("settings.skills.createBtn") : t("settings.skills.saveBtn")}
												</button>
											</div>
										</div>
									)}

									{/* 列表 */}
									<div className="owl-settings-plugin-list">
										{skillsLoading && visibleSkills.length === 0 && (
											<div className="rounded-xl border border-dashed border-owl-border px-3 py-3 text-center text-xs text-owl-faint">
												{t("settings.skills.loading")}
											</div>
										)}
										{!skillsLoading && visibleSkills.length === 0 && (
											<div className="rounded-xl border border-dashed border-owl-border px-3 py-3 text-center text-xs text-owl-faint">
												{query ? t("settings.skills.noMatch") : t("settings.skills.emptyDir")}
											</div>
										)}
										{visibleSkills.map((entry) => (
											<div key={`${entry.tab}:${entry.path}`} className={`owl-settings-plugin-row ${entry.disabled ? "opacity-55" : ""}`}>
												<div className="flex min-w-0 items-center gap-2">
													{entry.isSymlink && (
														<span className="shrink-0 rounded border border-sky-400/30 px-1.5 py-px text-[10px] text-sky-400" title={t("settings.skills.symlinkTitle")}>
															{t("settings.skills.symlinkBadge")}
														</span>
													)}
													<div className="min-w-0">
														<span className="block truncate font-mono text-xs text-owl-text">{entry.name}</span>
														<span className="mt-0.5 block truncate text-[10px] text-owl-faint" title={entry.description}>
															{entry.description}
														</span>
													</div>
												</div>
												<div className="ml-2 flex shrink-0 items-center gap-2.5">
													<span className={`text-[10px] ${entry.disabled ? "text-owl-faint" : "text-emerald-400"}`}>
														{entry.disabled ? t("settings.skills.manualOnly") : t("settings.skills.modelAvailable")}
													</span>
													<Switch
														checked={!entry.disabled}
														disabled={busy}
														title={entry.disabled ? t("settings.skills.enableAutoTitle") : t("settings.skills.disableAutoTitle")}
														onChange={(next) => void toggleSkill(entry, next)}
													/>
													<button
														type="button"
														className="owl-settings-link disabled:opacity-40"
														disabled={busy || entry.isSymlink}
														title={entry.isSymlink ? t("settings.skills.symlinkEditTitle") : t("settings.skills.editTitle")}
														onClick={() => void openSkillEditor(entry)}
													>
														{t("common.edit")}
													</button>
													<button
														type="button"
														className="owl-settings-link is-danger disabled:opacity-40"
														disabled={busy || entry.isSymlink}
														title={entry.isSymlink ? t("settings.skills.symlinkDeleteTitle") : t("settings.skills.deleteRowTitle")}
														onClick={() => setConfirmDelSkill(entry)}
													>
														{t("common.delete")}
													</button>
												</div>
											</div>
										))}
									</div>

									{/* 删除确认 */}
									{confirmDelSkill && (
										<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
											<div className="owl-settings-card w-[min(420px,90vw)] space-y-3">
												<div className="text-xs font-semibold text-owl-text">{t("settings.skills.deleteConfirmTitle", { name: confirmDelSkill.name })}</div>
												<div className="text-[11px] leading-relaxed text-owl-muted">
													{t("settings.skills.deleteConfirmPre")}
													<span className="font-mono">{skillsData.roots[confirmDelSkill.tab]}/.trash</span>
													{t("settings.skills.deleteConfirmPost")}
												</div>
												<div className="flex justify-end gap-2">
													<button type="button" className={btn} onClick={() => setConfirmDelSkill(null)}>
														{t("common.cancel")}
													</button>
													<button type="button" className={`${btnAccent} !bg-red-500/90 hover:!bg-red-500`} disabled={busy} onClick={() => void deleteSkillEntry(confirmDelSkill)}>
														{t("common.delete")}
													</button>
												</div>
											</div>
										</div>
									)}
								</>
							);
						})()}

						{/* -------- 侧边卡片 -------- */}
						{section === "sidebar" && (
							<>
								<SectionHeader title={t("settings.sidecards.title")} desc={t("settings.sidecards.desc")} />

								{/* 插件身份行：内置侧边工作台 + 打开配置文件 */}
								<div className="owl-settings-card flex items-center justify-between gap-4">
									<div className="flex min-w-0 items-center gap-2">
										<span className="shrink-0 rounded border border-emerald-400/30 px-1.5 py-px text-[10px] text-emerald-400">{t("settings.sidecards.builtinBadge")}</span>
										<span className="text-xs font-semibold text-owl-text">owl-workbench</span>
										<span className="truncate text-[10px] text-owl-faint">{t("settings.sidecards.builtinSubtitle")}</span>
									</div>
									<button type="button" className={`${btn} shrink-0`} disabled={!agentDir} onClick={openSidebarConfigFile}>
										{t("settings.sidecards.openConfig")}
									</button>
								</div>

								{/* 常规 */}
								<div className="pt-1 text-xs font-semibold text-owl-muted">{t("settings.sidecards.general")}</div>
								<SettingRow
									title={t("settings.sidecards.injectOpenTool")}
									desc={t("settings.sidecards.injectOpenToolDesc")}
									control={
										<Switch
											checked={sidebarCfg.injectOpenTool}
											disabled={busy}
											onChange={(next) => saveSidebar({ ...sidebarCfg, injectOpenTool: next })}
										/>
									}
								/>

								{/* 侧边栏内容 */}
								<div className="flex items-center gap-2 pt-1 text-xs font-semibold text-owl-muted">
									{t("settings.sidecards.sidebarContent")}
									<span className="rounded-full border border-owl-border px-1.5 text-[10px] font-normal text-owl-faint">
										{QUICK_ACTIONS.filter((action) => isTabKindEnabled(action.kind, sidebarCfg)).length}
									</span>
								</div>
								<div className="grid grid-cols-2 gap-3">
									{QUICK_ACTIONS.map((action) => {
										const enabled = isTabKindEnabled(action.kind, sidebarCfg);
										return (
											<div
												key={action.kind}
												className={`owl-settings-card transition-opacity ${enabled ? "" : "opacity-55"}`}
											>
												<div className="flex items-start justify-between gap-2">
													<div className="flex min-w-0 items-center gap-2">
														<span
															className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-owl-border/60 bg-owl-panel"
															style={{ color: action.color }}
														>
															{action.icon(14)}
														</span>
														<div className="min-w-0">
															<div className="truncate text-xs font-semibold text-owl-text">{action.label}</div>
															<div className="truncate font-mono text-[10px] text-owl-faint">{action.kind}</div>
														</div>
													</div>
													<Switch checked={enabled} onChange={(next) => toggleSidebarTab(action.kind, next)} />
												</div>
											</div>
										);
									})}
									<button
										type="button"
										disabled
										title={t("settings.sidecards.addTabPluginTitle")}
										className="flex min-h-[58px] cursor-default flex-col justify-center gap-1 rounded-xl border border-dashed border-owl-border p-2.5 text-left opacity-60"
									>
										<span className="flex items-center gap-2 text-xs font-semibold text-owl-muted">
											<span className="text-base leading-none text-owl-faint">+</span> {t("settings.sidecards.addTabPlugin")}
										</span>
										<span className="text-[10px] text-owl-faint">{t("settings.sidecards.addTabPluginSub")}</span>
									</button>
								</div>

								{/* 文件预览 */}
								<div className="flex items-center gap-2 pt-1 text-xs font-semibold text-owl-muted">
									{t("settings.sidecards.filePreview")}
									<span className="rounded-full border border-owl-border px-1.5 text-[10px] font-normal text-owl-faint">
										{2 - sidebarCfg.disabledViewers.filter((kind) => kind === "image" || kind === "editor").length}
									</span>
								</div>
								<div className="grid grid-cols-2 gap-3">
									{(
										[
											{ kind: "image", label: t("settings.sidecards.viewerImage"), sub: t("settings.sidecards.viewerImageSub") },
											{ kind: "editor", label: t("settings.sidecards.viewerCode"), sub: t("settings.sidecards.viewerCodeSub") },
										] as const
									).map((viewer) => {
										const enabled = !sidebarCfg.disabledViewers.includes(viewer.kind);
										return (
											<div
												key={viewer.kind}
												className={`owl-settings-card transition-opacity ${enabled ? "" : "opacity-55"}`}
											>
												<div className="flex items-start justify-between gap-2">
													<div className="flex min-w-0 items-center gap-2">
														<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-owl-border/60 bg-owl-panel font-mono text-xs text-owl-muted">
															{viewer.kind === "image" ? "🖼" : "#"}
														</span>
														<div className="min-w-0">
															<div className="truncate text-xs font-semibold text-owl-text">{viewer.label}</div>
															<div className="truncate font-mono text-[10px] text-owl-faint">{viewer.sub}</div>
														</div>
													</div>
													<Switch checked={enabled} onChange={(next) => toggleSidebarViewer(viewer.kind, next)} />
												</div>
											</div>
										);
									})}
									<button
										type="button"
										disabled
										title={t("settings.sidecards.addPreviewPluginTitle")}
										className="flex min-h-[58px] cursor-default flex-col justify-center gap-1 rounded-xl border border-dashed border-owl-border p-2.5 text-left opacity-60"
									>
										<span className="flex items-center gap-2 text-xs font-semibold text-owl-muted">
											<span className="text-base leading-none text-owl-faint">+</span> {t("settings.sidecards.addPreviewPlugin")}
										</span>
										<span className="text-[10px] text-owl-faint">{t("settings.sidecards.addPreviewPluginSub")}</span>
									</button>
								</div>

								<p className="text-[11px] leading-relaxed text-owl-faint">
									{t("settings.sidecards.footnote")}
								</p>
							</>
						)}

						{/* -------- 外观 -------- */}
						{section === "appearance" && (
							<>
								<SectionHeader title={t("settings.appearance.title")} desc={t("settings.appearance.desc")} />
								<SettingRow
									title={t("settings.appearance.theme")}
									desc={t("settings.appearance.themeDesc")}
								>
									<div className="owl-settings-theme-grid" role="group" aria-label={t("settings.appearance.theme")}>
										{([
											{ value: "light", label: t("settings.appearance.light") },
											{ value: "dark", label: t("settings.appearance.dark") },
											{ value: "system", label: t("settings.appearance.system") },
										] as const).map((option) => (
											<button
												key={option.value}
												type="button"
												className={`owl-settings-theme-card ${theme === option.value ? "is-active" : ""}`}
												aria-pressed={theme === option.value}
												disabled={busy}
												onClick={() => {
													void saveSettings({ theme: option.value }).then((ok) => {
														if (ok && isThemePreference(option.value)) setThemePreference(option.value);
													});
												}}
											>
												<div className={`owl-settings-theme-preview is-${option.value}`} aria-hidden="true">
													<div className="owl-settings-theme-preview-sidebar"><i /><i /><i /></div>
													<div className="owl-settings-theme-preview-main"><i /><i /><b /></div>
												</div>
												<div className="owl-settings-theme-label"><span>{option.label}</span>{theme === option.value && <span className="owl-settings-theme-check" aria-hidden="true">✓</span>}</div>
											</button>
										))}
									</div>
								</SettingRow>
								<div className="owl-settings-notice">{t("settings.appearance.note")}</div>
							</>
						)}

						{/* -------- 归档 -------- */}
						{section === "archived" && (
							<>
								<SectionHeader
									title={t("settings.archive.title")}
										desc={t("settings.archive.desc")}
								/>
								<SettingRow
									title={t("settings.archive.retention")}
									desc={t("settings.archive.retentionDesc", { n: archiveCfg.retentionDays })}
									control={
										<div className="flex items-center gap-1.5">
											<input
												className="w-16 rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1 text-right font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
												value={retentionInput}
												disabled={busy}
												onChange={(event) => setRetentionInput(event.target.value.replace(/\D/g, ""))}
												onKeyDown={(event) => {
													if (event.key === "Enter") void saveRetention();
												}}
											/>
											<span className="text-[11px] text-owl-faint">{t("settings.archive.days")}</span>
											<button type="button" className={btnAccent} disabled={busy} onClick={() => void saveRetention()}>
												{t("common.save")}
											</button>
										</div>
									}
								/>
								<div className="owl-settings-notice is-warning">{t("settings.archive.notice")}</div>
								<SettingRow title={t("settings.archive.listTitle", { n: archiveCfg.sessions.length })} desc={t("settings.archive.listDesc")}>
									{archiveCfg.sessions.length === 0 ? (
										<p className="text-[11px] text-owl-faint">{t("settings.archive.none")}</p>
									) : (
										<div className="owl-settings-archive-list">
											<div className="owl-settings-archive-header"><span>{t("settings.archive.colSession")}</span><span>{t("settings.archive.colStatus")}</span></div>
											{[...archiveCfg.sessions]
												.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1))
												.map((entry) => {
													const left = daysLeft(entry.archivedAt, archiveCfg.retentionDays);
													const row = sessionTitles[entry.sessionId];
													const title = sessionDisplayName(row ?? { id: entry.sessionId });
													const origin = row?.cwd ? projectLabel(row.cwd) : "";
													return (
														<div
															key={entry.sessionId}
															className="owl-settings-archive-row"
														>
															<div className="min-w-0 flex-1">
																<div className="truncate text-xs text-owl-text" title={title}>
																	{title}
																</div>
																<div className="mt-0.5 text-[10px] text-owl-faint">
																	{t("settings.archive.archivedAt", { time: formatDateTime(entry.archivedAt) })}
																	{origin ? t("settings.archive.fromProject", { origin }) : ""}
																</div>
															</div>
															<div className="text-right">
																<div className={`mb-2 text-xs ${left <= 2 ? "owl-settings-archive-warning" : "text-owl-muted"}`}>
																	{left > 0 ? t("settings.archive.deleteIn", { n: left }) : t("settings.archive.pendingCleanup")}
																</div>
																<div className="owl-settings-archive-actions">
																	<button
																		type="button"
																		className={btn}
																		disabled={busy}
																		onClick={() => void restoreArchived(entry.sessionId)}
																	>
																		{t("common.restore")}
																	</button>
																	{confirmDelId === entry.sessionId ? (
																		<>
																			<button
																				type="button"
																				className={`${btn} is-danger`}
																				disabled={busy}
																				onClick={() => void deleteArchived(entry.sessionId)}
																			>
																				{t("common.deleteForever")}
																			</button>
																			<button type="button" className={btn} onClick={() => setConfirmDelId(null)}>
																				{t("common.cancel")}
																			</button>
																		</>
																	) : (
																		<button
																			type="button"
																			className={`${btn} is-danger`}
																			onClick={() => setConfirmDelId(entry.sessionId)}
																		>
																			{t("common.delete")}
																		</button>
																	)}
																</div>
																{confirmDelId === entry.sessionId && <p className="owl-settings-archive-warning mt-2">{t("settings.archive.deleteWarn")}</p>}
															</div>
														</div>
													);
												})}
										</div>
									)}
								</SettingRow>
							</>
						)}

						{/* -------- 提示词 -------- */}
						{section === "prompts" && (
							<>
								<SectionHeader
									title={t("settings.prompts.title")}
									desc={t("settings.prompts.desc")}
								/>
								<SettingRow
									title={t("settings.prompts.customTitle")}
									desc={t("settings.prompts.customDesc")}
									control={
										<button
											type="button"
											className={btnAccent}
											disabled={busy}
											onClick={() => void saveSettings({ owlCustomPrompt: customPrompt })}
										>
											{t("common.save")}
										</button>
									}
								>
									<textarea
										className="h-40 w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
										value={customPrompt}
										onChange={(event) => setCustomPrompt(event.target.value)}
										placeholder={t("settings.prompts.customPlaceholder")}
										spellCheck={false}
									/>
								</SettingRow>
								<SettingRow
									title={t("settings.prompts.impressionTitle")}
									desc={t("settings.prompts.impressionDesc")}
									control={
										<button
											type="button"
											className={btnAccent}
											disabled={busy}
											onClick={() => void saveSettings({ owlUserImpression: userImpression })}
										>
											{t("common.save")}
										</button>
									}
								>
									<textarea
										className="h-40 w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
										value={userImpression}
										onChange={(event) => setUserImpression(event.target.value)}
										placeholder={t("settings.prompts.impressionPlaceholder")}
									/>
								</SettingRow>
								<SettingRow
									title={t("settings.prompts.builtinTitle")}
									desc={t("settings.prompts.builtinDesc")}
								>
									<div className="space-y-1.5">
										{Object.keys(builtinSections).length === 0 && (
											<p className="text-[11px] text-owl-faint">{t("settings.prompts.builtinNotLoaded")}</p>
										)}
										{Object.entries(builtinSections).map(([name, content]) => (
											<details key={name} className="rounded-lg border border-owl-border bg-owl-sidebar/40">
												<summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs text-owl-text transition-colors hover:text-owl-accent">
													{BUILTIN_SECTION_TITLES[name] ? t(BUILTIN_SECTION_TITLES[name]) : name}
												</summary>
												<pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-owl-border/60 px-2.5 pb-2 pt-1.5 font-mono text-[11px] leading-relaxed text-owl-muted">
													{content}
												</pre>
											</details>
										))}
									</div>
								</SettingRow>
							</>
						)}

						{/* -------- 跨会话记忆 -------- */}
						{section === "memory" && (
							<>
								<SectionHeader
									title={t("settings.memory.title")}
									desc={t("settings.memory.desc")}
								/>
								<SettingRow
									title={t("settings.memory.enableTitle")}
									desc={t("settings.memory.enableDesc")}
									control={
										<button
											type="button"
											className={`${btn} ${memory.enabled ? "border-owl-accent/60 text-owl-accent" : ""}`}
											disabled={busy}
											onClick={() => void toggleMemory()}
										>
											{memory.enabled ? t("settings.memory.on") : t("settings.memory.off")}
										</button>
									}
								/>
								<SettingRow
									title={t("settings.memory.listTitle", { n: memory.entries.length })}
									desc={t("settings.memory.listDesc")}
									control={
										memory.entries.length > 0 ? (
											confirmClearMemory ? (
												<div className="flex gap-1.5">
													<button
														type="button"
														className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-red-400 disabled:opacity-40"
														disabled={busy}
														onClick={() => void clearAllMemory()}
													>
														{t("common.confirmClear")}
													</button>
													<button type="button" className={btn} onClick={() => setConfirmClearMemory(false)}>
														{t("common.cancel")}
													</button>
												</div>
											) : (
												<button
													type="button"
													className={`${btn} hover:border-red-500/60 hover:text-red-300`}
													disabled={busy}
													onClick={() => setConfirmClearMemory(true)}
												>
													{t("settings.memory.clearAll")}
												</button>
											)
										) : undefined
									}
								>
									{memory.entries.length === 0 ? (
										<p className="text-[11px] text-owl-faint">
											{t("settings.memory.empty")}
										</p>
									) : (
										<div className="space-y-1.5">
											{memory.entries.map((entry, index) => (
												<div
													key={entry.id}
													className="flex items-start gap-2 rounded-lg bg-owl-sidebar/60 px-2.5 py-2"
												>
													<div className="min-w-0 flex-1">
														<div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-owl-text">
															{entry.content}
														</div>
														<div className="mt-1 text-[10px] text-owl-faint">
															#{index + 1} · {t("settings.memory.recordedAt", { time: formatDateTime(entry.createdAt) })}
															{entry.sourceCwd ? t("settings.memory.fromSource", { src: entry.sourceCwd }) : ""}
														</div>
													</div>
													{confirmDelMemoryId === entry.id ? (
														<div className="flex shrink-0 gap-1.5">
															<button
																type="button"
																className="rounded-lg bg-red-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-400 disabled:opacity-40"
																disabled={busy}
																onClick={() => void deleteMemoryEntry(entry.id)}
															>
																{t("common.confirmDelete")}
															</button>
															<button type="button" className={btn} onClick={() => setConfirmDelMemoryId(null)}>
																{t("common.cancel")}
															</button>
														</div>
													) : (
														<button
															type="button"
															className={`${btn} shrink-0 hover:border-red-500/60 hover:text-red-300`}
															disabled={busy}
															onClick={() => setConfirmDelMemoryId(entry.id)}
															title={t("settings.memory.deleteTitle")}
														>
															<IconTrash className="h-3.5 w-3.5" />
														</button>
													)}
												</div>
											))}
										</div>
									)}
								</SettingRow>
							</>
						)}

						{/* -------- settings.json（高级） -------- */}
						{section === "json" && (
							<>
								<SectionHeader title={t("settings.json.title")} desc={t("settings.json.desc")} />
								<div className="owl-settings-notice">{t("settings.json.notice")}</div>
								<textarea
									className="owl-settings-json-editor"
									aria-label={t("settings.json.editorAria")}
									value={raw}
									onChange={(event) => setRaw(event.target.value)}
									spellCheck={false}
								/>
								<div className="flex justify-end">
									<button
										type="button"
										className={btnAccent}
										disabled={busy}
										onClick={() => {
											void (async () => {
												try {
													const values = JSON.parse(raw) as Record<string, unknown>;
													await saveSettings(values);
												} catch (error) {
													setError(error instanceof Error ? error.message : String(error));
												}
											})();
										}}
									>
										{t("settings.json.save")}
									</button>
								</div>
							</>
						)}

						{/* -------- 关于 -------- */}
						{section === "about" && (
							<>
								<SectionHeader title={t("settings.about.title")} desc={t("settings.about.desc")} />
								<div className="owl-settings-about-brand">
									<img src="/owl.svg" alt="" draggable={false} />
									<div><h3>Owl</h3><p className="owl-settings-row-description">{t("settings.about.desktop")} · {version ? `v${version}` : t("settings.about.versionUnknown")}</p></div>
								</div>
								<SettingRow title={t("settings.about.basis")} desc={t("settings.about.basisDesc")}>
									<span className="text-xs text-owl-muted">{t("settings.about.basisValue")}</span>
								</SettingRow>
								<SettingRow title={t("settings.about.dataDir")} desc={t("settings.about.dataDirDesc")}>
									<span className="break-all font-mono text-xs text-owl-muted">{agentDir || "—"}</span>
								</SettingRow>
								<SettingRow title={t("settings.about.configuredModels")} desc={t("settings.about.configuredModelsDesc")}>
									<span className="text-xs text-owl-muted">
										{t("settings.models.providerModelCount", { providers: groups.length, models: modelCount })}
									</span>
								</SettingRow>
							</>
						)}
					</div>
				</div>

				{/* ============ 底部 ============ */}
				<div className="owl-settings-footer">
					<span className={savedMsg ? "owl-settings-save-status is-saved" : "owl-settings-save-status"} role="status" aria-live="polite">
						{busy ? t("common.processing") : savedMsg || t("settings.footer.status")}
					</span>
					<button type="button" className={btn} onClick={onClose}>{t("common.done")}</button>
				</div>
			</div>

			{confirmProvider && (
				<div className="owl-settings-modal-shade" onClick={() => setConfirmProviderId(null)}>
					<div className="owl-settings-modal" role="alertdialog" aria-modal="true" aria-labelledby="owl-provider-delete-title" aria-describedby="owl-provider-delete-description" onClick={(event) => event.stopPropagation()}>
						<h3 id="owl-provider-delete-title">{t("settings.providerDelete.title")}</h3>
						<p id="owl-provider-delete-description">{t("settings.providerDelete.desc", { name: confirmProvider.name ?? confirmProvider.id, n: confirmProvider.models.length })}</p>
						<p>{t("settings.providerDelete.reAdd")}</p>
						<div className="mt-6 flex justify-end gap-2">
							<button type="button" className={btn} autoFocus onClick={() => setConfirmProviderId(null)}>{t("common.cancel")}</button>
							<button type="button" className={`${btn} is-danger`} disabled={busy} onClick={() => {
								setConfirmProviderId(null);
								void run({ type: "models.removeProvider", providerKey: confirmProvider.id });
							}}>{t("settings.providerDelete.confirm")}</button>
						</div>
					</div>
				</div>
			)}

			{/* ============ 登录 / 保存 Key 成功弹窗 ============ */}
			{authSuccess && (
				<div className="owl-settings-modal-shade" onClick={() => setAuthSuccess(null)}>
					<div
						className="owl-settings-modal text-center"
						role="dialog"
						aria-modal="true"
						aria-label={authSuccess.title}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-lg text-emerald-400">✓</div>
						<div className="mt-3 text-sm font-semibold text-owl-text">{authSuccess.title}</div>
						<div className="mt-1 text-xs leading-relaxed text-owl-muted">{authSuccess.message}</div>
						<button type="button" className={`${btnAccent} mt-4 w-full py-1.5`} onClick={() => setAuthSuccess(null)}>
							{t("settings.auth.known")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
