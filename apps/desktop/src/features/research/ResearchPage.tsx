import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ApprovalMode, CommandsListResult, ProviderModelsMessage, QuestionRequest, ResearchMode, ResearchResult, SlashCommandEntry } from "../../bridge/protocol.ts";
import { ChatStream, type ChatActivity } from "../../components/ChatStream.tsx";
import { ContextView } from "../../components/ContextView.tsx";
import type { ConversationView } from "../../components/ConversationHeader.tsx";
import { conversationTitleOf } from "../../components/conversation-title.ts";
import { Composer, type ComposerImage } from "../../components/Composer.tsx";
import { Menu } from "../../components/Menu.tsx";
import { QuestionDock } from "../../components/QuestionDock.tsx";
import { RetryPin } from "../../components/RetryPin.tsx";
import { TodoPin } from "../../components/TodoPin.tsx";
import { GenuiSessionProvider } from "../../components/Genui.tsx";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import { setSessionFeed } from "../../sidebar/feed.ts";
import { useResearchText, type ResearchText } from "./research-copy.ts";
import { researchCsv, safeSourceUrl } from "./research-results.ts";
import { ResearchSessionController } from "./research-session.ts";
import "./research.css";

export type ResearchPageProps = {
	client: BridgeClient;
	active: boolean;
	connected: boolean;
	cwd: string;
	providers: ProviderModelsMessage[];
	defaultModel: string;
	defaultThinkingLevel: string;
	defaultApprovalMode: ApprovalMode;
	projects?: string[];
	onSwitchProject?: (path: string) => void;
	onSessionIdChange?: (sessionId: string | undefined) => void;
	question?: QuestionRequest;
	questions?: readonly QuestionRequest[];
	onQuestionDone?: (requestId: string) => void;
	waiting?: boolean;
	resumeRequest?: { id: string; revision: number };
	newConversationRequest?: number;
	onOpenFile?: (path: string) => void;
	onOpenReview?: (path: string) => void;
	onOpenResults?: () => void;
	onOpenSettings?: () => void;
	workbenchOpen?: boolean;
	conversationView?: ConversationView;
	onTitleChange?: (title: string) => void;
};

