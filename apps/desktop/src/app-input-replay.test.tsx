import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.tsx";
import type { ChatEntry } from "./hooks/transcript.ts";

type ReplayCallbacks = {
	onRegenerate: () => void;
	onEditMessage: (entryId: string, text: string) => void;
	entries: ChatEntry[];
};
type SidebarCallbacks = { onNewChat: () => void; onOpenSession: (id: string) => void; activeId?: string };
type ComposerInput = { draftRequest?: { text: string }; onSend: (message: string) => Promise<boolean>; sessionInfo?: { model?: { id: string } } };
const fixture = vi.hoisted(() => ({
	request: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
	status: undefined as ((up: boolean) => void) | undefined,
	chat: undefined as ReplayCallbacks | undefined,
	sidebar: undefined as SidebarCallbacks | undefined,
	composer: undefined as ComposerInput | undefined,
	recovery: undefined as { onContinue: (model?: string) => Promise<boolean> } | undefined,
	event: undefined as ((event: Record<string, unknown>) => void) | undefined,
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
vi.mock("./components/AgentConversation.tsx", () => ({ AgentConversation: (props: { chat: React.ReactNode; composer: React.ReactNode; beforeComposer: React.ReactNode }) => <>{props.chat}{props.beforeComposer}{props.composer}</> }));
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
vi.mock("./features/research/ResearchPage.tsx", () => ({ ResearchPage: () => null }));
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
vi.mock("./sidebar/Workbench.tsx", () => ({ Workbench: () => null }));
vi.mock("./components/WallpaperLayer.tsx", () => ({ WallpaperLayer: () => null }));

let root: Root;
let rewind: ReturnType<typeof Promise.withResolvers<unknown>>;
const sourceText = "请参考截图检查 D:/project/source.ts";
const sourcePath = "D:/project/source.ts";
const sourceImage = { type: "image", mimeType: "image/png", data: "source-image" };
const rewindResult = { ok: true, result: { editorText: sourceText, snapshot: { messages: [], messageEntryIds: [] } } };

beforeEach(async () => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	Object.defineProperty(dom.window, "location", { value: { search: "", hash: "", href: "http://localhost/" }, configurable: true });
	dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as MediaQueryList;
	dom.document.hasFocus = () => true;
	fixture.chat = undefined;
	fixture.sidebar = undefined;
	fixture.composer = undefined;
	rewind = Promise.withResolvers<unknown>();
	fixture.request.mockReset().mockImplementation(async (request) => {
		switch (request.type) {
			case "rewind.execute": return rewind.promise;
			case "session.running": return { ok: true, result: { running: [] } };
			case "session.list": return { ok: true, result: [] };
			case "session.create": return { ok: true, result: { sessionId: "new-session" } };
			case "session.resume": return { ok: true, result: {
				sessionId: request.sessionId, cwd: "D:/project", messageEntryIds: ["source-user"],
				messages: [{ role: "user", content: [{ type: "text", text: `[Attached files for this turn]\n- ${sourcePath}\n\n${sourceText}` }, sourceImage], timestamp: 1 }],
			} };
			case "session.prompt": return { ok: true };
			default: return { ok: false };
		}
	});
	root = createRoot(dom.document.getElementById("root")!);
	await act(async () => root.render(<App />));
	await act(async () => fixture.status?.(true));
	await act(async () => fixture.sidebar!.onOpenSession("source-session"));
	expect(fixture.sidebar!.activeId).toBe("source-session");
	expect(fixture.chat!.entries.some((entry) => entry.kind === "user" && entry.entryId === "source-user")).toBe(true);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

function replay(action: "edit" | "regenerate"): void {
	if (action === "edit") fixture.chat!.onEditMessage("source-user", "编辑后的原任务");
	else fixture.chat!.onRegenerate();
}

describe("App input replay session ownership", () => {
	it("keeps an acknowledged recovery model when continuation fails and older stats arrive late", async () => {
		const oldStats = Promise.withResolvers<unknown>();
		const request = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => {
			if (payload.type === "session.stats") return oldStats.promise;
			if (payload.type === "session.setModel") return Promise.resolve({ ok: true, result: { model: { provider: "other", id: "new-model" }, thinkingLevel: "high", availableThinkingLevels: ["high"], supportsThinking: true } });
			if (payload.type === "session.continue") return Promise.resolve({ ok: false, error: "connection lost" });
			return request(payload);
		});
		await act(async () => fixture.event?.({ type: "event", sessionId: "source-session", event: { type: "agent_settled" } }));
		await act(async () => { expect(await fixture.recovery!.onContinue("other/new-model")).toBe(false); });
		expect(fixture.composer!.sessionInfo?.model?.id).toBe("new-model");
		await act(async () => oldStats.resolve({ ok: true, result: { model: { provider: "old", id: "old-model" }, thinkingLevel: "high", availableThinkingLevels: ["high"], supportsThinking: true } }));
		expect(fixture.composer!.sessionInfo?.model?.id).toBe("new-model");
	});
	it.each(["edit", "regenerate"] as const)("drops %s replay when a new conversation opens while rewind is pending", async (action) => {
		await act(async () => replay(action));
		expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ type: "rewind.execute", sessionId: "source-session" }));
		await act(async () => fixture.sidebar!.onNewChat());
		expect(fixture.sidebar!.activeId).toBe("new-session");
		await act(async () => rewind.resolve(rewindResult));
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt")).toEqual([]);
		expect(fixture.chat!.entries).toEqual([]);
		expect(fixture.composer!.draftRequest).toBeUndefined();
	});

	it.each(["edit", "regenerate"] as const)("replays complete %s input when the source conversation stays selected", async (action) => {
		await act(async () => replay(action));
		await act(async () => rewind.resolve(rewindResult));
		expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({
			type: "session.prompt", sessionId: "source-session", message: action === "edit" ? "编辑后的原任务" : sourceText,
			images: [sourceImage], attachedPaths: [sourcePath],
		}));
	});

	it("does not adopt a pending new conversation after the user selects an existing conversation", async () => {
		const created = Promise.withResolvers<unknown>();
		const request = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "session.create" ? created.promise : request(payload));
		await act(async () => fixture.sidebar!.onNewChat());
		await act(async () => fixture.sidebar!.onOpenSession("selected-session"));
		await act(async () => created.resolve({ ok: true, result: { sessionId: "stale-created-session" } }));
		expect(fixture.sidebar!.activeId).toBe("selected-session");
		expect(fixture.request.mock.calls.filter(([payload]) => payload.type === "session.prompt")).toEqual([]);
	});
});
