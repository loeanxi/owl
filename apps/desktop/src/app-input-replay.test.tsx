import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.tsx";
import type { ChatEntry } from "./hooks/transcript.ts";
import type { PermissionRequest, QuestionRequest, SessionQueueSnapshot } from "./bridge/protocol.ts";
import type { DynamicIslandProps } from "./components/DynamicIsland.tsx";
import { QuestionDock } from "./components/QuestionDock.tsx";
import { t } from "./i18n/index.ts";

type ReplayCallbacks = {
	onOpenFile: (path: string) => Promise<void>;
	onRegenerate: () => void;
	onResumeSession: (id: string) => void;
	onEditMessage: (entryId: string, text: string) => void;
	entries: ChatEntry[];
};
type SidebarCallbacks = { onNewChat: () => void; onOpenSession: (id: string) => void; activeId?: string };
type ComposerInput = { draftRequest?: { text: string }; onSend: (message: string) => Promise<boolean>; sessionInfo?: { model?: { id: string } }; model: string; onModel: (value: string) => void; modelSelection?: { status: string; actual: string; target: string; error?: string }; onRetryModelSelection: () => void; queued?: SessionQueueSnapshot; queueProfile?: string; queueSessionId?: string; queueIsCurrent?: () => boolean; onQueueChange: (queue: SessionQueueSnapshot) => void };
type ResearchCallbacks = { onOpenFile: (path: string) => Promise<void>; onSwitchProject: (path: string) => void; cwd: string };
const fixture = vi.hoisted(() => ({
	request: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
	status: undefined as ((up: boolean) => void) | undefined,
	chat: undefined as ReplayCallbacks | undefined,
	research: undefined as ResearchCallbacks | undefined,
	rail: undefined as { onSelect: (view: "research") => void } | undefined,
	sidebar: undefined as SidebarCallbacks | undefined,
	composer: undefined as ComposerInput | undefined,
	recovery: undefined as { onContinue: (model?: string) => Promise<boolean> } | undefined,
	event: undefined as ((event: Record<string, unknown>) => void) | undefined,
	permission: undefined as ((request: PermissionRequest) => void) | undefined,
	question: undefined as ((request: QuestionRequest) => void) | undefined,
	island: undefined as DynamicIslandProps | undefined,
}));
vi.mock("./bridge/client.ts", () => ({ BridgeClient: class {
	request = fixture.request;
	connect() {}
	onStatus(callback: (up: boolean) => void) { fixture.status = callback; return () => {}; }
	onSessionEvent(callback: (event: Record<string, unknown>) => void) { fixture.event = callback; return () => {}; }
	onPermissionRequest(callback: (request: PermissionRequest) => void) { fixture.permission = callback; return () => {}; }
	onQuestionRequest(callback: (request: QuestionRequest) => void) { fixture.question = callback; return () => {}; }
	respondPermission(requestId: string, approved: boolean) { return fixture.request({ type: "permission.response", requestId, approved }); }
	respondQuestion(requestId: string, answers: unknown, cancelled: boolean) { return fixture.request({ type: "question.response", requestId, answers, cancelled }); }
	onNewsOpen() { return () => {}; }
	onIabMessage() { return () => {}; }
	onSidebarMessage() { return () => {}; }
	watchSessionEvents() { return () => {}; }
} }));
vi.mock("./bridge/native.ts", () => ({ hasTauri: () => false, setWebviewZoom: async () => {}, isWindowFullscreen: async () => false }));
vi.mock("./theme.ts", () => ({ isThemePreference: () => false, setThemeLock: () => {}, setThemePreference: () => {} }));
vi.mock("./components/SessionSidebar.tsx", () => ({ SessionSidebar: (props: SidebarCallbacks) => { fixture.sidebar = props; return null; } }));
vi.mock("./components/ChatStream.tsx", () => ({ ChatStream: (props: ReplayCallbacks) => { fixture.chat = props; return null; }, renderMarkdown: (text: string) => text }));
vi.mock("./components/Composer.tsx", () => ({ Composer: (props: ComposerInput) => { fixture.composer = props; return null; } }));
vi.mock("./components/AgentConversation.tsx", () => ({ AgentConversation: (props: { chat: React.ReactNode; composer: React.ReactNode; beforeComposer: React.ReactNode; questionDock?: Omit<React.ComponentProps<typeof QuestionDock>, "children"> }) => <>{props.chat}{props.beforeComposer}{props.questionDock ? <QuestionDock {...props.questionDock}>{props.composer}</QuestionDock> : props.composer}</> }));
vi.mock("./components/Genui.tsx", () => ({ GenuiSessionProvider: (props: { children: React.ReactNode }) => props.children }));
vi.mock("./hooks/use-subagents.ts", () => ({ useSubagents: () => ({ runs: [], refresh: () => {} }) }));
vi.mock("./components/OwlMascot.tsx", () => ({ useSessionOwlPose: () => "idle" }));
vi.mock("./features/life-monitor/use-life-probe.ts", () => ({ useLifeProbe: () => ({ channels: [], round: "idle" }) }));
vi.mock("./use-workspace-memory.ts", () => ({ useWorkspaceMemory: () => {} }));
vi.mock("./sidebar/quick.tsx", () => ({ openQuickAction: () => {} }));
vi.mock("./components/ActivityRail.tsx", () => ({ ActivityRail: (props: { onSelect: (view: "research") => void }) => { fixture.rail = props; return null; } }));
vi.mock("./components/AccountProfilePage.tsx", () => ({ AccountProfilePage: () => null }));
vi.mock("./map/MapWorkspace.tsx", () => ({ MapWorkspace: () => null }));
vi.mock("./features/news/NewsPage.tsx", () => ({ NewsPage: () => null }));
vi.mock("./features/mail/MailPage.tsx", () => ({ MailPage: () => null }));
vi.mock("./features/evaluation/EvaluationPage.tsx", () => ({ EvaluationPage: () => null }));
vi.mock("./features/research/ResearchPage.tsx", () => ({ ResearchPage: (props: ResearchCallbacks) => { fixture.research = props; return null; } }));
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
vi.mock("./components/RewindDialog.tsx", () => ({ RewindDialog: () => null }));
vi.mock("./components/SessionShareDialog.tsx", () => ({ SessionShareDialog: () => null }));
vi.mock("./components/SubagentView.tsx", () => ({ selectedSubagent: () => undefined, SubagentView: () => null }));
vi.mock("./components/SubagentPin.tsx", () => ({ SubagentPin: () => null }));
vi.mock("./components/DesktopTitlebar.tsx", () => ({ DesktopTitlebar: (props: { island: React.ReactNode }) => props.island }));
vi.mock("./components/DynamicIsland.tsx", () => ({ DynamicIsland: (props: DynamicIslandProps) => { fixture.island = props; return null; } }));
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
let profileDirectory: string;
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
	fixture.research = undefined;
	fixture.rail = undefined;
	fixture.sidebar = undefined;
	fixture.composer = undefined;
	profileDirectory = "D:/profile-one";
	rewind = Promise.withResolvers<unknown>();
	fixture.request.mockReset().mockImplementation(async (request) => {
		switch (request.type) {
			case "settings.get": return { ok: true, result: { agentDir: profileDirectory, settings: {} } };
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

describe("App queue snapshot ownership", () => {
	const queue: SessionQueueSnapshot = { steering: [], followUp: [{ messageId: "queued-one", text: "检查材料", textTruncated: false, imageCount: 1, attachedPaths: ["reference.md"], state: "queued" }] };
	async function loadProfile(profile: string): Promise<void> {
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "settings.get" ? Promise.resolve({ ok: true, result: { agentDir: profile, settings: {} } }) : base(payload));
		await act(async () => fixture.status?.(false)); await act(async () => fixture.status?.(true));
		expect(fixture.composer!.queueProfile).toBe(profile);
	}
	it("retains stable identities from events and ignores an old conversation's acknowledgement callback", async () => {
		await loadProfile("D:/profile-one");
		await act(async () => fixture.event?.({ type: "event", sessionId: "source-session", event: { type: "queue_update", ...queue } }));
		expect(fixture.composer!.queued).toEqual(queue);
		const oldUpdate = fixture.composer!.onQueueChange;
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		await act(async () => oldUpdate(queue));
		expect(fixture.composer!.queueSessionId).toBe("other-session"); expect(fixture.composer!.queued).toBeUndefined();
	});
	it("does not reuse another profile's queue even when the conversation ID is unchanged", async () => {
		await loadProfile("D:/profile-one");
		await act(async () => fixture.event?.({ type: "event", sessionId: "source-session", event: { type: "queue_update", ...queue } }));
		expect(fixture.composer!.queued).toEqual(queue);
		await loadProfile("D:/profile-two");
		expect(fixture.composer!.queued).toBeUndefined(); expect(fixture.composer!.queueSessionId).toBe("source-session");
	});
});

function approval(requestId = "approval-one", session = "source-session"): PermissionRequest {
	return { type: "permission_request", requestId, sessionId: session, toolName: "bash", input: { command: "git diff -- source.ts" } };
}
function questionRequest(requestId = "question-one", session = "source-session"): QuestionRequest {
	return { type: "question_request", requestId, sessionId: session, questions: [{ question: "选择方案", multiSelect: false, options: [{ label: "第一方案" }, { label: "第二方案" }] }] };
}
function visibleQuestion(): HTMLElement {
	return document.querySelector<HTMLElement>('.owl-question-anchor__column:not([hidden])')!;
}
function responseButton(label: string): HTMLButtonElement {
	const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
	if (!result) throw new Error(`Missing ${label}: ${document.body.textContent}`);
	return result;
}

describe("App acknowledged approvals and questions", () => {
	it("keeps an approval mounted on business rejection and retries the same decision after confirmation", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		let first = true;
		fixture.request.mockImplementation((request) => request.type === "permission.response" ? first ? (first = false, pending.promise) : Promise.resolve({ ok: true }) : base(request));
		await act(async () => fixture.permission!(approval()));
		await act(async () => { const allow = responseButton(t("perm.allow")); allow.click(); allow.click(); });
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(responseButton("正在提交…").disabled).toBe(true);
		expect(fixture.request.mock.calls.filter(([item]) => item.type === "permission.response")).toHaveLength(1);
		await act(async () => pending.resolve({ ok: false, error: "host policy refused" }));
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("host policy refused");
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		await act(async () => responseButton("原样重试").click());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(fixture.request.mock.calls.filter(([item]) => item.type === "permission.response").map(([item]) => item.approved)).toEqual([true, true]);
	});

	it("does not interrupt current work for a background approval, and later leaves it accessible in the island", async () => {
		await act(async () => fixture.permission!(approval("background", "other-session")));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(fixture.island!.running.some((session) => session.id === "other-session")).toBe(true);
		expect(fixture.island!.permissionFor!("other-session")?.description).toContain("git diff -- source.ts");
		await act(async () => fixture.island!.onOpenPermission!("background"));
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("other-session");
		await act(async () => responseButton("稍后处理").click());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(fixture.island!.permissionFor!("other-session")?.requestId).toBe("background");
		expect(fixture.sidebar!.activeId).toBe("source-session");
		await act(async () => fixture.island!.onOpenPermission!("background"));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it.each(["permission_resolved", "agent_settled"])("cannot revive an approval after %s arrives before a failed response", async (eventType) => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "permission.response" ? pending.promise : base(request));
		await act(async () => fixture.permission!(approval()));
		await act(async () => responseButton(t("perm.allow")).click());
		await act(async () => fixture.event!({ type: "event", sessionId: "source-session", event: { type: eventType, requestId: "approval-one", approved: true } }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => pending.reject(new Error("late failure")));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.body.textContent).not.toContain("late failure");
	});

	it("keeps separate question answers across session changes and business failures", async () => {
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "question.response" ? Promise.resolve({ ok: false, error: "question not accepted" }) : base(request));
		await act(async () => { fixture.question!(questionRequest()); fixture.question!(questionRequest("other-question", "other-session")); });
		await act(async () => visibleQuestion().querySelector<HTMLElement>('[aria-label="第一方案"]')!.click());
		await act(async () => responseButton(t("question.submit")).click());
		expect(visibleQuestion().textContent).toContain("question not accepted");
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		await act(async () => visibleQuestion().querySelector<HTMLElement>('[aria-label="第二方案"]')!.click());
		await act(async () => fixture.sidebar!.onOpenSession("source-session"));
		expect(visibleQuestion().querySelector('[aria-label="第一方案"]')?.getAttribute("aria-checked")).toBe("true");
		expect(visibleQuestion().textContent).toContain("question not accepted");
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "question.response")).toHaveLength(1);
	});

	it.each(["question_resolved", "agent_settled"])("does not restore question input after authoritative %s and a late transport failure", async (eventType) => {
		const pending = Promise.withResolvers<unknown>(); const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "question.response" ? pending.promise : base(request));
		await act(async () => fixture.question!(questionRequest()));
		await act(async () => visibleQuestion().querySelector<HTMLElement>('[aria-label="第一方案"]')!.click());
		await act(async () => responseButton(t("question.submit")).click());
		await act(async () => fixture.event!({ type: "event", sessionId: "source-session", event: { type: eventType, requestId: "question-one", cancelled: false } }));
		await act(async () => pending.reject(new Error("old question failure")));
		expect(document.querySelector(".owl-question-card")).toBeNull(); expect(document.body.textContent).not.toContain("old question failure");
	});

	it("discards pending feedback and requests after an account scope changes", async () => {
		const pending = Promise.withResolvers<unknown>(); const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "permission.response" ? pending.promise : base(request));
		await act(async () => fixture.permission!(approval()));
		await act(async () => responseButton(t("perm.allow")).click());
		profileDirectory = "D:/profile-two";
		await act(async () => fixture.status!(false)); await act(async () => fixture.status!(true));
		await act(async () => pending.reject(new Error("old account failure")));
		expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.body.textContent).not.toContain("old account failure");
	});
});

