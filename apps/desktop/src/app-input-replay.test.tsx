import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.tsx";
import type { ChatEntry, ToolCard } from "./hooks/transcript.ts";
import type { ExecutionView } from "./components/execution-view.ts";
import { ExecutionContext, type ExecutionContextValue } from "./sidebar/execution-context.tsx";
import type { WorkbenchProps } from "./sidebar/Workbench.tsx";
import { executionText } from "./components/execution-copy.ts";
import { APP_KEYBINDINGS_KEY } from "./app-keybindings.ts";
import type { PermissionRequest, QuestionRequest, SessionQueueSnapshot } from "./bridge/protocol.ts";
import type { DynamicIslandProps } from "./components/DynamicIsland.tsx";
import { QuestionDock } from "./components/QuestionDock.tsx";
import { t } from "./i18n/index.ts";

type ReplayCallbacks = {
	executionView: ExecutionView;
	onInspectTool: (card: ToolCard, ownerIndex?: number) => void;
	onOpenFile: (path: string) => Promise<void>;
	onRegenerate: () => void;
	onResumeSession: (id: string) => void;
	onEditMessage: (entryId: string, text: string) => boolean | Promise<boolean>;
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
	execution: undefined as ExecutionContextValue | undefined,
	workbench: undefined as WorkbenchProps | undefined,
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
	onSidebarContext() { return () => {}; }
	watchSessionEvents() { return () => {}; }
} }));
vi.mock("./bridge/native.ts", () => ({ hasTauri: () => false, setWebviewZoom: async () => {}, isWindowFullscreen: async () => false }));
vi.mock("./theme.ts", () => ({ isThemePreference: () => false, setThemeLock: () => {}, setThemePreference: () => {} }));
vi.mock("./components/SessionSidebar.tsx", () => ({ SessionSidebar: (props: SidebarCallbacks) => { fixture.sidebar = props; return null; } }));
vi.mock("./components/ChatStream.tsx", () => ({ ChatStream: (props: ReplayCallbacks) => { fixture.chat = props; return null; }, renderMarkdown: (text: string) => text }));
vi.mock("./components/Composer.tsx", () => ({ Composer: (props: ComposerInput) => { fixture.composer = props; return null; } }));
vi.mock("./components/AgentConversation.tsx", () => ({ AgentConversation: (props: { header?: React.ReactNode; chat: React.ReactNode; composer: React.ReactNode; beforeComposer: React.ReactNode; questionDock?: Omit<React.ComponentProps<typeof QuestionDock>, "children"> }) => <>{props.header}{props.chat}{props.beforeComposer}{props.questionDock ? <QuestionDock {...props.questionDock}>{props.composer}</QuestionDock> : props.composer}</> }));
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
vi.mock("./components/NewProjectDialog.tsx", () => ({ NewProjectDialog: () => <div data-testid="project-dialog" /> }));
vi.mock("./components/SettingsPage.tsx", () => ({ SettingsPage: () => null }));
vi.mock("./components/TodoPin.tsx", () => ({ TodoPin: () => null }));
vi.mock("./components/RetryPin.tsx", () => ({ RetryPin: () => null }));
vi.mock("./components/BuildConsistencyBanner.tsx", () => ({ BuildConsistencyBanner: () => null }));
vi.mock("./sidebar/Workbench.tsx", () => ({ Workbench: (props: WorkbenchProps) => { const context = React.useContext(ExecutionContext); if (props.role !== "terminal") { fixture.execution = context; fixture.workbench = props; } return null; } }));
vi.mock("./components/WallpaperLayer.tsx", () => ({ WallpaperLayer: () => null }));

let root: Root;
let profileDirectory: string;
let rewind: ReturnType<typeof Promise.withResolvers<unknown>>;
let storage: Map<string, string>;
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
	storage = new Map();
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
	Object.defineProperty(dom.window, "location", { value: { search: "", hash: "", href: "http://localhost/" }, configurable: true });
	dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as MediaQueryList;
	dom.document.hasFocus = () => true;
	fixture.chat = undefined;
	fixture.research = undefined;
	fixture.rail = undefined;
	fixture.sidebar = undefined;
	fixture.composer = undefined;
	fixture.execution = undefined;
	fixture.workbench = undefined;
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
			case "commands.list": return { ok: true, result: { commands: [{ name: "compact", kind: "builtin", description: "compact" }] } };
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

