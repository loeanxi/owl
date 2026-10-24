import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.tsx";
import type { ChatEntry } from "./hooks/transcript.ts";
import type { SessionSearchHit, SessionSearchMessageResult } from "./bridge/protocol.ts";
import type { MessageSearchTarget } from "./components/chat-message-navigation.ts";
import { t } from "./i18n/index.ts";
import type { SidebarStore } from "./sidebar/store.ts";
import type { BridgeClient } from "./bridge/client.ts";
import { createSidebarApi } from "./sidebar/api.ts";
import { EditorController } from "./sidebar/editor-controller.ts";

type ReplayCallbacks = {
	onRegenerate: () => void;
	onEditMessage: (entryId: string, text: string) => void;
	entries: ChatEntry[];
	searchTarget?: MessageSearchTarget;
	searchHistoryMessage?: SessionSearchMessageResult;
	sessionId?: string;
	cwd: string;
};
type SidebarCallbacks = { onNewChat: () => void; onOpenSession: (id: string) => void; onSelectProject: (path: string) => void; onNewChatInProject: (path: string) => void; onOpenSearchHit: (hit: SessionSearchHit, query: string) => void; activeId?: string; activeProject: string; sessionScope: "chat" | "research" };
type ResearchProps = { active: boolean; cwd: string; resumeRequest?: { id: string }; searchTarget?: MessageSearchTarget };
type ComposerInput = { draftRequest?: { text: string }; onSend: (message: string) => Promise<boolean>; sessionInfo?: { model?: { id: string } } };
const fixture = vi.hoisted(() => ({
	request: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
	status: undefined as ((up: boolean) => void) | undefined,
	chat: undefined as ReplayCallbacks | undefined,
	research: undefined as ResearchProps | undefined,
	sidebar: undefined as SidebarCallbacks | undefined,
	composer: undefined as ComposerInput | undefined,
	workbench: undefined as SidebarStore | undefined,
	editorProbe: false,
	editor: undefined as EditorController | undefined,
	workbenchProfile: undefined as string | undefined,
	workbenchConnected: false,
	recovery: undefined as { onContinue: (model?: string) => Promise<boolean> } | undefined,
	event: undefined as ((event: Record<string, unknown>) => void) | undefined,
	overlay: undefined as React.ReactNode | undefined,
}));
vi.mock("./bridge/client.ts", () => ({ BridgeClient: class {
	request = fixture.request;
	connect() {}
	onStatus(callback: (up: boolean) => void) { fixture.status = callback; return () => {}; }
	onSessionEvent(callback: (event: Record<string, unknown>) => void) { fixture.event = callback; return () => {}; }
	onPermissionRequest() { return () => {}; }
	onQuestionRequest() { return () => {}; }
	onNewsOpen() { return () => {}; }
	onIabMessage() { return () => {}; }
	onSidebarMessage() { return () => {}; }
	watchSessionEvents() { return () => {}; }
} }));
vi.mock("./bridge/native.ts", () => ({ hasTauri: () => false, setWebviewZoom: async () => {}, isWindowFullscreen: async () => false }));
vi.mock("./theme.ts", () => ({ isThemePreference: () => false, setThemeLock: () => {}, setThemePreference: () => {} }));
vi.mock("./components/SessionSidebar.tsx", () => ({ SessionSidebar: (props: SidebarCallbacks) => { fixture.sidebar = props; return null; } }));
vi.mock("./components/ChatStream.tsx", () => ({ ChatStream: (props: ReplayCallbacks) => { fixture.chat = props; return null; } }));
vi.mock("./components/Composer.tsx", () => ({ Composer: (props: ComposerInput) => { fixture.composer = props; return null; } }));
vi.mock("./components/AgentConversation.tsx", () => ({ AgentConversation: (props: { chat: React.ReactNode; composer: React.ReactNode; beforeComposer: React.ReactNode; overlay?: React.ReactNode }) => { fixture.overlay = props.overlay; return <>{props.overlay}{props.chat}{props.beforeComposer}{props.composer}</>; } }));
vi.mock("./components/Genui.tsx", () => ({ GenuiSessionProvider: (props: { children: React.ReactNode }) => props.children }));
vi.mock("./hooks/use-subagents.ts", () => ({ useSubagents: () => ({ runs: [], refresh: () => {} }) }));
vi.mock("./components/OwlMascot.tsx", () => ({ useSessionOwlPose: () => "idle" }));
vi.mock("./features/life-monitor/use-life-probe.ts", () => ({ useLifeProbe: () => ({ channels: [], round: "idle" }) }));
vi.mock("./use-workspace-memory.ts", () => ({ useWorkspaceMemory: () => {} }));
vi.mock("./sidebar/quick.tsx", () => ({ openQuickAction: () => {} }));
vi.mock("./components/ActivityRail.tsx", () => ({ ActivityRail: () => null }));
vi.mock("./components/AccountProfilePage.tsx", () => ({ AccountProfilePage: () => null }));
vi.mock("./map/MapWorkspace.tsx", () => ({ MapWorkspace: () => null }));
vi.mock("./features/news/NewsPage.tsx", () => ({ NewsPage: () => null }));
vi.mock("./features/mail/MailPage.tsx", () => ({ MailPage: () => null }));
vi.mock("./features/evaluation/EvaluationPage.tsx", () => ({ EvaluationPage: () => null }));
vi.mock("./features/research/ResearchPage.tsx", () => ({ ResearchPage: (props: ResearchProps) => { fixture.research = props; return null; } }));
vi.mock("./sidebar/tabs/ManagerTab.tsx", () => ({ ManagerTab: () => null }));
vi.mock("./features/media/MediaView.tsx", () => ({ MediaView: () => null }));
vi.mock("./features/projects/ProjectsPage.tsx", () => ({ ProjectsPage: () => null }));
vi.mock("./features/guide/GuidePanel.tsx", () => ({ GuidePanel: () => null }));
vi.mock("./features/token-career/TokenCareerPage.tsx", () => ({ TokenCareerPage: () => null }));
vi.mock("./features/automation/AutomationPage.tsx", () => ({ AutomationPage: () => null }));
vi.mock("./features/automation/SchedulePin.tsx", () => ({ SchedulePin: () => null }));
vi.mock("./features/myself/MyselfPanel.tsx", () => ({ MyselfPanel: () => null }));
vi.mock("./features/expert/ExpertPanel.tsx", () => ({ ExpertPanel: () => null }));
vi.mock("./features/bagu/BaguPage.tsx", () => ({ BaguPage: () => null }));
vi.mock("./features/market/MarketPage.tsx", () => ({ MarketPage: () => null }));
vi.mock("./features/media/MediaOverlays.tsx", () => ({ MediaOverlays: () => null }));
vi.mock("./components/ContextView.tsx", () => ({ ContextView: () => null }));
vi.mock("./features/trajectory/TrajectoryView.tsx", () => ({ TrajectoryView: () => null }));
vi.mock("./components/ConversationHeader.tsx", () => ({ ConversationHeader: () => null }));
vi.mock("./components/TaskRecoveryNotice.tsx", () => ({ TaskRecoveryNotice: (props: { onContinue: (model?: string) => Promise<boolean> }) => { fixture.recovery = props; return null; } }));
vi.mock("./components/ReviewChangesCard.tsx", () => ({ TurnArtifacts: () => null }));
vi.mock("./components/PermissionDialog.tsx", () => ({ PermissionDialog: () => null }));
vi.mock("./components/RewindDialog.tsx", () => ({ RewindDialog: () => null }));
vi.mock("./components/SessionShareDialog.tsx", () => ({ SessionShareDialog: () => null }));
vi.mock("./components/SubagentView.tsx", () => ({ selectedSubagent: () => undefined, SubagentView: () => null }));
vi.mock("./components/SubagentPin.tsx", () => ({ SubagentPin: () => null }));
vi.mock("./components/DesktopTitlebar.tsx", () => ({ DesktopTitlebar: () => null }));
vi.mock("./components/DynamicIsland.tsx", () => ({ DynamicIsland: () => null }));
vi.mock("./components/ShortcutsDialog.tsx", () => ({ ShortcutsDialog: () => null }));
vi.mock("./components/FindBar.tsx", () => ({ FindBar: () => null }));
vi.mock("./components/NewProjectDialog.tsx", () => ({ NewProjectDialog: () => null }));
vi.mock("./components/SettingsPage.tsx", () => ({ SettingsPage: () => null }));
vi.mock("./components/TodoPin.tsx", () => ({ TodoPin: () => null }));
vi.mock("./components/RetryPin.tsx", () => ({ RetryPin: () => null }));
vi.mock("./components/BuildConsistencyBanner.tsx", () => ({ BuildConsistencyBanner: () => null }));
type WorkbenchOwner = { role?: string; store: SidebarStore; client: BridgeClient; cwd: string; profile?: string; connected: boolean };
/** Exercise the real editor controller's owner lifetime without CodeMirror's layout machinery. */
function EditorOwnerProbe({ store, client, cwd, profile }: WorkbenchOwner): React.JSX.Element {
	const controller = React.useMemo(() => new EditorController(createSidebarApi(client), cwd, "unsaved.ts", profile ?? "", localStorage), [client, cwd, profile]);
	const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	React.useEffect(() => {
		fixture.editor = controller; controller.activate();
		const off = store.registerEditor("editor:unsaved.ts", { isDirty: controller.isDirty, revision: controller.revision, isProtected: controller.isProtected, save: () => controller.save(), preserveDraft: () => controller.preserveDraft(), discard: () => controller.discard() });
		void controller.load();
		return () => { off(); controller.dispose(); };
	}, [controller, store]);
	return <pre data-editor-owner={profile}>{state.text}</pre>;
}
vi.mock("./sidebar/Workbench.tsx", () => ({ Workbench: (props: WorkbenchOwner) => {
	if (props.role === "terminal") return null;
	fixture.workbench = props.store; fixture.workbenchProfile = props.profile; fixture.workbenchConnected = props.connected;
	return fixture.editorProbe ? <EditorOwnerProbe {...props} /> : null;
} }));
vi.mock("./components/WallpaperLayer.tsx", () => ({ WallpaperLayer: () => null }));