describe("App ordinary model selection confirmation", () => {
	it("does not change the displayed model before host confirmation and keeps retry available", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.setModel" ? pending.promise : base(request));
		const previous = fixture.composer!.model;
		await act(async () => fixture.composer!.onModel("other/new-model"));
		expect(fixture.composer!.model).toBe(previous);
		expect(fixture.composer!.modelSelection?.status).toBe("pending");
		await act(async () => pending.resolve({ ok: false, error: "missing model credentials" }));
		expect(fixture.composer!.model).toBe(previous);
		expect(fixture.composer!.modelSelection).toMatchObject({ status: "error", error: "missing model credentials" });
		fixture.request.mockImplementation((request) => request.type === "session.setModel" ? Promise.resolve({ ok: true, result: { model: { provider: "other", id: "new-model" }, thinkingLevel: "low", availableThinkingLevels: ["low"], supportsThinking: true } }) : base(request));
		await act(async () => fixture.composer!.onRetryModelSelection());
		expect(fixture.composer!.model).toBe("other/new-model");
		expect(fixture.composer!.modelSelection?.status).toBe("confirmed");
	});

	it("does not apply an old model acknowledgement after another session is opened", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.setModel" ? pending.promise : base(request));
		await act(async () => fixture.composer!.onModel("other/new-model"));
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		await act(async () => pending.resolve({ ok: true, result: { model: { provider: "other", id: "new-model" }, thinkingLevel: "high", availableThinkingLevels: ["high"], supportsThinking: true } }));
		expect(fixture.composer!.model).not.toBe("other/new-model");
		expect(fixture.composer!.modelSelection).toBeUndefined();
	});
});