const modeKeys = { auto: "modeAuto", crawl: "modeCrawl", web: "modeWeb", binary: "modeBinary", model: "modeModel", osint: "modeOsint" } as const;

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
		<header><div><span>{text(modeKeys[result.mode])} · {text(result.status)}</span><h2>{result.title}</h2></div><button type="button" aria-label={text("closeResults")} onClick={onClose}>×</button></header>
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
	const { client, active, connected, cwd } = props;
	const text = useResearchText();
	const t = useT();
	const controller = useMemo(() => new ResearchSessionController(client, localStorage, cwd, { model: props.defaultModel, thinkingLevel: props.defaultThinkingLevel, approvalMode: props.defaultApprovalMode, mode: "auto" }), [client, cwd]);
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const [composerKey, setComposerKey] = useState(0);
	const [selectedResultId, setSelectedResultId] = useState<string>();
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [localError, setLocalError] = useState<string>();
	const [commands, setCommands] = useState<SlashCommandEntry[]>([]);
	const draftSequence = useRef(0);
	const newRequest = useRef(props.newConversationRequest);
	const resumeRevision = useRef<string | undefined>(undefined);
	const visibleResult = state.results.find((result) => result.id === selectedResultId);
	const pendingQuestions = (props.questions ?? (props.question ? [props.question] : [])).filter((question) => question.sessionId === state.sessionId);
	const activity: ChatActivity = !connected ? "disconnected" : props.waiting || pendingQuestions.length > 0 ? "waiting" : state.running ? "working" : "idle";
	const title = conversationTitleOf(state.entries, t("app.newConversation"));
	useEffect(() => { props.onTitleChange?.(title); }, [title, props.onTitleChange]);

	useEffect(() => { controller.start(); return () => controller.dispose(); }, [controller]);
	useEffect(() => { controller.setConnected(connected); if (active && connected) void controller.attach(); }, [controller, active, connected]);
	useEffect(() => { props.onSessionIdChange?.(state.sessionId); }, [state.sessionId, props.onSessionIdChange]);
	useEffect(() => {
		if (!props.resumeRequest || !active) return;
		const revision = `${cwd}:${props.resumeRequest.id}:${props.resumeRequest.revision}`;
		if (resumeRevision.current === revision) return;
		resumeRevision.current = revision;
		void controller.resume(props.resumeRequest.id);
	}, [controller, active, props.resumeRequest]);
	useEffect(() => {
		if (!active || newRequest.current === props.newConversationRequest) return;
		newRequest.current = props.newConversationRequest;
		if (controller.newThread()) setComposerKey((key) => key + 1);
		else setLocalError(text("newWhileRunning"));
	}, [controller, active, props.newConversationRequest]);
	useEffect(() => { setSelectedResultId(undefined); setLocalError(undefined); setDraftRequest(undefined); setComposerKey((key) => key + 1); }, [controller]);
	useEffect(() => { if (props.workbenchOpen) setSelectedResultId(undefined); }, [props.workbenchOpen]);
	useEffect(() => { if (props.conversationView === "context") setSelectedResultId(undefined); }, [props.conversationView]);
	useEffect(() => { if (active) setSessionFeed({ running: state.running, entries: state.entries }); }, [active, state.running, state.entries]);
	useEffect(() => {
		if (!connected || !active) return;
		let cancelled = false;
		void client.request<CommandsListResult>({ type: "commands.list", cwd }).then((response) => { if (!cancelled && response.ok) setCommands(response.result?.commands ?? []); }).catch(() => {});
		return () => { cancelled = true; };
	}, [client, cwd, state.sessionId, connected, active]);
	useEffect(() => {
		if (!visibleResult) return;
		const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setSelectedResultId(undefined); };
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, [visibleResult]);

	const fillDraft = (value: string): void => { setDraftRequest({ id: ++draftSequence.current, text: value }); };
	const newThread = (): void => { if (controller.newThread()) { setComposerKey((key) => key + 1); setSelectedResultId(undefined); setLocalError(undefined); } };
	const send = async (value: string, images?: ComposerImage[]): Promise<void> => {
		setLocalError(undefined);
		const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
		const matchedCommand = match && commands.find((command) => command.name === match[1]);
		if (match && (matchedCommand?.kind === "builtin" || (!matchedCommand && ["new", "settings", "model", "thinking", "compact"].includes(match[1])))) {
			if (match[1] === "settings") { props.onOpenSettings?.(); return; }
			if (match[1] === "new") { newThread(); return; }
			if (await controller.executeBuiltin(match[1], match[2] ?? "")) return;
			return;
		}
		await controller.send(value, images);
	};
	const openSource = (url: string): void => {
		void client.request({ type: "open.external", action: "url", target: url }).then((response) => { if (!response.ok) setLocalError(response.error ?? text("sourceFailed")); }).catch((error: unknown) => setLocalError(error instanceof Error ? error.message : String(error)));
	};
	const openResult = (id: string): void => { props.onOpenResults?.(); setSelectedResultId(id); setSourcesOpen(false); };
	const error = localError ?? state.error;

	return <section className="research-page" aria-label={text("title")}>
		<div className="research-content">
			<div className="research-conversation">
				{props.conversationView === "context" ? <ContextView key={`research-context:${state.sessionId ?? cwd}`} client={client} cwd={cwd} sessionId={state.sessionId} requireSession active={active && connected} /> : state.entries.length ? <GenuiSessionProvider client={client} sessionId={state.sessionId}><ChatStream entries={state.entries} activity={activity} client={client} cwd={cwd} onOpenFile={props.onOpenFile} onOpenReview={props.onOpenReview} artifacts={<ResultCards results={state.results} text={text} onOpen={openResult} onDraft={fillDraft} />} /></GenuiSessionProvider> : <div className="research-welcome"><img src="/owl.svg" alt="" /><h2>{text("emptyTitle")}</h2><p>{text("emptyHint")}<br />{text("emptyDetail")}</p><div className="research-examples"><button type="button" onClick={() => fillDraft(text("crawlDraft"))}>{text("exampleCrawl")}</button><button type="button" onClick={() => fillDraft(text("webDraft"))}>{text("exampleWeb")}</button><button type="button" onClick={() => fillDraft(text("modelDraft"))}>{text("exampleModel")}</button></div></div>}
				{(!connected || !state.ready || error) && <div className="research-notice" role={error ? "alert" : "status"}>{error ? <><span>{error}</span>{connected && !state.ready && <button type="button" disabled={state.busy} onClick={() => void controller.attach()}>{text("retry")}</button>}{connected && state.failedPrompt && <button type="button" disabled={state.running || state.busy || !state.ready} onClick={() => { const failed = state.failedPrompt; if (failed) void controller.send(failed.text, failed.images); }}>{text("retrySend")}</button>}</> : !connected ? text("disconnected") : text("restoring")}</div>}
				<RetryPin status={state.retryStatus} onDismiss={() => controller.dismissRetry()} />
				<TodoPin key={`research-todos:${state.sessionId ?? cwd}`} entries={state.entries} />
				<QuestionDock requests={pendingQuestions} activeRequest={pendingQuestions[0]} onAnswer={(requestId, answers, cancelled) => { client.respondQuestion(requestId, answers, cancelled); props.onQuestionDone?.(requestId); }}>
					<Composer key={`${cwd}:${composerKey}`} client={client} sessionScope="research" connected={connected} disabled={!connected || !state.ready || state.running || state.busy || pendingQuestions.length > 0 || Boolean(props.waiting)} running={state.running} hideEnvironment={connected && (pendingQuestions.length > 0 || state.running)}
						environmentAccessory={<div className="research-composer-mode"><Menu triggerClassName="research-mode-button" panelClassName="right-0 w-56" trigger={<><ResearchMark /><span>{text("modePrefix")} · {text(modeKeys[state.mode])}</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" className="research-mode-chevron" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg></>}>{(close) => <div>{(Object.keys(modeKeys) as ResearchMode[]).map((mode) => <button className="research-mode-option" type="button" aria-pressed={state.mode === mode} disabled={state.running || state.busy} key={mode} onClick={() => { controller.setMode(mode); close(); }}><span>{text(modeKeys[mode])}</span>{mode === state.mode && <span>✓</span>}</button>)}</div>}</Menu></div>}
						onSend={(value, images) => void send(value, images)} onAbort={() => void controller.abort()} providers={props.providers} model={state.model} onModel={(value) => void controller.setModel(value)} thinkingLevel={state.thinkingLevel} onThinkingLevel={(value) => void controller.setThinkingLevel(value)} approvalMode={state.approvalMode} onApprovalMode={(mode) => void controller.setApprovalMode(mode)} sessionInfo={state.stats} workspaceDir={cwd} projects={props.projects ?? [cwd]} onSwitchProject={props.onSwitchProject ?? (() => undefined)} commands={commands} draftRequest={draftRequest} />
				</QuestionDock>
			</div>
			{visibleResult && <ResultPanel result={visibleResult} sourcesOpen={sourcesOpen} onSources={setSourcesOpen} onClose={() => setSelectedResultId(undefined)} onDraft={fillDraft} onOpenSource={openSource} text={text} />}
		</div>
	</section>;
}
