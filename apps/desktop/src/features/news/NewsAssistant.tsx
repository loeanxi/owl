import { useEffect, useState } from "react";
import type { NewsAssistantResult, NewsItem, NewsSnapshot } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { useT } from "../../i18n/index.ts";
import { NewsModelTest } from "./NewsModelTest.tsx";
import { errorText, type NewsClient } from "./news-client.ts";

export interface NewsContext {
	items: NewsItem[];
	quote?: string;
	storyId?: string;
	reportId?: string;
}
interface AssistantTurn {
	question: string;
	result: NewsAssistantResult;
	context: NewsContext;
}

export function NewsAssistant({
	api,
	context,
	onContext,
	onClose,
	onItem,
	onToChat,
	onConfigureSources,
	onConfigureModels,
	onOpenModelSettings,
	snapshot,
	connected,
	prefill,
}: {
	api: NewsClient;
	context: NewsContext;
	onContext: (context: NewsContext) => void;
	onClose: () => void;
	onItem: (id: string) => void;
	onToChat: (text: string) => void;
	onConfigureSources: () => void;
	onConfigureModels: () => void;
	onOpenModelSettings: () => void;
	snapshot: NewsSnapshot | undefined;
	connected: boolean;
	prefill?: { id: number; text: string };
}): React.JSX.Element {
	const t = useT();
	const [question, setQuestion] = useState("");
	const [turns, setTurns] = useState<AssistantTurn[]>([]);
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState("");
	const hasContext = context.items.length > 0 || !!context.storyId || !!context.reportId;
	const model = snapshot?.configuration.models.assistant;
	const modelName = snapshot?.models.find((entry) => entry.provider === model?.provider && entry.id === model?.id)?.name;
	useEffect(() => {
		if (prefill) setQuestion(prefill.text);
	}, [prefill]);
	const suggestions = [t("news.suggestImpact"), t("news.suggestVerify"), t("news.suggestCompare")];
	async function send(): Promise<void> {
		if (!question.trim() || busy || testing || !connected) return;
		if (!snapshot?.configuration.modelCallsEnabled) {
			setError(t("news.assistantDisabledHint"));
			return;
		}
		const submitted = question.trim();
		const submittedContext = structuredClone(context);
		setBusy(true);
		setError("");
		try {
			const result = await api.query({
				action: "assistant",
				request: {
					question: submitted,
					itemIds: context.items.map((item) => item.id),
					...(context.quote ? { quote: context.quote } : {}),
					...(context.storyId ? { storyId: context.storyId } : {}),
					...(context.reportId ? { reportId: context.reportId } : {}),
				},
			});
			setTurns((previous) => [...previous, { question: submitted, result, context: submittedContext }]);
			setQuestion("");
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	}
	function toChat(): void {
		const last = turns[turns.length - 1];
		const attached = context.items.length ? context : (last?.context ?? context);
		const sources = attached.items
			.map((item, index) => `[${index + 1}] ${item.title}\n${item.url}\n${item.summary}`)
			.join("\n\n");
		const citations =
			last?.result.citations.map((citation) => `[${citation.id}] ${citation.title}\n${citation.url}`).join("\n") ??
			"";
		onToChat(
			`${question.trim() || t("news.chatPrompt")}\n\n${t("news.contextLabel")}\n${sources}${attached.quote ? `\n\n${t("news.quote")}\n> ${attached.quote}` : ""}${last ? `\n\n${t("news.previousDiscussion")}\n${last.result.answer}\n\n${citations}` : ""}`,
		);
	}
	return (
		<aside className="owl-news-assistant" aria-label={t("news.assistant")}>
			<div className="owl-news-assistant-head">
				<strong>{t("news.assistant")}</strong>
				<button type="button" onClick={onClose} aria-label={t("common.collapse")}>
					×
				</button>
			</div>
			<div className="owl-news-context">
				<div className="owl-news-small-row">
					<span>{t("news.contextLabel")}</span>
					<button type="button" disabled={busy} onClick={() => onContext({ items: [] })}>
						{t("common.clear")}
					</button>
				</div>
				{context.items.map((item) => (
					<div className="owl-news-chip" key={item.id}>
						<button type="button" onClick={() => onItem(item.id)}>
							{item.title}
						</button>
						<button
							type="button"
							disabled={busy}
							aria-label={t("news.removeContext")}
							onClick={() =>
								onContext({ ...context, items: context.items.filter((current) => current.id !== item.id) })
							}
						>
							×
						</button>
					</div>
				))}
				{context.quote && (
					<div className="owl-news-chip">
						<span>
							{t("news.quote")}: {context.quote}
						</span>
						<button
							type="button"
							disabled={busy}
							aria-label={t("news.removeContext")}
							onClick={() => onContext({ ...context, quote: undefined })}
						>
							×
						</button>
					</div>
				)}
				{context.items.length === 0 && !context.storyId && !context.reportId && (
					<p className="owl-news-muted">{t("news.contextEmpty")}</p>
				)}
			</div>
			<div className="owl-news-assistant-messages" aria-live="polite">
				<NewsModelTest api={api} model={model} modelName={modelName} disabled={busy || !connected || !snapshot} onBusyChange={setTesting} />
				{turns.length === 0 && hasContext && (
					<>
						<h3>{t("news.assistantGreeting")}</h3>
						<p className="owl-news-muted">{t("news.assistantHint")}</p>
						<div className="owl-news-suggestions">
							{suggestions.map((suggestion) => (
								<button type="button" key={suggestion} onClick={() => setQuestion(suggestion)}>
									{suggestion}
									<span>↗</span>
								</button>
							))}
						</div>
					</>
				)}
				{turns.length === 0 && !hasContext && (
					<div className="owl-news-assistant-setup">
						<h3>{t("news.assistantFirstRunTitle")}</h3>
						<p className="owl-news-muted">{t("news.assistantFirstRunHint")}</p>
						<button type="button" onClick={onConfigureSources}>{t("news.setupSources")}</button>
						<button type="button" onClick={onOpenModelSettings}>{t("news.manageModelServices")}</button>
						<button type="button" onClick={onConfigureModels}>{t("news.chooseAssistantModel")}</button>
						<button type="button" onClick={() => setQuestion(t("news.assistantSetupPrompt"))}>{t("news.assistantSetupPrompt")}</button>
					</div>
				)}
				{turns.map((turn, index) => (
					<div key={`${index}-${turn.question}`}>
						<p className="owl-news-user-message">{turn.question}</p>
						<div className="owl-news-answer">{turn.result.answer}</div>
						<div className="owl-news-citations">
							{turn.result.citations.map((citation) => (
								<button type="button" key={citation.id} onClick={() => onItem(citation.itemId)}>
									[{citation.id}] {citation.title}
								</button>
							))}
						</div>
					</div>
				))}
				{busy && <p aria-live="polite">{t("news.thinking")}</p>}
				{error && (
					<p className="owl-news-error" role="alert">
						{error}
						{!snapshot?.configuration.modelCallsEnabled && <button type="button" onClick={onConfigureModels}>{t("news.chooseAssistantModel")}</button>}
					</p>
				)}
			</div>
			<form
				className="owl-news-assistant-composer"
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<textarea
					aria-label={t("news.askPlaceholder")}
					disabled={busy || testing || !connected}
					value={question}
					onChange={(event) => setQuestion(event.target.value)}
					placeholder={t("news.askPlaceholder")}
					rows={3}
				/>
				<div className="owl-news-small-row">
					<button type="button" disabled={busy || testing || (!hasContext && !turns.length && !question.trim())} onClick={toChat}>
						{t("news.toChat")}
					</button>
					<button type="submit" className="owl-news-primary" disabled={busy || testing || !connected || !question.trim()}>
						{t("composer.send")}
					</button>
				</div>
				<p className="owl-news-muted">{t("news.assistantScope")}</p>
			</form>
		</aside>
	);
}
