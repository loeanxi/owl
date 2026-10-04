import { useEffect, useMemo, useRef, useState } from "react";
import type {
	NewsItem,
	NewsListQuery,
	NewsReportKind,
	NewsSnapshot,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { IconNews, IconSearch } from "../../components/icons.tsx";
import { type TextKey, useT } from "../../i18n/index.ts";
import { NewsAssistant, type NewsContext } from "./NewsAssistant.tsx";
import { NewsContentManagement } from "./NewsContentManagement.tsx";
import { NewsManagement } from "./NewsManagement.tsx";
import { NewsItemReader, NewsReportReader, NewsStoryReader, type NewsTarget } from "./NewsReading.tsx";
import { NewsSources } from "./NewsSources.tsx";
import { errorText, NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";
import "./news.css";

type NewsSection =
	| "selected"
	| "all"
	| "hot"
	| NewsReportKind
	| "saved"
	| "topics"
	| "sources"
	| "content"
	| "configuration"
	| "operations"
	| "evaluation"
	| "exports";
const SECTIONS: { id: NewsSection; key: TextKey }[] = [
	{ id: "selected", key: "news.selected" },
	{ id: "all", key: "news.all" },
	{ id: "hot", key: "news.hot" },
	{ id: "daily", key: "news.daily" },
	{ id: "weekly", key: "news.weekly" },
	{ id: "monthly", key: "news.monthly" },
	{ id: "saved", key: "news.saved" },
	{ id: "topics", key: "news.topics" },
];
const MANAGEMENT: { id: NewsSection; key: TextKey }[] = [
	{ id: "content", key: "news.contentManagement" },
	{ id: "sources", key: "news.sources" },
	{ id: "configuration", key: "news.configuration" },
	{ id: "operations", key: "news.operations" },
	{ id: "evaluation", key: "news.evaluation" },
	{ id: "exports", key: "news.exports" },
];

export function NewsPage({
	client,
	onToChat,
	onOpenModelSettings,
	initialTarget,
	active = true,
	sidebarCollapsed = false,
}: {
	client: BridgeClient;
	onToChat: (text: string) => void;
	onOpenModelSettings: () => void;
	active?: boolean;
	sidebarCollapsed?: boolean;
	initialTarget?: NewsTarget & { revision: number };
}): React.JSX.Element {
	const t = useT();
	const api = useMemo(() => new NewsClient(client), [client]);
	const [snapshot, setSnapshot] = useState<NewsSnapshot>();
	const [section, setSection] = useState<NewsSection>("selected");
	const [target, setTarget] = useState<NewsTarget>();
	const [revision, setRevision] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [connected, setConnected] = useState(true);
	const [category, setCategory] = useState("");
	const [topic, setTopic] = useState("");
	const [query, setQuery] = useState("");
	const [queryInput, setQueryInput] = useState("");
	const [context, setContext] = useState<NewsContext>({ items: [] });
	const [assistantOpen, setAssistantOpen] = useState(true);
	const [prefill, setPrefill] = useState<{ id: number; text: string }>();
	const prefillSeq = useRef(0);
	const lastStatus = useRef("");
	const snapshotRevision = useRef(0);
	const contentRef = useRef<HTMLElement>(null);
	const refreshed = (): void => setRevision((current) => current + 1);
	useEffect(() => {
		if (!MANAGEMENT.some((entry) => entry.id === section)) return;
		const compact = window.matchMedia("(max-width: 1100px)");
		const closeAssistantForManagement = (): void => {
			if (compact.matches) setAssistantOpen(false);
		};
		closeAssistantForManagement();
		compact.addEventListener("change", closeAssistantForManagement);
		return () => compact.removeEventListener("change", closeAssistantForManagement);
	}, [section]);
	useEffect(
		() =>
			client.onStatus((up) => {
				setConnected(up);
				if (up) refreshed();
			}),
		[client],
	);
	useEffect(() => {
		let current = true;
		const serial = ++snapshotRevision.current;
		setLoading(!snapshot);
		setError("");
		void api
			.query({ action: "snapshot" })
			.then(
				(value) => {
					if (!current || serial !== snapshotRevision.current) return;
					setSnapshot(value);
					lastStatus.current = JSON.stringify(value.status);
				},
				(failure: unknown) => {
					if (current) setError(errorText(failure));
				},
			)
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [api, revision]);
	useEffect(() => {
		if (!active || !connected) return;
		let current = true;
		let inFlight = false;
		const timer = setInterval(() => {
			if (inFlight) return;
			inFlight = true;
			const serial = snapshotRevision.current;
			void api
				.query({ action: "snapshot" })
				.then(
					(value) => {
						if (!current || serial !== snapshotRevision.current) return;
						setSnapshot(value);
						const status = JSON.stringify(value.status);
						if (lastStatus.current !== status) {
							lastStatus.current = status;
							refreshed();
						}
					},
					(failure: unknown) => {
						if (current) setError(errorText(failure));
					},
				)
				.finally(() => {
					inFlight = false;
				});
		}, 10_000);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [api, active, connected]);
	useEffect(() => {
		if (!initialTarget) return;
		setTarget(initialTarget);
		if (initialTarget.kind === "daily" || initialTarget.kind === "weekly" || initialTarget.kind === "monthly")
			setSection(initialTarget.kind);
	}, [initialTarget]);
	function openItem(id: string): void {
		setTarget({ kind: "item", id });
		void api.query({ action: "read", id, read: true }).catch((failure: unknown) => setError(errorText(failure)));
	}
	function selectSection(next: NewsSection): void {
		setSection(next);
		setTarget(undefined);
		setTopic("");
		contentRef.current?.scrollTo({ top: 0 });
	}
	function discuss(next: NewsContext): void {
		setContext(next);
		setAssistantOpen(true);
	}
	function toggleContext(item: NewsItem): void {
		setContext((previous) =>
			previous.items.some((entry) => entry.id === item.id)
				? { ...previous, items: previous.items.filter((entry) => entry.id !== item.id), quote: undefined }
				: { items: [...previous.items.slice(-1), item] },
		);
	}
	const reading = {
		api,
		revision,
		snapshot,
		onItem: openItem,
		onStory: (id: string) => setTarget({ kind: "story", id }),
		onDiscuss: discuss,
		onChanged: refreshed,
	};
	const title = target
		? target.kind === "item"
			? t("news.reading")
			: target.kind === "story"
				? t("news.event")
				: t(`news.${target.kind}`)
		: t([...SECTIONS, ...MANAGEMENT].find((entry) => entry.id === section)?.key ?? "news.selected");
	return (
		<div className="owl-news-module">
			<nav
				className="owl-news-sidebar"
				id="owl-news-sidebar"
				style={{ display: sidebarCollapsed ? "none" : undefined }}
				aria-label={t("news.navigation")}
			>
				<div className="owl-news-brand">
					<IconNews />
					<strong>Owl</strong>
					<span>{t("news.local")}</span>
				</div>
				<div className="owl-news-sidebar-intro">
					<h2>{t("news.titleName")}</h2>
					<p>{t("news.subtitle")}</p>
				</div>
				<div className="owl-news-nav-caption">{t("news.reading")}</div>
				{SECTIONS.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className={section === entry.id ? "is-active" : ""}
						aria-current={section === entry.id ? "page" : undefined}
						onClick={() => selectSection(entry.id)}
					>
						<span>{t(entry.key)}</span>
						{entry.id === "selected" && snapshot && <small>{snapshot.status.selectedCount}</small>}
					</button>
				))}
				<div className="owl-news-nav-caption">{t("news.management")}</div>
				{MANAGEMENT.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className={section === entry.id ? "is-active" : ""}
						onClick={() => selectSection(entry.id)}
					>
						{t(entry.key)}
					</button>
				))}
				<div className="owl-news-sidebar-status">
					<span className={connected ? "owl-news-status-dot" : "owl-news-status-dot is-offline"} />
					{connected ? t("composer.connected") : t("news.disconnected")}
					{snapshot && (
						<>
							<p>
								{t("news.sourceCount", { n: snapshot.status.sourceCount })} ·{" "}
								{t("news.pendingCount", { n: snapshot.status.pendingCount })}
							</p>
							<p>{snapshot.status.collectEnabled ? t("news.collectOn") : t("news.collectOff")}</p>
						</>
					)}
				</div>
			</nav>
			<div className="owl-news-frame">
				<header className="owl-news-topbar">
					<div>
						<span>{t("news.titleName")}</span>
						<span>/</span>
						<strong>{title}</strong>
					</div>
					<div>
						<button type="button" onClick={refreshed} disabled={loading}>
							{t("common.refresh")}
						</button>
						<button
							type="button"
							aria-expanded={assistantOpen}
							className={assistantOpen ? "is-active" : ""}
							onClick={() => setAssistantOpen(!assistantOpen)}
						>
							{t("news.ask")}
						</button>
					</div>
				</header>
				<div className={`owl-news-workspace${assistantOpen ? " has-assistant" : ""}`}>
					<main className="owl-news-content" ref={contentRef}>
						{!connected && (
							<p className="owl-news-error" aria-live="polite">
								{t("news.disconnected")}
							</p>
						)}
						{error && (
							<p className="owl-news-error" role="alert">
								{error}
								<button type="button" onClick={refreshed}>
									{t("news.retry")}
								</button>
							</p>
						)}
						{loading && !snapshot ? (
							<div className="owl-news-empty" aria-live="polite">
								{t("news.loading")}
							</div>
						) : target ? (
							<>
								<button type="button" className="owl-news-back" onClick={() => setTarget(undefined)}>
									← {t("news.back")}
								</button>
								{target.kind === "item" ? (
									<NewsItemReader
										key={`${target.management ? "admin" : "public"}-${target.id}`}
										id={target.id}
										management={target.management}
										{...reading}
									/>
								) : target.kind === "story" ? (
									<NewsStoryReader key={target.id} id={target.id} {...reading} />
								) : (
									<NewsReportReader
										key={`${target.kind}-${target.key}`}
										kind={target.kind}
										initialKey={target.key}
										{...reading}
									/>
								)}
							</>
						) : (
							<>
								{(section === "selected" || section === "all" || section === "saved") && (
									<>
										<div className="owl-news-heading">
											<div>
												<div className="owl-news-eyebrow">
													{section === "selected" ? "OWL NEWS / FOR YOU" : "OWL NEWS"}
												</div>
												<h1>{section === "selected" ? t("news.todayHeadline") : title}</h1>
												<p>{t(section === "saved" ? "news.savedHint" : section === "selected" ? "news.todayFeedHint" : "news.feedHint")}</p>
											</div>
											<span className="owl-news-muted">
												{snapshot?.status.lastUpdatedAt
													? new Date(snapshot.status.lastUpdatedAt).toLocaleDateString()
													: section === "selected"
														? new Date().toLocaleDateString()
														: ""}
											</span>
										</div>
										<form
											className="owl-news-search"
											onSubmit={(event) => {
												event.preventDefault();
												setQuery(queryInput.trim());
											}}
										>
											<IconSearch />
											<input
												aria-label={t("news.search")}
												value={queryInput}
												onChange={(event) => setQueryInput(event.target.value)}
												placeholder={t("news.searchPlaceholder")}
											/>
											<button type="submit">{t("news.search")}</button>
											{query && (
												<button
													type="button"
													onClick={() => {
														setQuery("");
														setQueryInput("");
													}}
												>
													{t("common.clear")}
												</button>
											)}
										</form>
										<div className="owl-news-filters">
											<button
												type="button"
												className={!category ? "is-active" : ""}
												onClick={() => setCategory("")}
											>
												{t("news.allCategories")}
											</button>
											{snapshot?.categories.map((entry) => (
												<button
													type="button"
													className={category === entry.id ? "is-active" : ""}
													key={entry.id}
													onClick={() => setCategory(entry.id)}
												>
													{entry.label}
												</button>
											))}
										</div>
										{section === "selected" && !query && (
											<NewsHotStrip api={api} revision={revision} onStory={reading.onStory} />
										)}
										<NewsFeed
											api={api}
											revision={revision}
											query={{ mode: section, query, category, ...(topic ? { topic } : {}) }}
											categories={snapshot?.categories}
											context={context}
											onItem={openItem}
											onToggleContext={toggleContext}
											onDiscuss={discuss}
											onChanged={refreshed}
											onSetupSources={() => selectSection("sources")}
											onSetupModels={() => selectSection("configuration")}
										/>
									</>
								)}
								{section === "hot" && <NewsHotView api={api} revision={revision} onStory={reading.onStory} />}
								{(section === "daily" || section === "weekly" || section === "monthly") && (
									<NewsReportReader key={section} kind={section} {...reading} />
								)}
								{section === "topics" && (
									<NewsTopics
										api={api}
										revision={revision}
										topic={topic}
										categories={snapshot?.categories}
										onTopic={setTopic}
										context={context}
										onItem={openItem}
										onToggleContext={toggleContext}
										onDiscuss={discuss}
										onChanged={refreshed}
									/>
								)}
								{section === "sources" && <NewsSources api={api} revision={revision} onChanged={refreshed} />}
								{section === "content" && (
									<NewsContentManagement
										api={api}
										revision={revision}
										snapshot={snapshot}
										onChanged={refreshed}
										onItem={(id) => setTarget({ kind: "item", id, management: true })}
									/>
								)}
								{snapshot &&
									(section === "configuration" ||
										section === "operations" ||
										section === "evaluation" ||
										section === "exports") && (
											<NewsManagement
											key={section}
											section={section}
											api={api}
											revision={revision}
											snapshot={snapshot}
												onChanged={refreshed}
												onOpenModelSettings={onOpenModelSettings}
										/>
									)}
								{!snapshot && !loading && (
									<div className="owl-news-empty">
										<h2>{t("news.unavailable")}</h2>
										<button type="button" onClick={refreshed}>
											{t("news.retry")}
										</button>
									</div>
								)}
							</>
						)}
						{context.items.length > 0 && !target && (
							<div className="owl-news-comparison">
								<span>{t("news.selectedForContext", { n: context.items.length })}</span>
								<div>
									<button
										type="button"
										disabled={context.items.length !== 2}
										onClick={() => {
											setAssistantOpen(true);
											setPrefill({ id: ++prefillSeq.current, text: t("news.comparePrompt") });
										}}
									>
										{t("news.compareTwo")}
									</button>
									<button
										type="button"
										onClick={() => {
											setAssistantOpen(true);
										}}
									>
										{t("news.ask")}
									</button>
									<button type="button" onClick={() => setContext({ items: [] })}>
										{t("common.clear")}
									</button>
								</div>
							</div>
						)}
					</main>
					{/* Keep the discussion and composer mounted when hidden or when another primary view is active. */}
					<div className="owl-news-assistant-container" style={{ display: assistantOpen ? undefined : "none" }}>
						<NewsAssistant
							api={api}
							context={context}
							onContext={setContext}
							onClose={() => setAssistantOpen(false)}
							onItem={openItem}
							onToChat={onToChat}
							onConfigureSources={() => selectSection("sources")}
							onConfigureModels={() => selectSection("configuration")}
							onOpenModelSettings={onOpenModelSettings}
							snapshot={snapshot}
							connected={connected}
							prefill={prefill}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

interface FeedProps {
	api: NewsClient;
	revision: number;
	categories?: NewsSnapshot["categories"];
	context: NewsContext;
	onItem: (id: string) => void;
	onToggleContext: (item: NewsItem) => void;
	onDiscuss: (context: NewsContext) => void;
	onChanged: () => void;
	onSetupSources?: () => void;
	onSetupModels?: () => void;
}
function NewsFeed({ query, ...props }: FeedProps & { query: NewsListQuery }): React.JSX.Element {
	const t = useT();
	const [offset, setOffset] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState<string>();
	const queryKey = JSON.stringify(query);
	useEffect(() => setOffset(0), [queryKey]);
	const result = useNewsQuery(props.api, { action: "list", query: { ...query, offset, limit: 20 } }, props.revision);
	async function bookmark(item: NewsItem): Promise<void> {
		setBusy(item.id);
		setError("");
		try {
			await props.api.query({ action: "bookmark", id: item.id, saved: !item.saved });
			props.onChanged();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(undefined);
		}
	}
	return (
		<div>
			{error && (
				<p className="owl-news-error" role="alert">
					{error}
				</p>
			)}
			{result.error && (
				<p className="owl-news-error" role="alert">
					{result.error}
				</p>
			)}
			{result.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{result.data && (
				<div className="owl-news-small-row">
					<span>{t("news.itemTotal", { n: result.data.total })}</span>
					<span>{t("news.sourceTraceable")}</span>
				</div>
			)}
			{result.data?.items.length === 0 && (
				<div className={`owl-news-empty${query.mode === "selected" && !query.query && !query.category && !query.topic ? " owl-news-first-run" : ""}`}>
					<div>
						{query.mode === "selected" && !query.query && !query.category && !query.topic ? (
							<>
								<div className="owl-news-eyebrow">AIHOT · OWL NEWS</div>
								<h2>{t("news.firstRunTitle")}</h2>
								<p>{t("news.firstRunHint")}</p>
							</>
						) : (
							<>
								<h2>{t("news.noItems")}</h2>
								<p>{t("news.noItemsHint")}</p>
							</>
						)}
					</div>
					{query.mode === "selected" && !query.query && !query.category && !query.topic && (
						<div className="owl-news-first-run-actions">
							<button type="button" className="owl-news-primary" onClick={props.onSetupSources}>
								{t("news.setupSources")}
							</button>
							<button type="button" onClick={props.onSetupModels}>
								{t("news.setupModels")}
							</button>
						</div>
					)}
				</div>
			)}
			<div className="owl-news-feed">
				{result.data?.items.map((item) => (
					<article
						className={`owl-news-card${props.context.items.some((entry) => entry.id === item.id) ? " is-context" : ""}${item.read ? " is-read" : ""}`}
						key={item.id}
					>
						<div className="owl-news-meta">
							<span className="owl-news-source-letter">{item.sourceName.slice(0, 1)}</span>
							<span>{item.sourceName}</span>
							<time>{new Date(item.publishedAt).toLocaleString()}</time>
							{props.categories?.find((category) => category.id === item.category)?.label && (
								<span>{props.categories.find((category) => category.id === item.category)?.label}</span>
							)}
							{item.selected && <span className="owl-news-accent">{t("news.selected")}</span>}
							{item.status !== "ready" && <span>{t(`news.status.${item.status}`)}</span>}
						</div>
						<button type="button" className="owl-news-title-link" onClick={() => props.onItem(item.id)}>
							{item.title || item.originalTitle}
						</button>
						<p className="owl-news-card-summary">{item.summary || t("news.processingSummary")}</p>
						<div className="owl-news-card-footer">
							<div className="owl-news-tags">
								{item.tags.slice(0, 3).map((tag) => (
									<span key={tag}>#{tag}</span>
								))}
							</div>
							<div className="owl-news-card-actions">
								<button type="button" disabled={busy === item.id} onClick={() => void bookmark(item)}>
									{item.saved ? t("news.unsave") : t("news.save")}
								</button>
								<button
									type="button"
									className={props.context.items.some((entry) => entry.id === item.id) ? "is-active" : ""}
									onClick={() => props.onToggleContext(item)}
								>
									{props.context.items.some((entry) => entry.id === item.id)
										? t("news.removeContext")
										: t("news.addContext")}
								</button>
								<button type="button" onClick={() => props.onDiscuss({ items: [item] })}>
									{t("news.ask")}
								</button>
							</div>
						</div>
					</article>
				))}
			</div>
			{result.data && result.data.total > 20 && (
				<div className="owl-news-pagination">
					<button
						type="button"
						disabled={offset === 0 || result.loading}
						onClick={() => setOffset(Math.max(0, offset - 20))}
					>
						{t("news.previousPage")}
					</button>
					<span>
						{Math.floor(offset / 20) + 1} / {Math.ceil(result.data.total / 20)}
					</span>
					<button
						type="button"
						disabled={offset + 20 >= result.data.total || result.loading}
						onClick={() => setOffset(offset + 20)}
					>
						{t("news.nextPage")}
					</button>
				</div>
			)}
		</div>
	);
}

function NewsHotStrip({
	api,
	revision,
	onStory,
}: {
	api: NewsClient;
	revision: number;
	onStory: (id: string) => void;
}): React.JSX.Element | null {
	const t = useT();
	const result = useNewsQuery(api, { action: "hot", limit: 3 }, revision);
	if (!result.data?.length) return null;
	return (
		<section className="owl-news-hot-strip">
			<h2>{t("news.todayHot")}</h2>
			{result.data.map((event, index) => (
				<button type="button" key={event.story.id} onClick={() => onStory(event.story.id)}>
					<span className="owl-news-rank">{String(index + 1).padStart(2, "0")}</span>
					<span>{event.story.title}</span>
					<small>{t("news.sourceCount", { n: event.story.sourceCount })}</small>
				</button>
			))}
		</section>
	);
}

function NewsHotView({
	api,
	revision,
	onStory,
}: {
	api: NewsClient;
	revision: number;
	onStory: (id: string) => void;
}): React.JSX.Element {
	const t = useT();
	const result = useNewsQuery(api, { action: "hot", limit: 10 }, revision);
	return (
		<section>
			<div className="owl-news-heading">
				<div>
					<div className="owl-news-eyebrow">OWL NEWS</div>
					<h1>{t("news.hot")}</h1>
					<p>{t("news.hotHint")}</p>
				</div>
			</div>
			{result.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{result.error && (
				<p role="alert" className="owl-news-error">
					{result.error}
				</p>
			)}
			{result.data?.length === 0 && <div className="owl-news-empty">{t("news.noHot")}</div>}
			{result.data?.map((event, index) => (
				<article className="owl-news-hot-event" key={event.story.id}>
					<span className="owl-news-rank">{String(index + 1).padStart(2, "0")}</span>
					<div>
						<button type="button" className="owl-news-title-link" onClick={() => onStory(event.story.id)}>
							{event.story.title}
						</button>
						<p>{event.story.summary}</p>
						<div className="owl-news-meta">
							<span>{t("news.sourceCount", { n: event.story.sourceCount })}</span>
							<span>{t("news.reportCount", { n: event.story.reports.length })}</span>
							<span className="owl-news-accent">{t(`news.trend.${event.trend}`)}</span>
							<span>
								{t("news.heat")} {event.heat.toFixed(1)}
							</span>
							{event.change !== null && (
								<span>
									{event.change > 0 ? "+" : ""}
									{(event.change * 100).toFixed(0)}%
								</span>
							)}
						</div>
					</div>
				</article>
			))}
		</section>
	);
}

function NewsTopics({
	topic,
	onTopic,
	...props
}: FeedProps & { topic: string; onTopic: (id: string) => void }): React.JSX.Element {
	const t = useT();
	const result = useNewsQuery(props.api, { action: "topics" }, props.revision);
	return (
		<section>
			<div className="owl-news-heading">
				<div>
					<h1>{t("news.topics")}</h1>
					<p>{t("news.topicsHint")}</p>
				</div>
			</div>
			{result.error && (
				<p className="owl-news-error" role="alert">
					{result.error}
				</p>
			)}
			{result.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{result.data?.length === 0 && <p className="owl-news-empty">{t("news.noTopics")}</p>}
			<div className="owl-news-topic-grid">
				{result.data?.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className={topic === entry.id ? "is-active" : ""}
						onClick={() => onTopic(entry.id)}
					>
						<span>{entry.name}</span>
						<small>{entry.count}</small>
					</button>
				))}
			</div>
			{topic && <NewsFeed {...props} query={{ mode: "all", topic }} />}
		</section>
	);
}
