import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { QuestionAnswerPayload, SessionSearchMessageResult } from "../../bridge/protocol.ts";
import { PendingResponses, PendingResponsesContext, usePendingResponses } from "../../bridge/pending-responses.ts";
import type { AgentPresetDefinition, ApprovalMode, CommandsListResult, FsSearchHit, ProviderModelsMessage, QuestionRequest, ResearchResult, SlashCommandEntry } from "../../bridge/protocol.ts";
import { ChatStream, type ChatActivity, type MessageSearchTarget } from "../../components/ChatStream.tsx";
import { ContextView } from "../../components/ContextView.tsx";
import type { ConversationView } from "../../components/ConversationHeader.tsx";
import { conversationTitleOf } from "../../components/conversation-title.ts";
import { Composer, type ComposerImage } from "../../components/Composer.tsx";
import { useSessionOwlPose } from "../../components/OwlMascot.tsx";
import { QuestionDock } from "../../components/QuestionDock.tsx";
import { RetryPin } from "../../components/RetryPin.tsx";
import { TaskRecoveryNotice } from "../../components/TaskRecoveryNotice.tsx";
import { TodoPin } from "../../components/TodoPin.tsx";
import { GenuiSessionProvider } from "../../components/Genui.tsx";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import type { ToolCard } from "../../hooks/transcript.ts";
import { taskRecovery } from "../../hooks/task-recovery.ts";
import { TrajectoryView } from "../trajectory/TrajectoryView.tsx";
import { setSessionFeed } from "../../sidebar/feed.ts";
import { useResearchText, type ResearchText } from "./research-copy.ts";
import { researchCsv, researchResultsForTurn, safeSourceUrl } from "./research-results.ts";
import { ResearchSessionController } from "./research-session.ts";
import { ResearchPromptSettings } from "./ResearchPromptSettings.tsx";
import { ResearchPromptController } from "./research-prompts.ts";
import { ResearchDiagnosisNotice } from "./ResearchDiagnosisNotice.tsx";
import { ResearchTaskNotice } from "./ResearchTaskNotice.tsx";
import "./research.css";

export type ResearchPageProps = {
	client: BridgeClient;
	active: boolean;
	connected: boolean;
	cwd: string;
	profile?: string;
	queueProfile?: string;
	queueIsCurrent?: () => boolean;
	deliveryRequest?: number;
	searchTarget?: MessageSearchTarget;
	searchHistoryMessage?: SessionSearchMessageResult;
	restorePending?: boolean;
	providers: ProviderModelsMessage[];
	defaultModel: string;
	defaultThinkingLevel: string;
	defaultApprovalMode: ApprovalMode;
	agentPresets?: AgentPresetDefinition[];
	defaultPresetId?: string;
	defaultAgentPreset?: string;
	projects?: string[];
	workspaceSelected?: boolean;
	onSwitchProject?: (path: string) => void;
	onClearProject?: () => void;
	onSessionIdChange?: (sessionId: string | undefined) => void;
	question?: QuestionRequest;
	questions?: readonly QuestionRequest[];
	onQuestionDone?: (requestId: string) => void;
	onQuestionAnswer?: (requestId: string, answers: QuestionAnswerPayload[], cancelled: boolean) => void;
	waiting?: boolean;
	resumeRequest?: { id: string; revision: number };
	newConversationRequest?: number;
	onOpenFile?: (path: string) => void;
	onOpenReview?: (path: string) => void;
	onOpenResults?: () => void;
	onOpenSettings?: () => void;
	sidebarOpen?: boolean;
	conversationView?: ConversationView;
	/** 会话内任务卡的「任务页」跳转（主区共享）。 */
	onOpenAutomation?: () => void;
	onOpenSubagent?: (card: ToolCard) => void;
	subagentControl?: ReactNode;
	onTitleChange?: (title: string) => void;
};

const resultMethodKeys = { crawl: "methodCrawl", web: "methodWeb", binary: "methodBinary", model: "methodModel", osint: "methodOsint" } as const;

function ResearchMark(): React.JSX.Element {
	return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m10 2 2.2 5.8L18 10l-5.8 2.2L10 18l-2.2-5.8L2 10l5.8-2.2L10 2Z" /></svg>;
}

