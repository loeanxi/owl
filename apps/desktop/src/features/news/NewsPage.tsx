import { useEffect, useMemo, useRef, useState } from "react";
import type {
	NewsItem,
	NewsListQuery,
	NewsReaderStatus,
	NewsReportKind,
	NewsSnapshot,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { IconSearch } from "../../components/icons.tsx";
import { getUiLanguage, type TextKey, useT } from "../../i18n/index.ts";
import { newsEmptyCopy } from "./empty-copy.ts";
import { NewsAssistant, type NewsContext } from "./NewsAssistant.tsx";
import { NewsLeaderboard } from "./NewsLeaderboard.tsx";
import { NewsManagement } from "./NewsManagement.tsx";
import { NewsItemReader, NewsReportReader, NewsStoryReader, type NewsTarget } from "./NewsReading.tsx";
import { NewsSources } from "./NewsSources.tsx";
import { errorText, NewsClient } from "./news-client.ts";
import { NewsQueryActivity, useNewsQuery } from "./use-news-query.ts";
import "./news.css";

type NewsSection = "selected" | "all" | "leaderboard" | NewsReportKind | "saved" | "sources" | "configuration";
const SECTIONS: { id: NewsSection; key?: TextKey }[] = [
	{ id: "all" },
	{ id: "selected", key: "news.selected" },
	{ id: "leaderboard" },
	{ id: "daily", key: "news.daily" },
	{ id: "saved", key: "news.saved" },
];
const MANAGEMENT: { id: NewsSection; key: TextKey }[] = [
	{ id: "sources", key: "news.sources" },
	{ id: "configuration", key: "news.configuration" },
];

function contentVersion(snapshot: NewsSnapshot): string {
	const status = snapshot.status;
	return JSON.stringify([
		status.itemCount,
		status.selectedCount,
		status.storyCount,
		status.reportCount,
		status.pendingCount,
		status.failedCount,
		status.lastUpdatedAt,
	]);
}

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
	const language = getUiLanguage();
	const emptyCopy = newsEmptyCopy[language];
	const copy =
		language === "zh"
			? {
					latest: "最新资讯",
					leaderboard: "模型排行榜",
					readingSettings: "阅读设置",
					sources: "信源订阅",
					advanced: "AI 与高级设置",
					updateRanking: "更新榜单",
					checking: "正在获取更新",
					automatic: "公开资讯，打开即读",
					updated: "上次同步",
					nextCheck: "下次自动检查",
					enabledSources: "个已启用信源",
					sourcesLabel: "个信源",
					sourceFailures: "个信源暂不可用",
					leaderboardHint: "公开测评数据 · 自动更新 · 无需 API Key",
				}
			: {
					latest: "Latest news",
					leaderboard: "Model rankings",
					readingSettings: "Reading settings",
					sources: "Source subscriptions",
					advanced: "AI & advanced",
					updateRanking: "Update rankings",
					checking: "Checking for updates",
					automatic: "Public news, ready to read",
					updated: "Last synced",
					nextCheck: "Next automatic check",
					enabledSources: "enabled sources",
					sourcesLabel: "sources",
					sourceFailures: "sources unavailable",
					leaderboardHint: "Public benchmark data · Automatic updates · No API key",
				};
	const api = useMemo(() => new NewsClient(client), [client]);
	const [snapshot, setSnapshot] = useState<NewsSnapshot>();
	const [section, setSection] = useState<NewsSection>("all");
	const [target, setTarget] = useState<NewsTarget>();
	const [revision, setRevision] = useState(0);
	const [leaderboardRevision, setLeaderboardRevision] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [snapshotError, setSnapshotError] = useState("");
	const [connected, setConnected] = useState(true);
	const [category, setCategory] = useState("");
	const [query, setQuery] = useState("");
	const [queryInput, setQueryInput] = useState("");
	const [context, setContext] = useState<NewsContext>({ items: [] });
	const [assistantOpen, setAssistantOpen] = useState(false);
	const [managementOpen, setManagementOpen] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [readerRefreshing, setReaderRefreshing] = useState(false);
	const [sourceStatus, setSourceStatus] = useState<NewsReaderStatus>();
	const updateInFlight = useRef(false);
	const [prefill, setPrefill] = useState<{ id: number; text: string }>();
	const prefillSeq = useRef(0);
	const lastStatus = useRef("");
	const lastReaderStatus = useRef("");
	const snapshotRevision = useRef(0);
	const contentRef = useRef<HTMLElement>(null);
	const refreshed = (): void => setRevision((current) => current + 1);
	const savedList = useNewsQuery(
		api,
		{ action: "list", query: { mode: "saved", limit: 1 } },
		revision,
		active && connected,
	);
	const [savedTotal, setSavedTotal] = useState(0);
	useEffect(() => {
		if (savedList.data) setSavedTotal(savedList.data.total);
	}, [savedList.data]);
	const isUpdating = updating || readerRefreshing;
	const readingStatus = snapshot?.status.reader ?? sourceStatus;
	async function updateNews(force: boolean): Promise<void> {
		if (updateInFlight.current) return;
		updateInFlight.current = true;
		setUpdating(true);
		setError("");
		setSnapshotError("");
		try {
			const result = await api.ready(force);
			setSourceStatus(result);
			setReaderRefreshing(result.refreshing);
			if (force) refreshed();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			updateInFlight.current = false;
			setUpdating(false);
		}
	}
	useEffect(() => {
		if (!active || !connected) return;
		void updateNews(false);
	}, [api, active, connected]);
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
		if (!active || !connected) return;
		let current = true;
		const serial = ++snapshotRevision.current;
		setLoading(!snapshot);
		setSnapshotError("");
		void api
			.query({ action: "snapshot" })
			.then(
				(value) => {
					if (!current || serial !== snapshotRevision.current) return;
					setSnapshot(value);
					setReaderRefreshing(value.status.reader?.refreshing ?? false);
					lastStatus.current = contentVersion(value);
					lastReaderStatus.current = JSON.stringify(value.status.reader);
				},
				(failure: unknown) => {
					if (current) setSnapshotError(errorText(failure));
				},
			)
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [api, revision, active, connected]);
	useEffect(() => {
		if (!active || !connected) return;
		let current = true;
		let inFlight = false;
		const timer = setInterval(
			() => {
				if (inFlight) return;
				inFlight = true;
				const serial = snapshotRevision.current;
				void api
					.query({ action: "snapshot" })
					.then(
						(value) => {
							if (!current || serial !== snapshotRevision.current) return;
							setSnapshot(value);
							setSnapshotError("");
							setReaderRefreshing(value.status.reader?.refreshing ?? false);
							const status = contentVersion(value);
							const readerStatus = JSON.stringify(value.status.reader);
							if (
								lastStatus.current !== status ||
								(section === "sources" && lastReaderStatus.current !== readerStatus)
							) {
								lastStatus.current = status;
								refreshed();
							}
							lastReaderStatus.current = readerStatus;
						},
						(failure: unknown) => {
							if (current) setSnapshotError(errorText(failure));
						},
					)
					.finally(() => {
						inFlight = false;
					});
			},
			readerRefreshing ? 2_000 : 30_000,
		);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [api, active, connected, readerRefreshing, section]);
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
		if (MANAGEMENT.some((entry) => entry.id === next)) setManagementOpen(true);
		contentRef.current?.scrollTo({ top: 0 });
	}
	function viewLatestNews(): void {
		setQuery("");
		setQueryInput("");
		setCategory("");
		selectSection("all");
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
	const sectionTitle =
		section === "all"
			? copy.latest
			: section === "leaderboard"
				? copy.leaderboard
				: section === "sources"
					? copy.sources
					: section === "configuration"
						? copy.advanced
						: t(`news.${section}`);
	return (
		<NewsQueryActivity.Provider value={active && connected}>
			<div className="owl-news-module">
				<nav
					className="owl-news-sidebar"
					id="owl-news-sidebar"
					style={{ display: sidebarCollapsed ? "none" : undefined }}
					aria-label={t("news.navigation")}
				>
					{SECTIONS.map((entry) => (
						<button
							type="button"
							key={entry.id}
							className={section === entry.id ? "is-active" : ""}
							aria-current={section === entry.id ? "page" : undefined}
							onClick={() => selectSection(entry.id)}
						>
							<span>{entry.key ? t(entry.key) : entry.id === "all" ? copy.latest : copy.leaderboard}</span>
							{entry.id === "selected" && snapshot && <small>{snapshot.status.selectedCount}</small>}
							{entry.id === "saved" && savedTotal > 0 && <small>{savedTotal}</small>}
						</button>
					))}
					<hr className="owl-news-nav-divider" />
					<details
						className="owl-news-nav-settings"
						open={managementOpen}
						onToggle={(event) => setManagementOpen(event.currentTarget.open)}
					>
						<summary>{copy.readingSettings}</summary>
						{MANAGEMENT.map((entry) => (
							<button
								type="button"
								key={entry.id}
								className={section === entry.id ? "is-active" : ""}
								aria-current={section === entry.id ? "page" : undefined}
								onClick={() => selectSection(entry.id)}
							>
								{entry.id === "sources" ? copy.sources : copy.advanced}
							</button>
						))}
					</details>
				</nav>
				<div className="owl-news-frame">
					<header className="owl-news-topbar">
						<div className="owl-news-topbar-heading">
							<h1>{sectionTitle}</h1>
							<p aria-live="polite">
								{section === "leaderboard" ? (
									copy.leaderboardHint
								) : (
									<>
										{readingStatus
											? `${readingStatus.enabledSourceCount} ${copy.enabledSources}`
											: snapshot
												? `${snapshot.status.sourceCount} ${copy.sourcesLabel}`
												: copy.automatic}
										{isUpdating
											? ` · ${copy.checking}`
											: readingStatus?.lastUpdatedAt
												? ` · ${copy.updated} ${new Date(readingStatus.lastUpdatedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
												: ""}
										{!isUpdating &&
											readingStatus?.nextRefreshAt &&
											` · ${copy.nextCheck} ${new Date(readingStatus.nextRefreshAt).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}`}
										{!!readingStatus?.failedSourceCount &&
											` · ${readingStatus.failedSourceCount} ${copy.sourceFailures}`}
									</>
								)}
							</p>
						</div>
						<div className="owl-news-topbar-actions">
							<button
								type="button"
								onClick={() =>
									section === "leaderboard"
										? setLeaderboardRevision((current) => current + 1)
										: void updateNews(true)
								}
								disabled={loading || !connected || (section !== "leaderboard" && isUpdating)}
							>
								{section === "leaderboard"
									? copy.updateRanking
									: isUpdating
										? emptyCopy.updating
										: emptyCopy.update}
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
							{(error || snapshotError) && (
								<p className="owl-news-error" role="alert">
									{error || snapshotError}
									<button type="button" onClick={() => void updateNews(true)} disabled={isUpdating}>
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
											onViewAll={viewLatestNews}
											{...reading}
										/>
									)}
								</>
							) : (
								<>
									{(section === "selected" || section === "all" || section === "saved") && (
										<div className="owl-news-feed-view">
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
												onViewAll={viewLatestNews}
												onUpdate={() => void updateNews(true)}
												updating={isUpdating}
												onClearFilters={() => {
													setQuery("");
													setQueryInput("");
													setCategory("");
												}}
											/>
										</div>
									)}
									{section === "leaderboard" && (
										<NewsLeaderboard api={api} active={active && connected} revision={leaderboardRevision} />
									)}
									{(section === "daily" || section === "weekly" || section === "monthly") && (
										<NewsReportReader key={section} kind={section} onViewAll={viewLatestNews} {...reading} />
									)}
									{section === "sources" && (
										<NewsSources api={api} revision={revision} onChanged={refreshed} />
									)}
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
											<button type="button" onClick={() => void updateNews(true)} disabled={isUpdating}>
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
		</NewsQueryActivity.Provider>
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
	onViewAll: () => void;
	onUpdate: () => void;
	updating: boolean;
	onClearFilters: () => void;
}
function NewsFeed({ query, ...props }: FeedProps & { query: NewsListQuery }): React.JSX.Element {
	const t = useT();
	const emptyCopy = newsEmptyCopy[getUiLanguage()];
	const isUnfilteredSelected = query.mode === "selected" && !query.query && !query.category && !query.topic;
	const hasFilters = !!query.query || !!query.category || !!query.topic;
	const hasCollectedNews = (props.itemCount ?? 0) > 0;
	const [page, setPage] = useState({ key: "", offset: 0 });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState<string>();
	const queryKey = JSON.stringify(query);
	const offset = page.key === queryKey ? page.offset : 0;
	const setOffset = (next: number): void => setPage({ key: queryKey, offset: next });
	const result = useNewsQuery(props.api, { action: "list", query: { ...query, offset, limit: 20 } }, props.revision);
	useEffect(() => {
		if (result.data && offset > 0 && offset >= result.data.total)
			setOffset(Math.max(0, Math.floor((result.data.total - 1) / 20) * 20));
	}, [result.data, offset, queryKey]);
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
					<button type="button" onClick={props.onChanged}>
						{t("news.retry")}
					</button>
				</p>
			)}
			{result.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{!result.loading && result.data?.items.length === 0 && (
				<div className="owl-news-empty owl-news-first-run">
					<div>
						{hasFilters ? (
							<>
								<h2>{emptyCopy.filteredTitle}</h2>
								<p>{emptyCopy.filteredHint}</p>
							</>
						) : query.mode === "saved" ? (
							<>
								<h2>{emptyCopy.savedTitle}</h2>
								<p>{emptyCopy.savedHint}</p>
							</>
						) : (
							<>
								<h2>
									{isUnfilteredSelected && hasCollectedNews ? emptyCopy.collectedTitle : emptyCopy.emptyTitle}
								</h2>
								<p>
									{isUnfilteredSelected && hasCollectedNews ? emptyCopy.collectedHint : emptyCopy.emptyHint}
								</p>
							</>
						)}
					</div>
					<div className="owl-news-first-run-actions">
						{hasFilters ? (
							<button type="button" className="owl-news-primary" onClick={props.onClearFilters}>
								{emptyCopy.clearFilters}
							</button>
						) : query.mode === "saved" || (isUnfilteredSelected && hasCollectedNews) ? (
							<button type="button" className="owl-news-primary" onClick={props.onViewAll}>
								{emptyCopy.viewAll}
							</button>
						) : (
							<button
								type="button"
								className="owl-news-primary"
								onClick={props.onUpdate}
								disabled={props.updating}
							>
								{props.updating ? emptyCopy.updating : emptyCopy.update}
							</button>
						)}
					</div>
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
							<time dateTime={item.publishedAt}>
								{new Date(item.publishedAt).toLocaleString(getUiLanguage() === "zh" ? "zh-CN" : "en-US", {
									month: "short",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
								})}
							</time>
							{props.categories?.find((category) => category.id === item.category)?.label && (
								<span>{props.categories.find((category) => category.id === item.category)?.label}</span>
							)}
							{item.selected && <span className="owl-news-accent">{t("news.selected")}</span>}
							{item.contentOrigin === "source" && (
								<span>{getUiLanguage() === "zh" ? "原文摘录" : "Source excerpt"}</span>
							)}
							{item.status !== "ready" && <span>{t(`news.status.${item.status}`)}</span>}
						</div>
						<button type="button" className="owl-news-title-link" onClick={() => props.onItem(item.id)}>
							{item.title || item.originalTitle}
						</button>
						<p className="owl-news-card-summary">
							{item.summary ||
								(item.contentOrigin === "source"
									? getUiLanguage() === "zh"
										? "来源未提供摘要，可打开资讯查看原文。"
										: "The source did not include an excerpt. Open the article to read the original."
									: t("news.processingSummary"))}
						</p>
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
