import { useEffect, useMemo, useRef, useState } from "react";
import type {
	NewsItem,
	NewsListQuery,
	NewsReportKind,
	NewsSnapshot,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { IconSearch } from "../../components/icons.tsx";
import { getUiLanguage, type TextKey, useT } from "../../i18n/index.ts";
import { NewsAssistant, type NewsContext } from "./NewsAssistant.tsx";
import { NewsManagement } from "./NewsManagement.tsx";
import { NewsItemReader, NewsReportReader, NewsStoryReader, type NewsTarget } from "./NewsReading.tsx";
import { NewsSources } from "./NewsSources.tsx";
import { newsEmptyCopy } from "./empty-copy.ts";
import { errorText, NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";
import "./news.css";

type NewsSection = "selected" | "all" | NewsReportKind | "saved" | "sources" | "configuration";
const SECTIONS: { id: NewsSection; key: TextKey }[] = [
	{ id: "selected", key: "news.selected" },
	{ id: "all", key: "news.all" },
	{ id: "daily", key: "news.daily" },
	{ id: "saved", key: "news.saved" },
];
const MANAGEMENT: { id: NewsSection; key: TextKey }[] = [
	{ id: "sources", key: "news.sources" },
	{ id: "configuration", key: "news.configuration" },
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
	const savedList = useNewsQuery(api, { action: "list", query: { mode: "saved", limit: 1 } }, revision);
	const [savedTotal, setSavedTotal] = useState(0);
	useEffect(() => {
		if (savedList.data) setSavedTotal(savedList.data.total);
	}, [savedList.data]);
	const isEmptySection = (id: NewsSection): boolean =>
		id !== section &&
		((id === "saved" && savedTotal === 0) || (id === "daily" && !!snapshot && snapshot.status.reportCount === 0));
	const feedMode = section === "all" || section === "saved" ? section : "selected";
	const categoryCounts = useCategoryCounts(api, feedMode, snapshot?.categories, revision);
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
	return (
		<div className="owl-news-module">
			<nav
				className="owl-news-sidebar"
				id="owl-news-sidebar"
				style={{ display: sidebarCollapsed ? "none" : undefined }}
				aria-label={t("news.navigation")}
			>
				{SECTIONS.filter((entry) => !isEmptySection(entry.id)).map((entry) => (
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
				<hr className="owl-news-nav-divider" />
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
			</nav>
			<div className="owl-news-frame">
				<header className="owl-news-topbar">
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
											{snapshot?.categories
												.filter((entry) => entry.id === category || categoryCounts?.[entry.id] !== 0)
												.map((entry) => (
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
										<NewsFeed
											api={api}
											revision={revision}
											query={{ mode: section, query, category }}
											categories={snapshot?.categories}
											context={context}
											onItem={openItem}
											onToggleContext={toggleContext}
											onDiscuss={discuss}
											onChanged={refreshed}
											itemCount={snapshot?.status.itemCount}
											onViewAll={() => selectSection("all")}
											onSetupSources={() => selectSection("sources")}
											onSetupModels={() => selectSection("configuration")}
										/>
									</>
								)}
								{(section === "daily" || section === "weekly" || section === "monthly") && (
									<NewsReportReader key={section} kind={section} {...reading} />
								)}
								{section === "sources" && <NewsSources api={api} revision={revision} onChanged={refreshed} />}
								{snapshot && section === "configuration" && (
									<NewsManagement
										section="configuration"
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
	itemCount?: number;
	onViewAll?: () => void;
	onSetupSources?: () => void;
	onSetupModels?: () => void;
}
function NewsFeed({ query, ...props }: FeedProps & { query: NewsListQuery }): React.JSX.Element {
	const t = useT();
	const emptyCopy = newsEmptyCopy[getUiLanguage()];
	const isUnfilteredSelected = query.mode === "selected" && !query.query && !query.category && !query.topic;
	const hasCollectedNews = (props.itemCount ?? 0) > 0;
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
			{result.data?.items.length === 0 && (
				<div className={`owl-news-empty${isUnfilteredSelected ? " owl-news-first-run" : ""}`}>
					<div>
						{isUnfilteredSelected ? (
							<>
								<div className="owl-news-eyebrow">AIHOT · OWL NEWS</div>
								<h2>{hasCollectedNews ? emptyCopy.collectedTitle : t("news.firstRunTitle")}</h2>
								<p>{hasCollectedNews ? emptyCopy.collectedHint : t("news.firstRunHint")}</p>
							</>
						) : (
							<>
								<h2>{t("news.noItems")}</h2>
								<p>{t("news.noItemsHint")}</p>
							</>
						)}
					</div>
					{isUnfilteredSelected && (
						<div className="owl-news-first-run-actions">
							{hasCollectedNews ? (
								<button type="button" className="owl-news-primary" onClick={props.onViewAll}>
									{emptyCopy.viewAll}
								</button>
							) : (
								<>
									<button type="button" className="owl-news-primary" onClick={props.onSetupSources}>
										{t("news.setupSources")}
									</button>
									<button type="button" onClick={props.onSetupModels}>
										{t("news.setupModels")}
									</button>
								</>
							)}
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

/** Per-category totals for the current feed mode; undefined until the first load so no chip is hidden prematurely. */
function useCategoryCounts(
	api: NewsClient,
	mode: NonNullable<NewsListQuery["mode"]>,
	categories: NewsSnapshot["categories"] | undefined,
	revision: number,
): Record<string, number> | undefined {
	const [counts, setCounts] = useState<Record<string, number>>();
	const ids = categories?.map((entry) => entry.id).join(",") ?? "";
	useEffect(() => {
		if (!ids) return;
		let current = true;
		void Promise.all(
			ids.split(",").map((id) =>
				api
					.query({ action: "list", query: { mode, category: id, limit: 1 } })
					.then((result) => [id, result.total] as const),
			),
		).then(
			(entries) => {
				if (current) setCounts(Object.fromEntries(entries));
			},
			() => {
				if (current) setCounts(undefined);
			},
		);
		return () => {
			current = false;
		};
	}, [api, mode, ids, revision]);
	return counts;
}
