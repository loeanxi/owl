import type { RailView } from "./components/ActivityRail.tsx";
import type { ConversationView } from "./components/ConversationHeader.tsx";
import { matchesSessionScope } from "./components/sidebar-scope.ts";
import { DEFAULT_WORKSPACE_DIR, normPath } from "./utils/paths.ts";

export type WorkspaceSettingsSection = "general" | "accounts" | "models" | "plugins" | "skills" | "presets" | "sidebar" | "prompts" | "memory" | "image" | "appearance" | "notifications" | "usage" | "archived" | "json" | "diagnostics" | "execution-anomalies" | "changelog" | "about";

export interface WorkspaceScrollPosition {
	top: number;
	left: number;
	/** 跟随最新消息的会话恢复到底部；阅读历史消息时保留原位置。 */
	atBottom?: boolean;
}

/** 保存用户最后停留的一屏，不通过会话的修改时间推测位置。 */
export interface WorkspaceMemory {
	version: 1;
	savedAt: number;
	rail: RailView;
	settings: boolean;
	settingsTab: WorkspaceSettingsSection;
	chatSession?: string;
	researchSession?: string;
	workspace: string;
	workspaceSelected: boolean;
	researchWorkspace: string;
	researchWorkspaceSelected: boolean;
	conversationView: ConversationView;
	researchConversationView: ConversationView;
	sidebarMinimized: boolean;
	newsSidebarMinimized: boolean;
	sidebarOpen: boolean;
	terminalOpen: boolean;
	developerLayout: boolean;
	/** key 包含页面/会话/视图；整个快照另按 profile 隔离。 */
	scroll: Record<string, WorkspaceScrollPosition>;
}

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;
type WorkspaceSessionRow = { id?: string; cwd?: string; scope?: unknown; archivedAt?: unknown };

const RAILS: readonly RailView[] = ["manager", "chat", "automation", "map", "news", "mail", "evaluation", "media", "projects", "research", "guide", "myself", "expert", "career", "bagu", "market", "account"];
const SETTINGS_SECTIONS: readonly WorkspaceSettingsSection[] = ["general", "accounts", "models", "plugins", "skills", "presets", "sidebar", "prompts", "memory", "image", "appearance", "notifications", "usage", "archived", "json", "diagnostics", "execution-anomalies", "changelog", "about"];
const MAX_SCROLL_PLACES = 80;
const MAX_STORED_BYTES = 128_000;

export function workspaceMemoryKey(profile: string): string {
	return `owl.workspace.memory.v1:${encodeURIComponent(normPath(profile.trim()))}`;
}

export function workspaceScrollKey(place: Pick<WorkspaceMemory, "rail" | "settings" | "settingsTab" | "chatSession" | "researchSession" | "workspace" | "researchWorkspace" | "conversationView" | "researchConversationView">, surface: string): string {
	if (place.settings) return JSON.stringify(["settings", place.settingsTab, surface]);
	const research = place.rail === "research";
	return JSON.stringify([
		place.rail,
		research ? place.researchSession : place.chatSession,
		normPath(research ? place.researchWorkspace : place.workspace),
		research ? place.researchConversationView : place.conversationView,
		surface,
	]);
}

export function defaultWorkspaceMemory(): WorkspaceMemory {
	return {
		version: 1,
		savedAt: 0,
		rail: "chat",
		settings: false,
		settingsTab: "general",
		workspace: DEFAULT_WORKSPACE_DIR,
		workspaceSelected: false,
		researchWorkspace: DEFAULT_WORKSPACE_DIR,
		researchWorkspaceSelected: false,
		conversationView: "chat",
		researchConversationView: "chat",
		sidebarMinimized: false,
		newsSidebarMinimized: false,
		sidebarOpen: false,
		terminalOpen: false,
		developerLayout: false,
		scroll: {},
	};
}