// R13：重新生成先弹确认；测试统一在确认框上点「重新生成」走原链路。
async function confirmRegenerate(): Promise<void> {
	await act(async () => {
		[...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === t("regenerate.confirmOk"))?.click();
	});
}
async function replay(action: "edit" | "regenerate"): Promise<void> {
	if (action === "edit") fixture.chat!.onEditMessage("source-user", "编辑后的原任务");
	else fixture.chat!.onRegenerate();
}

async function shortcut(key: string, shiftKey = false): Promise<void> {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: false, metaKey: false, shiftKey });
		window.dispatchEvent(event);
	});
}

describe("App execution controls", () => {
	it("cycles a global view preference without changing sessions, sending or stopping work", async () => {
		expect(fixture.chat!.executionView).toBe("normal");
		fixture.request.mockClear();
		await shortcut("o"); expect(fixture.chat!.executionView).toBe("thinking");
		await shortcut("o"); expect(fixture.chat!.executionView).toBe("verbose");
		await shortcut("o"); expect(fixture.chat!.executionView).toBe("normal");
		expect(storage.get("owl.execution.view")).toBe("normal");
		expect(fixture.sidebar!.activeId).toBe("source-session");
		expect(fixture.request.mock.calls.filter(([request]) => ["session.prompt", "session.abort", "session.resume"].includes(String(request.type)))).toEqual([]);
		await shortcut("o", true);
		expect(document.querySelector('[data-testid="project-dialog"]')).not.toBeNull();
	});

	it("saves a configurable view shortcut and keeps the former key available to the browser", async () => {
		await act(async () => responseButton(`${executionText("normal")} ${executionText("view")}⌄`).click());
		const change = responseButton(executionText("captureShortcut"));
		await act(async () => change.click());
		await act(async () => {
			const event = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "u", code: "KeyU", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false });
			change.dispatchEvent(event);
		});
		expect(JSON.parse(storage.get(APP_KEYBINDINGS_KEY)!)).toMatchObject({ cycleExecutionView: ["ctrl+u"] });
		await shortcut("o"); expect(fixture.chat!.executionView).toBe("normal");
		await shortcut("u"); expect(fixture.chat!.executionView).toBe("thinking");
	});

	it("opens tool evidence and background tasks as session-bound execution tabs", async () => {
		const card: ToolCard = { id: "check-one", name: "bash", args: '{"command":"check"}', summary: "check", status: "running" };
		await act(async () => fixture.chat!.onInspectTool(card, 1));
		const evidence = fixture.workbench!.store.getState().tabs.find((tab) => tab.kind === "execution")!;
		expect(JSON.parse(evidence.path!)).toEqual({ sessionId: "source-session", profile: "D:/profile-one", mode: "tool", toolId: "check-one", ownerIndex: 1 });
		expect(fixture.workbench!.open).toBe(true);
		await act(async () => responseButton(executionText("tasks")).click());
		expect(fixture.workbench!.store.getState().tabs.filter((tab) => tab.kind === "execution")).toHaveLength(2);
		expect(fixture.workbench!.store.getState().tabs.some((tab) => tab.kind === "terminal")).toBe(false);
	});

	it("uses the existing Git snapshot for counts and rejects late snapshots from another project or profile", async () => {
		const snapshot = { repo: true, entries: [{ path: "a.ts", x: " ", y: "M" }, { path: "b.ts", x: " ", y: "M" }] };
		await act(async () => fixture.workbench!.onGitStatusChange!("D:/project", "D:/profile-one", snapshot));
		expect(document.querySelector(`[aria-label="${executionText("changes")}"] b`)?.textContent).toBe("2");
		await act(async () => fixture.workbench!.onGitStatusChange!("D:/old-project", "D:/profile-one", snapshot));
		expect(document.querySelector(`[aria-label="${executionText("changes")}"] b`)).toBeNull();
		await act(async () => fixture.workbench!.onGitStatusChange!("D:/project", "D:/other-profile", snapshot));
		expect(document.querySelector(`[aria-label="${executionText("changes")}"] b`)).toBeNull();
	});

	it("acknowledges feedback only after a real prompt succeeds and uses steering during execution", async () => {
		await act(async () => fixture.event!({ type: "event", sessionId: "source-session", event: { type: "agent_start" } }));
		const pending = Promise.withResolvers<unknown>(); const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.prompt" ? pending.promise : base(request));
		let result!: Promise<boolean>;
		await act(async () => { result = fixture.execution!.onSubmitFeedback!("请调整 source.ts 第 3 行"); });
		expect(fixture.request).toHaveBeenCalledWith({ type: "session.prompt", sessionId: "source-session", message: "请调整 source.ts 第 3 行", streamingBehavior: "steer" });
		expect(fixture.request.mock.calls.some(([request]) => request.type === "session.abort")).toBe(false);
		await act(async () => pending.resolve({ ok: false, error: "not accepted" }));
		await expect(result).resolves.toBe(false);
	});

	it("rejects a retained feedback callback after navigation and keeps feedback out of the new session", async () => {
		const send = fixture.execution!.onSubmitFeedback!;
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		fixture.request.mockClear();
		await act(async () => { expect(await send("原会话的意见")).toBe(false); });
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt")).toEqual([]);
	});

	it("sends idle feedback as a real new turn and resolves true only on acceptance", async () => {
		await act(async () => { expect(await fixture.execution!.onSubmitFeedback!("请完善 source.ts 的说明")).toBe(true); });
		expect(fixture.request).toHaveBeenCalledWith({ type: "session.prompt", sessionId: "source-session", message: "请完善 source.ts 的说明" });
		expect(fixture.chat!.entries.some((entry) => entry.kind === "user" && entry.text === "请完善 source.ts 的说明")).toBe(true);
		expect(fixture.composer!.draftRequest).toBeUndefined();
	});

	it("uses the live run state when feedback was drafted before execution began", async () => {
		const send = fixture.execution!.onSubmitFeedback!;
		await act(async () => fixture.event!({ type: "event", sessionId: "source-session", event: { type: "agent_start" } }));
		await act(async () => { expect(await send("执行途中补充的意见")).toBe(true); });
		expect(fixture.request).toHaveBeenCalledWith({ type: "session.prompt", sessionId: "source-session", message: "执行途中补充的意见", streamingBehavior: "steer" });
	});

	it("does not acknowledge old feedback as sent into a newly selected conversation", async () => {
		const pending = Promise.withResolvers<unknown>(); const base = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((request) => request.type === "session.prompt" ? pending.promise : base(request));
		let result!: Promise<boolean>;
		await act(async () => { result = fixture.execution!.onSubmitFeedback!("原会话意见"); });
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		await act(async () => pending.resolve({ ok: true }));
		await expect(result).resolves.toBe(false);
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt").map(([request]) => request.sessionId)).toEqual(["source-session"]);
		expect(fixture.chat!.entries.some((entry) => entry.kind === "user" && entry.text === "原会话意见")).toBe(false);
	});

	it("rejects a retained feedback callback after the account profile changes", async () => {
		const send = fixture.execution!.onSubmitFeedback!;
		profileDirectory = "D:/profile-two";
		await act(async () => fixture.status!(false)); await act(async () => fixture.status!(true));
		fixture.request.mockClear();
		await act(async () => { expect(await send("旧账号意见")).toBe(false); });
		expect(fixture.request.mock.calls.some(([request]) => request.type === "session.prompt")).toBe(false);
	});
});

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
	// 允许按钮带 Ctrl+Enter 快捷键标注，匹配前先剥离（与 permission-dialog.test 一致）。
	const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => (button.textContent ?? "").replace("Ctrl+Enter", "").trim() === label);
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
		if (action === "regenerate") await confirmRegenerate();
		expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ type: "rewind.execute", sessionId: "source-session" }));
		await act(async () => fixture.sidebar!.onNewChat());
		expect(fixture.sidebar!.activeId).toBe("new-session");
		await act(async () => rewind.resolve(rewindResult));
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt")).toEqual([]);
		expect(fixture.chat!.entries).toEqual([]);
		expect(fixture.composer!.draftRequest).toBeUndefined();
	});

	it("reports a failed rewind and does not send the edited text", async () => {
		let accepted!: Promise<boolean>;
		await act(async () => { accepted = fixture.chat!.onEditMessage("source-user", "改过的任务"); });
		await act(async () => { await rewind.resolve({ ok: false, error: "missing entry" }); });
		await expect(accepted).resolves.toBe(false);
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt")).toEqual([]);
		expect(document.body.textContent).toContain(t("rewind.failed"));
	});

	it("does not write a finished compaction into a conversation opened while it was running", async () => {
		const compact = Promise.withResolvers<unknown>();
		const request = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "session.compact" ? compact.promise : request(payload));
		let sent!: Promise<boolean>;
		await act(async () => { sent = fixture.composer!.onSend("/compact"); });
		expect(fixture.chat!.entries.some((entry) => entry.kind === "toolResult" && entry.brief === t("app.compactStarted"))).toBe(true);
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		await act(async () => { await compact.resolve({ ok: true, result: { model: { provider: "other", id: "compact-model" }, thinkingLevel: "high", availableThinkingLevels: ["high"], supportsThinking: true } }); });
		await act(async () => { await sent; });
		expect(fixture.chat!.entries.some((entry) => entry.kind === "toolResult" && entry.brief === t("app.compactDone"))).toBe(false);
		expect(fixture.composer!.sessionInfo?.model?.id).not.toBe("compact-model");
	});

	it("keeps composer drafts per session: switching away parks the text and switching back restores it", async () => {
		// Composer 在本 harness 是 mock，键入用 onDraftChange 模拟；重挂后的 initialDraft 即还原结果。
		const type = (text: string): void => { fixture.composer!.onDraftChange!(text); };
		type("A 会话的半段草稿");
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		expect(fixture.composer!.initialDraft ?? "").toBe("");
		type("B 会话的草稿");
		await act(async () => fixture.sidebar!.onOpenSession("source-session"));
		expect(fixture.composer!.initialDraft).toBe("A 会话的半段草稿");
		await act(async () => fixture.sidebar!.onOpenSession("other-session"));
		expect(fixture.composer!.initialDraft).toBe("B 会话的草稿");
		// 新会话是独立的一格，不受任何会话草稿影响。
		await act(async () => fixture.sidebar!.onNewChat());
		expect(fixture.composer!.initialDraft ?? "").toBe("");
	});

	it("raises a sidebar draft flag when input flips empty↔non-empty, per session", async () => {
		const type = async (text: string): Promise<void> => { await act(async () => fixture.composer!.onDraftChange!(text)); };
		await type("A 的草稿");
		// 翻转为非空：source-session 进入草稿集合。
		expect(fixture.sidebar!.draftSessions?.has("source-session")).toBe(true);
		// 清空 → 移出集合。
		await type("");
		expect(fixture.sidebar!.draftSessions?.has("source-session") ?? false).toBe(false);
		await type("再写一次");
		expect(fixture.sidebar!.draftSessions?.has("source-session")).toBe(true);
	});
	it("ignores another edit or regenerate while rewind is still pending", async () => {
		await act(async () => fixture.chat!.onRegenerate());
		await confirmRegenerate();
		await act(async () => fixture.chat!.onEditMessage("source-user", "另一条编辑"));
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "rewind.execute")).toHaveLength(1);
		await act(async () => rewind.resolve(rewindResult));
		expect(fixture.request.mock.calls.filter(([request]) => request.type === "session.prompt")).toHaveLength(1);
		expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ type: "session.prompt", message: sourceText }));
	});

	it("regenerates the last delivered user message when a queued follow-up is last", async () => {
		await act(async () => fixture.event?.({ type: "event", sessionId: "source-session", event: { type: "message_start", message: { role: "user", content: "排队跟进", queued: true } } }));
		expect(fixture.chat!.entries.at(-1)).toMatchObject({ kind: "user", text: "排队跟进", queued: true });
		await act(async () => fixture.chat!.onRegenerate());
		await confirmRegenerate();
		await act(async () => rewind.resolve(rewindResult));
		expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ type: "session.prompt", sessionId: "source-session", message: sourceText }));
	});

	it("removes an island reply the session did not accept", async () => {
		const request = fixture.request.getMockImplementation()!;
		fixture.request.mockImplementation((payload) => payload.type === "session.prompt" ? Promise.resolve({ ok: false, error: "not delivered" }) : request(payload));
		await act(async () => fixture.island!.onReply!("source-session", "岛上回复"));
		expect(fixture.chat!.entries.some((entry) => entry.kind === "user" && entry.text === "岛上回复")).toBe(false);
		expect(fixture.chat!.entries.at(-1)).toMatchObject({ kind: "toolResult", ok: false, brief: "not delivered" });
	});

	it.each(["edit", "regenerate"] as const)("replays complete %s input when the source conversation stays selected", async (action) => {
		await act(async () => replay(action));
		if (action === "regenerate") await confirmRegenerate();
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
