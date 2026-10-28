import { useEffect, useRef, useState } from "react";
import type {
	NewsFeedDiscovery,
	NewsMaterial,
	NewsParticipation,
	NewsSource,
	NewsSourceInput,
	NewsSourceKind,
	NewsTier,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { getUiLanguage, type TextKey, useT } from "../../i18n/index.ts";
import { useNewsToast } from "./NewsToast.tsx";
import { errorText, type NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";

type Translate = ReturnType<typeof useT>;
const sourceCopy = {
	zh: {
		waiting: "等待首次更新",
		publicUpdate: "更新公开信源",
		publicRequested: "已请求更新公开信源，结果会自动显示",
		nextUpdate: "下次自动更新",
		nextRetry: "将自动重试",
	},
	en: {
		waiting: "Waiting for the first update",
		publicUpdate: "Update public feeds",
		publicRequested: "Public feed update requested; results will appear automatically",
		nextUpdate: "Next automatic update",
		nextRetry: "Automatic retry",
	},
};

/** The interval most sources already use, so a newly added source follows the chosen frequency. */
export function commonInterval(sources: NewsSource[]): number {
	const counts = new Map<number, number>();
	for (const source of sources) counts.set(source.intervalMinutes, (counts.get(source.intervalMinutes) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 60;
}

function timeAgo(iso: string, t: Translate): string {
	const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return t("news.justNow");
	if (minutes < 60) return t("news.minutesAgo", { n: minutes });
	if (minutes < 1440) return t("news.hoursAgo", { n: Math.floor(minutes / 60) });
	return t("news.daysAgo", { n: Math.floor(minutes / 1440) });
}

function diagnose(error: string, t: Translate): { text: string; help?: string } {
	if (error.includes("SOCIALDATA_API_KEY"))
		return { text: t("news.errNeedKey", { key: t("news.keyX") }), help: t("news.errNeedKeyHelp") };
	if (error.includes("DAJIALA_KEY"))
		return { text: t("news.errNeedKey", { key: t("news.keyMp") }), help: t("news.errNeedKeyHelp") };
	const status = Number(/HTTP (\d{3})/.exec(error)?.[1]);
	if (status === 401 || status === 403) return { text: t("news.errBlocked"), help: t("news.errBlockedHelp") };
	if (status === 404 || status === 410) return { text: t("news.errGone"), help: t("news.errGoneHelp") };
	if (status === 429) return { text: t("news.errRateLimited"), help: t("news.errTransientHelp") };
	if (status >= 500) return { text: t("news.errServer"), help: t("news.errTransientHelp") };
	if (error.includes("不是 RSS/Atom")) return { text: t("news.errNotFeed"), help: t("news.errGoneHelp") };
	if (/abort|timeout|timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(error))
		return { text: t("news.errNetwork"), help: t("news.errTransientHelp") };
	return { text: error };
}

function explainError(error: string, t: Translate): string {
	return diagnose(error, t).text;
}

function sourceStatus(source: NewsSource, t: Translate): string {
	if (!source.enabled) return t("news.sourceOff");
	const health = source.reader ?? source;
	if (health.lastError) return explainError(health.lastError, t);
	return health.lastCollectedAt
		? t("news.collectedAgo", { time: timeAgo(health.lastCollectedAt, t) })
		: t("news.neverCollected");
}

function SourceNote({ source }: { source: NewsSource }): React.JSX.Element {
	const t = useT();
	const language = getUiLanguage();
	const copy = sourceCopy[language];
	const health = source.reader ?? source;
	const help = health.lastError ? diagnose(health.lastError, t).help : undefined;
	const { feedUrl, url, query, ghid, wxid } = source.config;
	const nextUpdate = source.enabled ? source.reader?.nextCollectedAt : undefined;
	return (
		<p>
			{help}
			{help && <br />}
			<span>{health.lastError ?? String(feedUrl ?? url ?? query ?? ghid ?? wxid ?? "")}</span>
			{nextUpdate && Number.isFinite(Date.parse(nextUpdate)) && (
				<>
					<br />
					<span>
						{health.lastError ? copy.nextRetry : copy.nextUpdate} ·{" "}
						{new Date(nextUpdate).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}
					</span>
				</>
			)}
		</p>
	);
}

const KINDS: { id: NewsSourceKind; label: TextKey }[] = [
	{ id: "rss", label: "news.kindRss" },
	{ id: "web_list", label: "news.kindWeb" },
	{ id: "json_list", label: "news.kindJson" },
	{ id: "x_search", label: "news.kindX" },
	{ id: "mp_account", label: "news.kindMp" },
	{ id: "external", label: "news.kindExternal" },
];
interface ConfigField {
	key: string;
	label: TextKey;
	type?: "list" | "json" | "boolean";
}
const FIELDS: Record<NewsSourceKind, ConfigField[]> = {
	rss: [
		{ key: "feedUrl", label: "news.feedUrl" },
		{ key: "summaryIsBody", label: "news.summaryIsBody", type: "boolean" },
	],
	web_list: [
		{ key: "url", label: "news.url" },
		{ key: "itemSelector", label: "news.itemSelector" },
		{ key: "linkSelector", label: "news.linkSelector" },
		{ key: "titleSelector", label: "news.titleSelector" },
		{ key: "publishedAtSelector", label: "news.dateSelector" },
		{ key: "bodySelector", label: "news.bodySelector" },
		{ key: "allowUrlPrefixes", label: "news.allowPrefixes", type: "list" },
		{ key: "denyUrlPrefixes", label: "news.denyPrefixes", type: "list" },
	],
	json_list: [
		{ key: "url", label: "news.url" },
		{ key: "itemsPath", label: "news.itemsPath" },
		{ key: "titlePaths", label: "news.titlePaths", type: "list" },
		{ key: "urlPaths", label: "news.urlPaths", type: "list" },
		{ key: "urlTemplate", label: "news.urlTemplate" },
		{ key: "bodyPaths", label: "news.bodyPaths", type: "list" },
		{ key: "summaryPaths", label: "news.summaryPaths", type: "list" },
		{ key: "publishedAtPath", label: "news.datePath" },
		{ key: "publishedAtUnit", label: "news.dateUnit" },
		{ key: "externalIdPath", label: "news.externalIdPath" },
		{ key: "authorPaths", label: "news.authorPaths", type: "list" },
		{ key: "headers", label: "news.headers", type: "json" },
	],
	x_search: [
		{ key: "query", label: "news.xQuery" },
		{ key: "searchType", label: "news.xSearchType" },
	],
	mp_account: [
		{ key: "ghid", label: "news.ghid" },
		{ key: "wxid", label: "news.wxid" },
	],
	external: [],
};

export function NewsSources({
	api,
	revision,
	onChanged,
}: {
	api: NewsClient;
	revision: number;
	onChanged: () => void;
}): React.JSX.Element {
	const t = useT();
	const copy = sourceCopy[getUiLanguage()];
	const sources = useNewsQuery(api, { action: "sources" }, revision);
	const [draft, setDraft] = useState<NewsSourceInput>();
	const [editingId, setEditingId] = useState<string>();
	const [configText, setConfigText] = useState<Record<string, string>>({});
	const [preview, setPreview] = useState<NewsMaterial[]>();
	const [ingestText, setIngestText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [deleting, setDeleting] = useState<string>();
	const [address, setAddress] = useState("");
	const [found, setFound] = useState<NewsFeedDiscovery>();
	const [discovering, setDiscovering] = useState(false);
	const [expanded, setExpanded] = useState<string>();
	const [toast, showToast] = useNewsToast();
	const root = useRef<HTMLElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const feedback = useRef<HTMLDivElement>(null);
	const inFlight = useRef(false);
	const returnFocusId = useRef("");
	const listScrollTop = useRef(0);
	const restorePending = useRef(false);
	const waitForRefresh = useRef(false);
	const dataBeforeSave = useRef<typeof sources.data>(undefined);
	const editorOpen = !!draft;
	useEffect(() => {
		if (!editorOpen) return;
		root.current?.closest<HTMLElement>(".owl-news-content")?.scrollTo({ top: 0 });
		nameInput.current?.focus({ preventScroll: true });
	}, [editorOpen]);
	useEffect(() => {
		if (editorOpen || !restorePending.current) return;
		if (sources.loading) return;
		if (waitForRefresh.current && sources.data === dataBeforeSave.current && !sources.error) return;
		if (!sources.data && !sources.error) return;
		const target = document.getElementById(returnFocusId.current) ?? document.getElementById("owl-news-add-source");
		root.current?.closest<HTMLElement>(".owl-news-content")?.scrollTo({ top: listScrollTop.current });
		target?.focus({ preventScroll: true });
		restorePending.current = false;
	}, [editorOpen, sources.loading, sources.data, sources.error]);
	useEffect(() => {
		if (editorOpen && (error || notice || preview)) feedback.current?.scrollIntoView({ block: "nearest" });
	}, [editorOpen, error, notice, preview]);
	useEffect(() => {
		if (editorOpen || !notice) return;
		showToast(notice);
		setNotice("");
	}, [editorOpen, notice, showToast]);
	function edit(source?: NewsSource): void {
		if (inFlight.current) return;
		returnFocusId.current = source ? `owl-news-edit-source-${source.id}` : "owl-news-add-source";
		listScrollTop.current = root.current?.closest<HTMLElement>(".owl-news-content")?.scrollTop ?? 0;
		waitForRefresh.current = false;
		setEditingId(source?.id);
		setPreview(undefined);
		setError("");
		setNotice("");
		setIngestText("");
		setDeleting(undefined);
		setConfigText({});
		setDraft(
			source
				? {
						id: source.id,
						name: source.name,
						kind: source.kind,
						config: { ...source.config },
						tier: source.tier,
						participation: source.participation,
						enabled: source.enabled,
						intervalMinutes: source.intervalMinutes,
						owner: source.owner,
						publisherGroup: source.publisherGroup,
						siteFulltext: source.siteFulltext,
						syndicateFulltext: source.syndicateFulltext,
					}
				: {
						id: "",
						name: "",
						kind: "rss",
						config: {},
						tier: "T2",
						participation: "editorial",
						enabled: true,
						intervalMinutes: 60,
						siteFulltext: false,
						syndicateFulltext: false,
					},
		);
	}
	function input(): NewsSourceInput {
		if (!draft) throw new Error(t("news.sourceRequired"));
		const config = { ...draft.config };
		for (const field of FIELDS[draft.kind]) {
			if (!(field.key in configText)) continue;
			const value = configText[field.key].trim();
			if (!value) {
				delete config[field.key];
				continue;
			}
			config[field.key] =
				field.type === "list"
					? value
							.split("\n")
							.map((entry) => entry.trim())
							.filter(Boolean)
					: field.type === "json"
						? (JSON.parse(value) as unknown)
						: value;
		}
		if (!draft.id.trim() || !draft.name.trim()) throw new Error(t("news.sourceRequired"));
		return { ...draft, id: draft.id.trim(), name: draft.name.trim(), config };
	}
	async function perform(operation: () => Promise<unknown>, message: string, refresh = true): Promise<void> {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await operation();
			setNotice(message);
			if (refresh) onChanged();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}
	const list = sources.data ?? [];
	const groups = [
		{
			tone: "bad",
			label: "news.groupProblem",
			entries: list.filter((source) => source.enabled && (source.reader ?? source).lastError),
		},
		{
			tone: "ok",
			label: "news.groupOk",
			entries: list.filter((source) => {
				const health = source.reader ?? source;
				return source.enabled && !health.lastError && health.lastCollectedAt;
			}),
		},
		{
			tone: "pending",
			label: undefined,
			entries: list.filter((source) => {
				const health = source.reader ?? source;
				return source.enabled && !health.lastError && !health.lastCollectedAt;
			}),
		},
		{ tone: "off", label: "news.groupOff", entries: list.filter((source) => !source.enabled) },
	] as const;
	function addFound(feed: NewsFeedDiscovery): void {
		const host = new URL(feed.feedUrl).hostname.replace(/^www\./, "");
		const base = host.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 90) || "source";
		const taken = new Set(list.map((source) => source.id));
		let id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
		const name = feed.title || host;
		void perform(
			async () => {
				await api.query({
					action: "saveSource",
					source: {
						id,
						name,
						kind: "rss",
						config: { feedUrl: feed.feedUrl },
						tier: "T2",
						participation: "editorial",
						enabled: true,
						intervalMinutes: commonInterval(list),
						siteFulltext: false,
						syndicateFulltext: false,
					},
				});
				setFound(undefined);
				setAddress("");
			},
			t("news.sourceAdded", { name }),
		);
	}
	return (
		<section ref={root} className={draft ? undefined : "owl-news-settings"}>
			{toast}
			{!draft && (
				<>
					<form
						className="owl-news-add"
						onSubmit={(event) => {
							event.preventDefault();
							if (!address.trim()) return;
							setFound(undefined);
							void perform(
								async () => {
									setDiscovering(true);
									try {
										setFound(await api.query({ action: "discoverSource", url: address }));
									} catch (failure) {
										throw new Error(explainError(errorText(failure), t));
									} finally {
										setDiscovering(false);
									}
								},
								"",
								false,
							);
						}}
					>
						<input
							value={address}
							aria-label={t("news.addByUrl")}
							placeholder={t("news.addByUrl")}
							onChange={(event) => {
								setAddress(event.target.value);
								setFound(undefined);
							}}
						/>
						<button type="submit" className="owl-news-primary" disabled={busy || !address.trim()}>
							{discovering ? t("news.discovering") : t("news.discover")}
						</button>
					</form>
					{found ? (
						<div className="owl-news-found">
							<div>
								<div>
									<b>{found.title || new URL(found.feedUrl).hostname}</b>
									<small>{t("news.feedFound", { url: found.feedUrl.replace(/^https?:\/\//, "") })}</small>
								</div>
								<button
									type="button"
									className="owl-news-primary"
									disabled={busy}
									onClick={() => addFound(found)}
								>
									{t("common.add")}
								</button>
							</div>
							<ul>
								{found.items.map((item) => (
									<li key={item.url}>
										{item.title}
										{item.publishedAt && <span>{new Date(item.publishedAt).toLocaleDateString()}</span>}
									</li>
								))}
							</ul>
						</div>
					) : (
						<p className="owl-news-add-hint">
							{t("news.discoverHint")}
							<button id="owl-news-add-source" type="button" disabled={busy} onClick={() => edit()}>
								{t("news.addManually")}
							</button>
						</p>
					)}
				</>
			)}
			{((!draft && error) || sources.error) && (
				<p role="alert" className="owl-news-error">
					{error || sources.error}
				</p>
			)}
			{sources.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{!sources.loading && sources.data?.length === 0 && (
				<div className="owl-news-empty">
					<h2>{t("news.noSources")}</h2>
					<p>{t("news.noSourcesHint")}</p>
				</div>
			)}
			{!draft &&
				groups.map(
					(group) =>
						group.entries.length > 0 && (
							<div key={group.tone}>
								<div className="owl-news-group">
									{group.label
										? t(group.label, { n: group.entries.length })
										: `${copy.waiting} · ${group.entries.length}`}
								</div>
								<div className="owl-news-src-list">
									{group.entries.map((source) => (
										<div key={source.id} className={`owl-news-src is-${group.tone}`}>
											<div className="owl-news-src-row">
												<button
													type="button"
													className="owl-news-src-main"
													aria-expanded={expanded === source.id}
													onClick={() => {
														setExpanded(expanded === source.id ? undefined : source.id);
														setDeleting(undefined);
													}}
												>
													<span
														className="owl-news-dot"
														style={
															group.tone === "pending"
																? { background: "var(--owl-ui-border)" }
																: undefined
														}
													/>
													<span>
														<b>{source.name}</b>
														<small>{sourceStatus(source, t)}</small>
													</span>
												</button>
												<button
													type="button"
													role="switch"
													className="owl-news-switch"
													aria-checked={source.enabled}
													aria-label={t("news.sourceSwitch", { name: source.name })}
													disabled={busy}
													onClick={() =>
														void perform(
															() =>
																api.query({
																	action: "saveSource",
																	source: { ...source, enabled: !source.enabled },
																}),
															t("common.saved"),
														)
													}
												/>
											</div>
											{expanded === source.id && (
												<div className="owl-news-src-more">
													{deleting === source.id ? (
														<>
															<p>{t("news.deleteSourceConfirm")}</p>
															<button
																type="button"
																className="is-danger"
																disabled={busy}
																onClick={() =>
																	void perform(async () => {
																		await api.query({ action: "deleteSource", id: source.id });
																		setDeleting(undefined);
																	}, t("news.deleted"))
																}
															>
																{t("common.confirmDelete")}
															</button>
															<button type="button" onClick={() => setDeleting(undefined)}>
																{t("common.cancel")}
															</button>
														</>
													) : (
														<>
															<SourceNote source={source} />
															<button
																type="button"
																disabled={busy || (!!source.reader && !source.enabled)}
																onClick={() =>
																	void perform(
																		() =>
																			source.reader
																				? api.ready(true)
																				: api.query({ action: "run", sourceId: source.id }),
																		source.reader ? copy.publicRequested : t("news.queued"),
																	)
																}
															>
																{source.reader ? copy.publicUpdate : t("news.collectNow")}
															</button>
															<button
																id={`owl-news-edit-source-${source.id}`}
																type="button"
																disabled={busy}
																onClick={() => edit(source)}
															>
																{t("common.edit")}
															</button>
															<button
																type="button"
																className="is-danger"
																disabled={busy}
																onClick={() => setDeleting(source.id)}
															>
																{t("common.delete")}
															</button>
														</>
													)}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						),
				)}
			{draft && (
				<form
					className="owl-news-form owl-news-source-editor"
					aria-busy={busy}
					onSubmit={(event) => {
						event.preventDefault();
						void perform(async () => {
							dataBeforeSave.current = sources.data;
							const saved = await api.query({ action: "saveSource", source: input() });
							setEditingId(saved.id);
							if (draft.kind === "external") {
								setDraft({ ...draft, id: saved.id, name: saved.name });
							} else {
								restorePending.current = true;
								waitForRefresh.current = true;
								setDraft(undefined);
							}
						}, t("common.saved"));
					}}
				>
					<fieldset className="owl-news-source-fields" disabled={busy}>
						<div className="owl-news-heading">
							<h2>{editingId ? `${t("common.edit")} · ${draft.name}` : t("news.addSource")}</h2>
							<button
								type="button"
								disabled={busy}
								onClick={() => {
									restorePending.current = true;
									waitForRefresh.current = false;
									setDraft(undefined);
									setPreview(undefined);
									setError("");
									setNotice("");
								}}
							>
								{t("common.cancel")}
							</button>
						</div>
						<div className="owl-news-grid">
							<label>
								{t("news.sourceId")}
								<input
									required
									value={draft.id}
									disabled={!!editingId}
									onChange={(event) => setDraft({ ...draft, id: event.target.value })}
								/>
							</label>
							<label>
								{t("news.sourceName")}
								<input
									ref={nameInput}
									required
									value={draft.name}
									onChange={(event) => setDraft({ ...draft, name: event.target.value })}
								/>
							</label>
							<label>
								{t("news.sourceKind")}
								<select
									value={draft.kind}
									onChange={(event) => {
										setDraft({ ...draft, kind: event.target.value as NewsSourceKind, config: {} });
										setConfigText({});
										setPreview(undefined);
										setNotice("");
									}}
								>
									{KINDS.map((kind) => (
										<option value={kind.id} key={kind.id}>
											{t(kind.label)}
										</option>
									))}
								</select>
							</label>
							<label>
								{t("news.tier")}
								<select
									value={draft.tier}
									onChange={(event) => setDraft({ ...draft, tier: event.target.value as NewsTier })}
								>
									{(["T1", "T1_5", "T2", "EXCLUDE_MP"] as const).map((tier) => (
										<option key={tier}>{tier}</option>
									))}
								</select>
							</label>
							<label>
								{t("news.participation")}
								<select
									value={draft.participation}
									onChange={(event) =>
										setDraft({ ...draft, participation: event.target.value as NewsParticipation })
									}
								>
									<option value="editorial">{t("news.editorial")}</option>
									<option value="hot_signal">{t("news.hotSignal")}</option>
									<option value="isolated">{t("news.isolated")}</option>
								</select>
							</label>
							<label>
								{t("news.interval")}
								<input
									type="number"
									required
									min={1}
									value={draft.intervalMinutes}
									onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })}
								/>
							</label>
							<label>
								{t("news.owner")}
								<input
									value={draft.owner ?? ""}
									onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
								/>
							</label>
							<label>
								{t("news.publisherGroup")}
								<input
									value={draft.publisherGroup ?? ""}
									onChange={(event) => setDraft({ ...draft, publisherGroup: event.target.value })}
								/>
							</label>
						</div>
						<div className="owl-news-checks">
							<label>
								<input
									type="checkbox"
									checked={draft.enabled}
									onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
								/>
								{t("news.enable")}
							</label>
							<label>
								<input
									type="checkbox"
									checked={draft.siteFulltext}
									onChange={(event) => setDraft({ ...draft, siteFulltext: event.target.checked })}
								/>
								{t("news.allowFulltext")}
							</label>
							<label>
								<input
									type="checkbox"
									checked={draft.syndicateFulltext}
									onChange={(event) => setDraft({ ...draft, syndicateFulltext: event.target.checked })}
								/>
								{t("news.allowSyndication")}
							</label>
						</div>
						<p className="owl-news-muted">{t("news.fulltextHint")}</p>
						<div className="owl-news-grid">
							{FIELDS[draft.kind].map((field) => {
								const stored = draft.config[field.key];
								const value =
									configText[field.key] ??
									(Array.isArray(stored)
										? stored.join("\n")
										: field.type === "json" && stored
											? JSON.stringify(stored, null, 2)
											: String(stored ?? ""));
								return (
									<label key={field.key} htmlFor={`owl-news-source-${field.key}`}>
										{t(field.label)}
										{field.type === "boolean" ? (
											<input
												id={`owl-news-source-${field.key}`}
												type="checkbox"
												checked={stored === true}
												onChange={(event) => {
													setDraft({
														...draft,
														config: { ...draft.config, [field.key]: event.target.checked },
													});
													setPreview(undefined);
													setNotice("");
												}}
											/>
										) : field.type === "list" || field.type === "json" ? (
											<textarea
												id={`owl-news-source-${field.key}`}
												rows={3}
												value={value}
												onChange={(event) => {
													setConfigText({ ...configText, [field.key]: event.target.value });
													setPreview(undefined);
													setNotice("");
												}}
											/>
										) : (
											<input
												id={`owl-news-source-${field.key}`}
												value={value}
												onChange={(event) => {
													setConfigText({ ...configText, [field.key]: event.target.value });
													setPreview(undefined);
													setNotice("");
												}}
											/>
										)}
									</label>
								);
							})}
						</div>
						{draft.kind === "json_list" && <p className="owl-news-muted">{t("news.headersHint")}</p>}
						{draft.kind === "external" && (
							<>
								<label>
									{t("news.ingestJson")}
									<textarea
										rows={6}
										value={ingestText}
										onChange={(event) => setIngestText(event.target.value)}
										placeholder='[{"title":"...","url":"https://...","body":"..."}]'
									/>
								</label>
								<button
									type="button"
									disabled={busy || !editingId || !ingestText.trim()}
									onClick={() =>
										void perform(
											() =>
												api.query({
													action: "ingest",
													sourceId: draft.id,
													items: JSON.parse(ingestText) as NewsMaterial[],
												}),
											t("news.ingested"),
										)
									}
								>
									{t("news.ingest")}
								</button>
							</>
						)}
						<div className="owl-news-actions">
							<button type="submit" className="owl-news-primary" disabled={busy}>
								{t("common.save")}
							</button>
							<button
								type="button"
								disabled={busy || draft.kind === "external"}
								onClick={() => {
									setPreview(undefined);
									void perform(
										async () => setPreview(await api.query({ action: "previewSource", source: input() })),
										t("news.previewDone"),
										false,
									);
								}}
							>
								{t("news.preview")}
							</button>
						</div>
						<div ref={feedback}>
							{busy && <p aria-live="polite">{t("common.processing")}</p>}
							{error && (
								<p className="owl-news-error" role="alert">
									{error}
								</p>
							)}
							{notice && (
								<p className="owl-news-notice" role="status">
									{notice}
								</p>
							)}
							{preview && (
								<div>
									<h3>{t("news.previewCount", { n: preview.length })}</h3>
									{preview.map((material) => (
										<article key={material.url} className="owl-news-card">
											<strong>{material.title}</strong>
											<p>{material.url}</p>
											<p>{material.body?.slice(0, 600)}</p>
										</article>
									))}
								</div>
							)}
						</div>
					</fieldset>
				</form>
			)}
		</section>
	);
}