function ResultCards({ results, text, onOpen, onDraft }: { results: ResearchResult[]; text: ResearchText; onOpen: (id: string) => void; onDraft: (value: string) => void }): React.JSX.Element {
	return <div className="research-result-cards">
		{results.map((result) => <article className="research-result-card" key={result.id}>
			<header><ResearchMark /><strong>{result.title}</strong><span>{text(result.status)}</span></header>
			<p>{result.summary}</p>
			<div className="research-result-meta">{text("records", { n: result.rows.length })} · {text("sourceCount", { n: result.sources.length })}</div>
			<div className="research-result-actions"><button type="button" onClick={() => onOpen(result.id)}>{text("view")} <span aria-hidden="true">→</span></button><button type="button" onClick={() => onDraft(text("continueDraft", { title: result.title }))}>{text("continue")}</button><button type="button" onClick={() => onDraft(text("explainDraft", { title: result.title }))}>{text("explain")}</button></div>
		</article>)}
	</div>;
}

function ResultPanel({ result, sourcesOpen, onSources, onClose, onDraft, onOpenSource, text }: { result: ResearchResult; sourcesOpen: boolean; onSources: (value: boolean) => void; onClose: () => void; onDraft: (value: string) => void; onOpenSource: (url: string) => void; text: ResearchText }): React.JSX.Element {
	const download = (format: "csv" | "json"): void => {
		const blob = new Blob([format === "csv" ? researchCsv(result) : JSON.stringify(result, null, 2)], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${result.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "research"}.${format}`;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	return <aside className="research-result-panel" aria-label={result.title}>
		<header><div><span>{text(resultMethodKeys[result.mode])} · {text(result.status)}</span><h2>{result.title}</h2></div><button type="button" aria-label={text("closeResults")} onClick={onClose}>×</button></header>
		<div className="research-result-body">
			<p className="research-result-summary">{result.summary}</p>
			<div className="research-result-actions research-export"><button type="button" onClick={() => download("json")}>{text("exportJson")}</button>{result.columns.length > 0 && <button type="button" onClick={() => download("csv")}>{text("exportCsv")}</button>}</div>
			<div className="research-panel-tabs"><button type="button" aria-pressed={!sourcesOpen} onClick={() => onSources(false)}>{text("data")}</button><button type="button" aria-pressed={sourcesOpen} onClick={() => onSources(true)}>{text("sources")} <span>{result.sources.length}</span></button></div>
			{!sourcesOpen && <>
				{result.rows.length > 0 && result.columns.length > 0 ? <div className="research-table-scroll"><table><thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.key}>{String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody></table></div> : <p className="research-muted">{text("noRows")}</p>}
				{result.findings.length > 0 && <section className="research-findings"><h3>{text("findings")}</h3>{result.findings.map((finding, index) => <article key={index}><span data-kind={finding.kind}>{text(finding.kind)}</span><p>{finding.text}</p>{finding.sourceIds.length > 0 && <button type="button" onClick={() => onSources(true)}>{text("showSources")} · {finding.sourceIds.length}</button>}</article>)}</section>}
			</>}
			{sourcesOpen && <section className="research-sources">{result.sources.length ? result.sources.map((source) => {
				const url = safeSourceUrl(source.url);
				return <article key={source.id}><h3>{source.title}</h3>{source.note && <p>{source.note}</p>}{source.url && <small>{source.url}</small>}{url && <button type="button" onClick={() => onOpenSource(url)}>{text("openSource")} ↗</button>}</article>;
			}) : <p className="research-muted">{text("noSources")}</p>}</section>}
			<p className="research-result-time">{text("publishedAt", { time: Number.isNaN(Date.parse(result.createdAt)) ? result.createdAt : new Date(result.createdAt).toLocaleString(getUiLanguage() === "en" ? "en" : "zh-CN") })}</p>
		</div>
		<footer><p>{text("nextHint")}</p><button type="button" onClick={() => onDraft(text("continueDraft", { title: result.title }))}>{text("continue")} →</button></footer>
	</aside>;
}

export function ResearchPage(props: ResearchPageProps): React.JSX.Element {
	const { client, active, connected, cwd, onOpenSubagent } = props;
	const { controller: sharedResponses } = usePendingResponses();
	const localResponses = useMemo(() => new PendingResponses(), [props.profile, client]);
	useEffect(() => { localResponses.activate(); return () => localResponses.invalidate(); }, [localResponses]);
	const responseController = sharedResponses ?? localResponses;
	const text = useResearchText();
	const t = useT();
	const disabledPresets = Object.fromEntries((props.agentPresets ?? []).filter((preset) => preset.runtime === "pi" || preset.id === "pi").map((preset) => [preset.id, text("piPresetUnavailable")]));
	const homePreset = props.defaultAgentPreset || props.defaultPresetId || "standard";
	const defaultPreset = homePreset === "pi" || Object.hasOwn(disabledPresets, homePreset) ? "standard" : homePreset;
	const controller = useMemo(() => new ResearchSessionController(client, localStorage, cwd, { model: props.defaultModel, thinkingLevel: props.defaultThinkingLevel, approvalMode: props.defaultApprovalMode, agentPreset: defaultPreset }), [client, cwd]);
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const queueOwnerRevision = controller.getQueueOwnerRevision();
	const promptController = useMemo(() => new ResearchPromptController(client), [client]);
	const promptState = useSyncExternalStore(promptController.subscribe, promptController.getSnapshot);
	const stagedPreset = state.agentPreset ?? defaultPreset;
	const selectedPreset = stagedPreset === "pi" || Object.hasOwn(disabledPresets, stagedPreset) ? defaultPreset : stagedPreset;
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const [composerKey, setComposerKey] = useState(0);
	const [selectedResultId, setSelectedResultId] = useState<string>();
	const [promptsOpen, setPromptsOpen] = useState(false);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [localError, setLocalError] = useState<string>();
	const [commands, setCommands] = useState<SlashCommandEntry[]>([]);
	const draftSequence = useRef(0);
	const newRequest = useRef(props.newConversationRequest);
	const resumeRevision = useRef<string | undefined>(undefined);
	const promptButton = useRef<HTMLButtonElement>(null);
	const visibleResult = state.results.find((result) => result.id === selectedResultId);
	const activePrompt = promptState.saved?.presets.find((preset) => preset.id === promptState.saved?.activePresetId);
	const pendingQuestions = (props.questions ?? (props.question ? [props.question] : [])).filter((question) => question.sessionId === state.sessionId);
	const activity: ChatActivity = !connected ? "disconnected" : props.waiting || pendingQuestions.length > 0 ? "waiting" : state.running ? "working" : "idle";
	const owlPose = useSessionOwlPose(activity, state.entries);
	const title = conversationTitleOf(state.entries, t("app.newConversation"));
	useEffect(() => { props.onTitleChange?.(title); }, [title, props.onTitleChange]);

	useEffect(() => { controller.start(); return () => controller.dispose(); }, [controller]);
	useEffect(() => { promptController.setConnected(connected); if (active && connected) void promptController.load(); }, [promptController, active, connected]);
	useEffect(() => { controller.setDefaultAgentPreset(defaultPreset, Object.keys(disabledPresets)); }, [controller, defaultPreset, props.agentPresets]);
	useEffect(() => { controller.setConnected(connected); if (active && connected && !props.restorePending) void controller.attach(); }, [controller, active, connected, props.restorePending]);
	useEffect(() => { props.onSessionIdChange?.(state.sessionId); }, [state.sessionId, props.onSessionIdChange]);
	useEffect(() => {
		if (!props.resumeRequest || !active || props.restorePending) return;
		const revision = `${cwd}:${props.resumeRequest.id}:${props.resumeRequest.revision}`;
		if (resumeRevision.current === revision) return;
		resumeRevision.current = revision;
		void controller.resume(props.resumeRequest.id);
	}, [controller, active, props.resumeRequest, props.restorePending]);
	useEffect(() => {
		if (!active || props.restorePending || newRequest.current === props.newConversationRequest) return;
		newRequest.current = props.newConversationRequest;
		// 运行中也允许新开对话（旧任务留在后台），仅断线时新线程不可用（顶部已有断线提示）。
		if (controller.newThread()) setComposerKey((key) => key + 1);
	}, [controller, active, props.newConversationRequest, props.restorePending]);
	useEffect(() => { setSelectedResultId(undefined); setLocalError(undefined); setDraftRequest(undefined); setComposerKey((key) => key + 1); }, [controller]);
	useEffect(() => { if (props.sidebarOpen) setSelectedResultId(undefined); }, [props.sidebarOpen]);
	useEffect(() => { if (props.conversationView === "context") setSelectedResultId(undefined); }, [props.conversationView]);
	useEffect(() => { if (active) setSessionFeed({ running: state.running, entries: state.entries }); }, [active, state.running, state.entries]);
	useEffect(() => {
		if (!connected || !active) return;
		let cancelled = false;
		void client.request<CommandsListResult>({ type: "commands.list", cwd }).then((response) => { if (!cancelled && response.ok) setCommands(response.result?.commands ?? []); }).catch(() => {});
		return () => { cancelled = true; };
	}, [client, cwd, state.sessionId, connected, active]);
	useEffect(() => {
		if (!visibleResult && !promptsOpen) return;
		const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { setSelectedResultId(undefined); if (promptsOpen) { setPromptsOpen(false); promptButton.current?.focus(); } } };
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, [visibleResult, promptsOpen]);

	const fillDraft = (value: string): void => { setDraftRequest({ id: ++draftSequence.current, text: value }); };
	const newThread = (): boolean => { const created = controller.newThread(); if (created) { setComposerKey((key) => key + 1); setSelectedResultId(undefined); setLocalError(undefined); } return created; };
	const send = async (value: string, images?: ComposerImage[], attachedPaths?: string[], delivery?: "queue" | "steer"): Promise<boolean> => {
		setLocalError(undefined);
		const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
		const matchedCommand = match && commands.find((command) => command.name === match[1]);
		if (match && (matchedCommand?.kind === "builtin" || (!matchedCommand && ["new", "settings", "model", "thinking", "compact"].includes(match[1])))) {
			if (match[1] === "settings") { props.onOpenSettings?.(); return true; }
			if (match[1] === "new") return newThread();
			return controller.executeBuiltin(match[1], match[2] ?? "");
		}
		return controller.send(value, images, attachedPaths, delivery);
	};
	const openSource = (url: string): void => {
		void client.request({ type: "open.external", action: "url", target: url }).then((response) => { if (!response.ok) setLocalError(response.error ?? text("sourceFailed")); }).catch((error: unknown) => setLocalError(error instanceof Error ? error.message : String(error)));
	};
	const openResult = (id: string): void => { props.onOpenResults?.(); setPromptsOpen(false); setSelectedResultId(id); setSourcesOpen(false); };
	const error = localError ?? state.error;
	const recovery = !state.running && !state.failedPrompt ? taskRecovery(state.entries, state.retryStatus) : undefined;

	return <PendingResponsesContext.Provider value={responseController}><section className="research-page" aria-label={text("title")}>
		<div className="research-prompt-toolbar"><span>{promptState.ready ? promptState.saved?.enabled && activePrompt ? text("promptEnabled", { name: activePrompt.name }) : text("promptDefault") : ""}</span><button ref={promptButton} type="button" aria-expanded={promptsOpen} onClick={() => { setSelectedResultId(undefined); setPromptsOpen((open) => !open); }}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12" /><circle cx="7" cy="5" r="2" fill="var(--color-owl-bg)" /><circle cx="13" cy="10" r="2" fill="var(--color-owl-bg)" /><circle cx="8" cy="15" r="2" fill="var(--color-owl-bg)" /></svg>{text("promptManage")}</button></div>
		<div className="research-content">
			<div className="research-conversation">
				{props.conversationView === "trajectory" ? <TrajectoryView entries={state.entries} active={active} /> : props.conversationView === "context" ? <ContextView key={`research-context:${state.sessionId ?? cwd}`} client={client} cwd={cwd} sessionId={state.sessionId} requireSession active={active && connected} /> : state.entries.length ? <GenuiSessionProvider client={client} sessionId={state.sessionId}><ChatStream key={state.sessionId ?? cwd} sessionId={state.sessionId} profile={props.profile} deliveryRequest={props.deliveryRequest} searchHistoryMessage={props.searchHistoryMessage && !state.entries.some((entry) => (entry.kind === "user" || entry.kind === "assistant") && entry.entryId === props.searchHistoryMessage!.entryId) ? props.searchHistoryMessage : undefined} searchTarget={props.searchTarget?.sessionId === state.sessionId ? props.searchTarget : undefined} entries={state.entries} activity={activity} client={client} cwd={cwd} onOpenFile={props.onOpenFile} onOpenReview={props.onOpenReview} onOpenAutomation={props.onOpenAutomation} onOpenSubagent={onOpenSubagent} renderTurnArtifacts={(entries) => { const results = researchResultsForTurn(entries); return results.length ? <ResultCards results={results} text={text} onOpen={openResult} onDraft={fillDraft} /> : null; }} /></GenuiSessionProvider> : <div className="research-welcome"><img src="/owl.svg" alt="" /><h2>{text("emptyTitle")}</h2><p>{text("emptyHint")}<br />{text("emptyDetail")}</p></div>}
				{(!connected || !state.ready || error) && <div className="research-notice" role={error ? "alert" : "status"}>{error ? <><span>{error}</span>{connected && !state.ready && <button type="button" disabled={state.busy} onClick={() => void controller.attach()}>{text("retry")}</button>}{connected && state.failedPrompt && <button type="button" disabled={state.busy || !state.ready} onClick={() => { const failed = state.failedPrompt; if (failed) void controller.send(failed.text, failed.images, failed.attachedPaths, failed.delivery); }}>{text("retrySend")}</button>}</> : !connected ? text("disconnected") : text("restoring")}</div>}
				<RetryPin status={state.retryStatus?.phase === "retrying" ? state.retryStatus : null} onDismiss={() => controller.dismissRetry()} />
				<TaskRecoveryNotice recovery={recovery} providers={props.providers} model={state.model} disabled={!connected || !state.ready || state.busy} onContinue={(model) => controller.continue(model)} onOpenSettings={props.onOpenSettings} />
				<ResearchDiagnosisNotice diagnosis={state.diagnosis} running={state.running} />
				<ResearchTaskNotice task={state.task} sessionId={state.sessionId} running={state.running} />
				<div className="owl-conversation-pins"><TodoPin key={`research-todos:${state.sessionId ?? cwd}`} entries={state.entries} />{props.subagentControl}</div>
				<QuestionDock requests={pendingQuestions} activeRequest={pendingQuestions[0]} onAnswer={(requestId, answers, cancelled) => { if (props.onQuestionAnswer) props.onQuestionAnswer(requestId, answers, cancelled); else { const request = pendingQuestions.find((item) => item.requestId === requestId); if (request) void responseController.submit({ requestId, sessionId: request.sessionId, respond: () => client.respondQuestion(requestId, answers, cancelled), confirmed: () => props.onQuestionDone?.(requestId) }); } }}>
					<Composer key={`${cwd}:${composerKey}`} client={client} sessionScope="research" connected={connected} disabled={!connected || !state.ready || state.busy || pendingQuestions.length > 0 || Boolean(props.waiting)} running={state.running} paused={state.paused} queued={state.queue} queueSessionId={state.sessionId} queueProfile={props.queueProfile} queueOwnerRevision={queueOwnerRevision} queueIsCurrent={() => controller.isQueueOwnerCurrent(queueOwnerRevision, state.sessionId) && (props.queueIsCurrent?.() ?? true)} onQueueChange={(queue) => controller.applyQueue(queue, state.sessionId)} onPause={() => void controller.pause()} onResume={() => void controller.continue()} hideEnvironment={connected && (pendingQuestions.length > 0 || state.running)} questionPending={pendingQuestions.length > 0}
						agentPresets={props.agentPresets} defaultPresetId={props.defaultPresetId} agentPreset={state.sessionId ? state.sessionPreset ?? "standard" : selectedPreset} agentPresetLocked={Boolean(state.sessionId) && state.entries.length > 0} agentPresetDisabledReasons={disabledPresets} onAgentPresetSelect={(id) => { if (!Object.hasOwn(disabledPresets, id)) void controller.setAgentPreset(id); }}
						onSend={send} onAbort={() => void controller.abort()} providers={props.providers} model={state.model} onModel={(value) => void controller.setModel(value)} thinkingLevel={state.thinkingLevel} onThinkingLevel={(value) => void controller.setThinkingLevel(value)} approvalMode={state.approvalMode} onApprovalMode={(mode) => void controller.setApprovalMode(mode)} sessionInfo={state.stats} workspaceDir={cwd} projects={props.projects ?? [cwd]} workspaceSelected={props.workspaceSelected} onSwitchProject={props.onSwitchProject ?? (() => undefined)} onClearProject={props.onClearProject} commands={commands}
						searchFiles={(searchCwd, query) => client.request<FsSearchHit[]>({ type: "fs.search", cwd: searchCwd, query }).then((r) => (r.ok ? r.result ?? [] : []))} draftRequest={draftRequest} owlPose={owlPose} />
				</QuestionDock>
			</div>
			{promptsOpen ? <ResearchPromptSettings controller={promptController} running={state.running} onClose={() => { setPromptsOpen(false); promptButton.current?.focus(); }} /> : visibleResult && <ResultPanel result={visibleResult} sourcesOpen={sourcesOpen} onSources={setSourcesOpen} onClose={() => setSelectedResultId(undefined)} onDraft={fillDraft} onOpenSource={openSource} text={text} />}
		</div>
	</section></PendingResponsesContext.Provider>;
}