let root: Root;
let container: HTMLElement;
type HistoryRow = { id: string; cwd: string; scope: "chat" | "research"; modified: string; archivedAt?: string; messageCount: number };
let rows: HistoryRow[];
const profile = "D:/fixture-profile";

beforeEach(async () => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
	Object.defineProperty(dom.window, "location", { value: { search: "", hash: "", href: "http://localhost/" }, configurable: true });
	dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as MediaQueryList;
	dom.document.hasFocus = () => true;
	fixture.chat = undefined;
	fixture.research = undefined;
	fixture.sidebar = undefined;
	fixture.composer = undefined;
	fixture.overlay = undefined;
	fixture.workbench = undefined;
	fixture.editorProbe = false; fixture.editor = undefined; fixture.workbenchProfile = undefined; fixture.workbenchConnected = false;
	rows = [
		{ id: "alpha-old", cwd: "D:/alpha", scope: "chat", modified: "2026-10-01", messageCount: 2 },
		{ id: "alpha-latest", cwd: "D:/alpha", scope: "chat", modified: "2026-10-15", messageCount: 2 },
		{ id: "beta-one", cwd: "D:/beta", scope: "chat", modified: "2026-10-15", messageCount: 2 },
		{ id: "gamma-one", cwd: "D:/gamma", scope: "chat", modified: "2026-10-15", messageCount: 2 },
		{ id: "research-one", cwd: "D:/alpha", scope: "research", modified: "2026-10-15", messageCount: 2 },
	];
	fixture.request.mockReset().mockImplementation(async (request) => {
		switch (request.type) {
			case "settings.get": return { ok: true, result: { agentDir: profile, settings: {} } };
			case "session.running": return { ok: true, result: { running: [] } };
			case "session.list": return { ok: true, result: rows };
			case "session.create": return { ok: true, result: { sessionId: "new-session" } };
			case "session.resume": {
				const row = rows.find((item) => item.id === request.sessionId)!;
				return { ok: true, result: { sessionId: row.id, cwd: row.cwd, messages: [{ role: "user", content: `message in ${row.id}`, timestamp: 1 }], messageEntryIds: [`${row.id}-entry`], ...(row.scope === "research" ? { researchMode: "web" } : {}) } };
			}
			case "session.prompt": return { ok: true };
			default: return { ok: false };
		}
	});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	await act(async () => root.render(<App />));
	await act(async () => fixture.status?.(true));
	await act(async () => fixture.sidebar!.onOpenSession("alpha-old"));
	expect(fixture.sidebar!.activeId).toBe("alpha-old");
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function selectProject(path: string): Promise<void> {
	await act(async () => fixture.sidebar!.onSelectProject(path));
}

function assertNoPrompt(): void {
	expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt")).toEqual([]);
}

describe("App project conversation navigation", () => {
	it("retains the last confirmed editor owner and its only dirty buffer through disconnect and unconfirmed reconnect", async () => {
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => {
			if (request.type === "fs.read") return Promise.resolve({ ok: true, result: { kind: "text", content: "disk", size: 4, truncated: false, editable: true, revision: "disk-v1" } });
			if (request.type === "editor.draft.get") return Promise.resolve({ ok: true, result: { draft: null, draftRevision: null } });
			return base(request);
		});
		fixture.workbench!.openFileTab("editor", "unsaved.ts", "unsaved.ts"); fixture.editorProbe = true;
		await act(async () => root.render(<App />));
		const editor = fixture.editor!;
		vi.spyOn(localStorage, "setItem").mockImplementation((key) => { if (key.startsWith("owl.editor.wal.")) throw new Error("quota exceeded"); });
		await act(async () => editor.change("only remaining unsaved text"));
		expect(editor.isProtected()).toBe(false); expect(editor.isDirty()).toBe(true);
		await act(async () => fixture.status?.(false));
		expect(fixture.workbenchProfile).toBe(profile); expect(fixture.workbenchConnected).toBe(false); expect(fixture.editor).toBe(editor); expect(container.textContent).toContain("only remaining unsaved text");
		const settings = Promise.withResolvers<unknown>();
		fixture.request.mockImplementation((request) => request.type === "settings.get" ? settings.promise : base(request));
		await act(async () => fixture.status?.(true));
		expect(fixture.workbenchProfile).toBe(profile); expect(fixture.workbenchConnected).toBe(false); expect(fixture.editor).toBe(editor); expect(editor.getSnapshot().text).toBe("only remaining unsaved text");
		await act(async () => settings.resolve({ ok: true, result: { agentDir: profile, settings: {} } }));
		expect(fixture.workbenchConnected).toBe(true); expect(fixture.editor).toBe(editor); expect(editor.isDirty()).toBe(true); expect(editor.getSnapshot().text).toBe("only remaining unsaved text");
	});
	function protectEditor(preserveDraft: () => Promise<boolean>) {
		const store = fixture.workbench!;
		store.openFileTab("editor", "unsaved.ts", "unsaved.ts"); store.setDirty("editor:unsaved.ts", true);
		let dirty = true;
		store.registerEditor("editor:unsaved.ts", { isDirty: () => dirty, revision: () => 1, save: async () => false, preserveDraft, discard: async () => { dirty = false; return true; } });
		return store;
	}
	it("keeps the project and editor when draft preservation fails and the user cancels", async () => {
		const store = protectEditor(async () => false);
		await selectProject("D:/beta"); expect(fixture.chat!.cwd).toBe("D:/alpha"); expect(fixture.sidebar!.activeId).toBe("alpha-old"); expect(store.editorClose.getSnapshot()?.error).toBe("editor-not-ready");
		await act(async () => store.editorClose.choose("cancel")); expect(fixture.chat!.cwd).toBe("D:/alpha"); expect(store.getState().tabs.some((tab) => tab.path === "unsaved.ts")).toBe(true);
	});
	it("changes projects only after preservation is acknowledged, applying the most recent requested destination", async () => {
		const pending = Promise.withResolvers<boolean>(); protectEditor(() => pending.promise);
		await selectProject("D:/beta"); await selectProject("D:/gamma"); expect(fixture.chat!.cwd).toBe("D:/alpha");
		await act(async () => pending.resolve(true)); expect(fixture.chat!.cwd).toBe("D:/gamma"); expect(fixture.sidebar!.activeId).toBe("gamma-one");
	});
	it("does not change the current project when a cross-project conversation restore is cancelled", async () => {
		const store = protectEditor(async () => false);
		await act(async () => fixture.sidebar!.onOpenSession("beta-one")); expect(fixture.chat!.cwd).toBe("D:/alpha");
		await act(async () => store.editorClose.choose("cancel")); expect(fixture.chat!.cwd).toBe("D:/alpha"); expect(fixture.sidebar!.activeId).toBe("alpha-old");
	});
	it("returns to the last opened conversation instead of the latest modified conversation", async () => {
		await selectProject("D:/beta");
		expect(fixture.sidebar!.activeId).toBe("beta-one");
		await selectProject("D:/alpha");
		expect(fixture.sidebar!.activeId).toBe("alpha-old");
		expect(fixture.chat!.cwd).toBe("D:/alpha");
		assertNoPrompt();
	});

	it.each(["deleted", "archived"] as const)("falls back visibly when the remembered conversation was %s", async (state) => {
		await selectProject("D:/beta");
		if (state === "deleted") rows = rows.filter((row) => row.id !== "alpha-old");
		else rows.find((row) => row.id === "alpha-old")!.archivedAt = "2026-10-15";
		await selectProject("D:/alpha");
		expect(fixture.sidebar!.activeId).toBe("alpha-latest");
		expect(container.textContent).toContain(t("app.projectRestoreFallback"));
		assertNoPrompt();
	});

	it("keeps the open conversation when another session fails to resume", async () => {
		const kept = fixture.chat!.entries;
		expect(kept.some((entry) => entry.kind === "user" && entry.text.includes("alpha-old"))).toBe(true);
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.resume" && request.sessionId === "beta-one" ? Promise.resolve({ ok: false, error: "missing session" }) : base(request));
		await act(async () => fixture.sidebar!.onOpenSession("beta-one"));
		expect(fixture.sidebar!.activeId).toBe("alpha-old");
		expect(fixture.chat!.sessionId).toBe("alpha-old");
		expect(fixture.chat!.entries).toEqual(kept);
		expect(container.textContent).toContain(`${t("app.sessionRestoreFailed")}：missing session`);
		assertNoPrompt();
	});

	// 回归：会话打开中的提示必须走对话区浮动层（owl-conversation-pins），
	// 不能作为状态条插在头部与内容之间——那会把整个右侧对话区推下再弹回（闪屏）。
	it("shows the session-opening indicator in the floating overlay instead of a layout strip", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.resume" && request.sessionId === "beta-one" ? pending.promise : base(request));
		await act(async () => fixture.sidebar!.onOpenSession("beta-one"));
		const opening = [...container.querySelectorAll("p[role='status']")].filter((node) => node.textContent === t("app.sessionOpening"));
		expect(opening).toHaveLength(1);
		expect(opening[0]!.closest(".owl-conversation-pins")).not.toBeNull();
		await act(async () => pending.resolve({ ok: true, result: { sessionId: "beta-one", cwd: "D:/beta", messages: [], messageEntryIds: [] } }));
		expect(container.textContent).not.toContain(t("app.sessionOpening"));
		expect(fixture.chat!.sessionId).toBe("beta-one");
		assertNoPrompt();
	});

	it("uses the explicit project compose action to open a blank chat", async () => {
		await selectProject("D:/beta");
		fixture.request.mockClear();
		await act(async () => fixture.sidebar!.onNewChatInProject("D:/alpha"));
		expect(fixture.sidebar!.activeId).toBeUndefined();
		expect(fixture.sidebar!.activeProject).toBe("D:/alpha");
		expect(fixture.chat!.entries).toEqual([]);
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.resume")).toEqual([]);
		assertNoPrompt();
	});

	it("ignores a late project inventory after another project is selected", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		let defer = true;
		fixture.request.mockImplementation((request) => {
			if (defer && request.type === "session.list" && request.scope === "chat") { defer = false; return pending.promise; }
			return base(request);
		});
		await selectProject("D:/beta");
		await selectProject("D:/gamma");
		expect(fixture.sidebar!.activeId).toBe("gamma-one");
		await act(async () => pending.resolve({ ok: true, result: rows }));
		expect(fixture.sidebar!.activeId).toBe("gamma-one");
		expect(fixture.sidebar!.activeProject).toBe("D:/gamma");
		assertNoPrompt();
	});

	it("routes chat and research search hits to their exact message without submitting a prompt", async () => {
		const common = { cwd: "D:/alpha", title: "hit", archived: false, modified: "2026-10-15", role: "user" as const, excerpt: "SQL", matchRanges: [{ start: 0, end: 3 }] };
		const chatHit: SessionSearchHit = { ...common, sessionId: "alpha-latest", scope: "chat", entryId: "exact-chat-entry" };
		await act(async () => fixture.sidebar!.onOpenSearchHit(chatHit, "SQL"));
		expect(fixture.sidebar!.activeId).toBe("alpha-latest");
		expect(fixture.chat!.searchTarget).toMatchObject({ sessionId: chatHit.sessionId, entryId: chatHit.entryId, query: "SQL" });
		const researchHit: SessionSearchHit = { ...common, sessionId: "research-one", scope: "research", entryId: "exact-research-entry" };
		await act(async () => fixture.sidebar!.onOpenSearchHit(researchHit, "索引"));
		expect(fixture.research!.active).toBe(true);
		expect(fixture.research!.resumeRequest?.id).toBe("research-one");
		expect(fixture.research!.searchTarget).toMatchObject({ sessionId: researchHit.sessionId, entryId: researchHit.entryId, query: "索引" });
		await act(async () => fixture.sidebar!.onOpenSearchHit({ ...chatHit, entryId: "" }, "title"));
		expect(fixture.sidebar!.sessionScope).toBe("chat");
		expect(fixture.chat!.searchTarget).toBeUndefined();
		assertNoPrompt();
	});

	it("loads an earlier compacted search hit for display without inserting it into live entries", async () => {
		const earlier: SessionSearchMessageResult = { entryId: "old-compacted-entry", message: { role: "assistant", content: "早期 SQL 查询诊断", timestamp: 1 } };
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.searchMessage" ? Promise.resolve({ ok: true, result: earlier }) : base(request));
		const hit: SessionSearchHit = { sessionId: "alpha-latest", cwd: "D:/alpha", title: "early hit", scope: "chat", archived: false, modified: "2026-10-15", entryId: earlier.entryId, role: "assistant", excerpt: "SQL", matchRanges: [{ start: 0, end: 3 }] };
		await act(async () => fixture.sidebar!.onOpenSearchHit(hit, "SQL"));
		expect(fixture.request).toHaveBeenCalledWith({ type: "session.searchMessage", sessionId: hit.sessionId, entryId: earlier.entryId });
		expect(fixture.chat!.searchHistoryMessage).toEqual(earlier);
		expect(fixture.chat!.searchTarget).toMatchObject({ sessionId: hit.sessionId, entryId: earlier.entryId, query: "SQL" });
		expect(fixture.chat!.entries).toHaveLength(1);
		expect(fixture.chat!.entries.some((entry) => (entry.kind === "user" || entry.kind === "assistant") && entry.entryId === earlier.entryId)).toBe(false);
		assertNoPrompt();
	});

	it.each(["project", "new-chat"] as const)("discards a late earlier-message read after %s navigation", async (destination) => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.searchMessage" ? pending.promise : base(request));
		const hit: SessionSearchHit = { sessionId: "alpha-latest", cwd: "D:/alpha", title: "early hit", scope: "chat", archived: false, modified: "2026-10-15", entryId: "old-compacted-entry", role: "assistant", excerpt: "SQL", matchRanges: [{ start: 0, end: 3 }] };
		await act(async () => fixture.sidebar!.onOpenSearchHit(hit, "SQL"));
		if (destination === "project") await selectProject("D:/beta");
		else await act(async () => fixture.sidebar!.onNewChat());
		const selected = fixture.sidebar!.activeId;
		await act(async () => pending.resolve({ ok: true, result: { entryId: hit.entryId, message: { role: "assistant", content: "stale SQL content", timestamp: 1 } } }));
		expect(fixture.sidebar!.activeId).toBe(selected);
		expect(fixture.chat!.searchHistoryMessage).toBeUndefined();
		expect(fixture.chat!.searchTarget).toBeUndefined();
		expect(fixture.chat!.entries.some((entry) => (entry.kind === "user" || entry.kind === "assistant") && entry.text.includes("stale SQL content"))).toBe(false);
		assertNoPrompt();
	});
});