/** 损坏字段逐项回退，未知版本/非对象则不恢复。 */
export function sanitizeWorkspaceMemory(value: unknown, fallback: WorkspaceMemory = defaultWorkspaceMemory()): WorkspaceMemory | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	if (data.version !== 1) return undefined;
	const rail = RAILS.find((candidate) => candidate === data.rail) ?? fallback.rail;
	const settingsTab = SETTINGS_SECTIONS.find((candidate) => candidate === data.settingsTab) ?? fallback.settingsTab;
	const workspace = typeof data.workspace === "string" && data.workspace.trim() ? data.workspace : fallback.workspace;
	const researchWorkspace = typeof data.researchWorkspace === "string" && data.researchWorkspace.trim() ? data.researchWorkspace : fallback.researchWorkspace;
	const scroll: Record<string, WorkspaceScrollPosition> = {};
	if (data.scroll && typeof data.scroll === "object" && !Array.isArray(data.scroll)) {
		for (const [key, raw] of Object.entries(data.scroll).slice(-MAX_SCROLL_PLACES)) {
			if (!key || key.length > 2_000 || key === "__proto__" || key === "constructor" || key === "prototype" || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const position = raw as Record<string, unknown>;
			if (typeof position.top !== "number" || !Number.isFinite(position.top) || position.top < 0 || typeof position.left !== "number" || !Number.isFinite(position.left) || position.left < 0) continue;
			scroll[key] = {
				top: Math.min(position.top, 10_000_000),
				left: Math.min(position.left, 10_000_000),
				...(typeof position.atBottom === "boolean" ? { atBottom: position.atBottom } : {}),
			};
		}
	}
	return {
		version: 1,
		savedAt: typeof data.savedAt === "number" && Number.isFinite(data.savedAt) && data.savedAt >= 0 ? data.savedAt : fallback.savedAt,
		rail,
		settings: typeof data.settings === "boolean" ? data.settings : fallback.settings,
		settingsTab,
		chatSession: typeof data.chatSession === "string" && data.chatSession.trim() && data.chatSession.length <= 4_000 ? data.chatSession : undefined,
		researchSession: typeof data.researchSession === "string" && data.researchSession.trim() && data.researchSession.length <= 4_000 ? data.researchSession : undefined,
		workspace,
		workspaceSelected: typeof data.workspaceSelected === "boolean" ? data.workspaceSelected : fallback.workspaceSelected,
		researchWorkspace,
		researchWorkspaceSelected: typeof data.researchWorkspaceSelected === "boolean" ? data.researchWorkspaceSelected : fallback.researchWorkspaceSelected,
		conversationView: data.conversationView === "context" || data.conversationView === "trajectory" || data.conversationView === "chat" ? data.conversationView : fallback.conversationView,
		researchConversationView: data.researchConversationView === "context" || data.researchConversationView === "trajectory" || data.researchConversationView === "chat" ? data.researchConversationView : fallback.researchConversationView,
		sidebarMinimized: typeof data.sidebarMinimized === "boolean" ? data.sidebarMinimized : fallback.sidebarMinimized,
		newsSidebarMinimized: typeof data.newsSidebarMinimized === "boolean" ? data.newsSidebarMinimized : fallback.newsSidebarMinimized,
		sidebarOpen: typeof data.sidebarOpen === "boolean" ? data.sidebarOpen : fallback.sidebarOpen,
		terminalOpen: typeof data.terminalOpen === "boolean" ? data.terminalOpen : fallback.terminalOpen,
		developerLayout: typeof data.developerLayout === "boolean" ? data.developerLayout : fallback.developerLayout,
		scroll,
	};
}

export function readWorkspaceMemory(storage: Pick<WorkspaceStorage, "getItem">, profile: string, fallback?: WorkspaceMemory): WorkspaceMemory | undefined {
	if (!normPath(profile.trim())) return undefined;
	try {
		const raw = storage.getItem(workspaceMemoryKey(profile));
		if (!raw || raw.length > MAX_STORED_BYTES) return undefined;
		return sanitizeWorkspaceMemory(JSON.parse(raw), fallback);
	} catch {
		return undefined;
	}
}

export function writeWorkspaceMemory(storage: Pick<WorkspaceStorage, "setItem">, profile: string, snapshot: WorkspaceMemory): boolean {
	if (!normPath(profile.trim())) return false;
	try {
		const safe = sanitizeWorkspaceMemory(snapshot);
		if (!safe) return false;
		const raw = JSON.stringify(safe);
		if (raw.length > MAX_STORED_BYTES) return false;
		storage.setItem(workspaceMemoryKey(profile), raw);
		return true;
	} catch {
		return false;
	}
}

/** 会话已删除/归档/改了作用域时恢复空白页；不能替换为别的「最近」会话。 */
export function resolveWorkspaceMemory(snapshot: WorkspaceMemory, rows: readonly WorkspaceSessionRow[]): WorkspaceMemory {
	const chat = snapshot.chatSession ? rows.find((row) => row.id === snapshot.chatSession && typeof row.archivedAt !== "string" && matchesSessionScope(row, "chat")) : undefined;
	const research = snapshot.researchSession ? rows.find((row) => row.id === snapshot.researchSession && typeof row.archivedAt !== "string" && matchesSessionScope(row, "research")) : undefined;
	return {
		...snapshot,
		chatSession: chat?.id,
		researchSession: research?.id,
		workspace: chat?.cwd || snapshot.workspace,
		researchWorkspace: research?.cwd || snapshot.researchWorkspace,
	};
}

export interface WorkspaceRestoreToken {
	revision: number;
}

/** 初始空页不写回；等待桥响应时用户操作可立即取消恢复。 */
export class WorkspaceRestoreGate {
	private revision = 0;
	private pending = true;
	private attempted = false;

	begin(): WorkspaceRestoreToken | undefined {
		if (this.attempted || !this.pending) return undefined;
		this.attempted = true;
		return { revision: this.revision };
	}

	canApply(token: WorkspaceRestoreToken): boolean {
		return this.pending && this.attempted && token.revision === this.revision;
	}

	markUserNavigation(): void {
		this.revision += 1;
		this.pending = false;
	}

	finish(token: WorkspaceRestoreToken): boolean {
		if (!this.canApply(token)) return false;
		this.pending = false;
		return true;
	}

	/** 桥暂时离线时继续保护旧快照，并让重连后重新尝试。 */
	retry(token: WorkspaceRestoreToken): boolean {
		if (!this.canApply(token)) return false;
		this.revision += 1;
		this.attempted = false;
		return true;
	}

	canSave(): boolean {
		return !this.pending;
	}
}