describe("App input replay session ownership", () => {
	it("returns external file launch acknowledgement failures to artifact controls", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "open.external" ? pending.promise : base(payload));
		let opening: Promise<void>;
		await act(async () => { opening = fixture.chat!.onOpenFile("report.pdf"); });
		expect(opening!).toBeInstanceOf(Promise);
		expect(fixture.request).toHaveBeenCalledWith({ type: "open.external", action: "url", target: "file:///D:/project/report.pdf" });
		const rejected = expect(opening!).rejects.toThrow("system document app unavailable");
		await act(async () => pending.resolve({ ok: false, error: "system document app unavailable" }));
		await rejected;
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("system document app unavailable");
	});

	it("returns a research file launch failure from its own project to artifact controls", async () => {
		await act(async () => fixture.rail!.onSelect("research"));
		await act(async () => fixture.research!.onSwitchProject("D:/research-project"));
		expect(fixture.research!.cwd).toBe("D:/research-project");
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "open.external" ? Promise.resolve({ ok: false, error: "research app permission denied" }) : base(payload));
		await act(async () => { await expect(fixture.research!.onOpenFile("report.pdf")).rejects.toThrow("research app permission denied"); });
		expect(fixture.request).toHaveBeenCalledWith({ type: "open.external", action: "url", target: "file:///D:/research-project/report.pdf" });
	});

	it("does not publish an old file launch error after another conversation opens", async () => {
		const pending = Promise.withResolvers<unknown>();
		const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "open.external" ? pending.promise : base(payload));
		let opening: Promise<void>;
		await act(async () => { opening = fixture.chat!.onOpenFile("report.pdf"); });
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		const rejected = expect(opening!).rejects.toThrow("old launch failed");
		await act(async () => pending.resolve({ ok: false, error: "old launch failed" }));
		await rejected;
		expect(document.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("old launch failed");
	});
	it("restores a home-page recent session through the existing resume path without sending a prompt", async () => {
		fixture.request.mockClear();
		await act(async () => fixture.chat!.onResumeSession("home-recent-session"));
		expect(fixture.sidebar!.activeId).toBe("home-recent-session");
		expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ type: "session.resume", sessionId: "home-recent-session" }));
		expect(fixture.request.mock.calls.filter(([payload]) => payload.type === "session.prompt" || payload.type === "session.continue" || payload.type === "session.create")).toEqual([]);
	});

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
