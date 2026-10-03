import { useState } from "react";
import type {
	NewsItem,
	NewsReportKind,
	NewsSnapshot,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { useT } from "../../i18n/index.ts";
import type { NewsContext } from "./NewsAssistant.tsx";
import { errorText, type NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";

export type NewsTarget = { kind: "item" | "story"; id: string; management?: boolean };
interface ReadingProps {
	api: NewsClient;
	revision: number;
	onItem: (id: string) => void;
	onStory: (id: string) => void;
	onDiscuss: (context: NewsContext) => void;
	onChanged: () => void;
	snapshot?: NewsSnapshot;
}

export function NewsItemReader({
	id,
	management = false,
	...props
}: ReadingProps & { id: string; management?: boolean }): React.JSX.Element {
	const t = useT();
	const result = useNewsQuery(props.api, { action: management ? "adminItem" : "item", id }, props.revision);
	const [original, setOriginal] = useState(false);
	const [quote, setQuote] = useState("");
	const [editing, setEditing] = useState(management);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function mutate(operation: () => Promise<unknown>): Promise<void> {
		setBusy(true);
		setError("");
		try {
			await operation();
			props.onChanged();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	}
	if (result.loading) return <p aria-live="polite">{t("news.loading")}</p>;
	if (result.error)
		return (
			<p role="alert" className="owl-news-error">
				{result.error}
			</p>
		);
	const item = result.data;
	if (!item) return <div className="owl-news-empty">{t("news.itemUnavailable")}</div>;
	return (
		<article
			className="owl-news-reading"
			onMouseUp={(event) => {
				const selection = window.getSelection();
				if (selection?.anchorNode && event.currentTarget.contains(selection.anchorNode))
					setQuote(selection.toString().trim().slice(0, 3000));
			}}
		>
			<div className="owl-news-meta">
				<span>{item.sourceName}</span>
				<time>{new Date(item.publishedAt).toLocaleString()}</time>
				<span>{item.category}</span>
				<span>{t(`news.status.${item.status}`)}</span>
			</div>
			<h1>{item.title || item.originalTitle}</h1>
			{item.withdrawn && <p className="owl-news-notice">{t("news.withdrawn")}</p>}
			{item.error && (
				<p role="alert" className="owl-news-error">
					{item.error}
				</p>
			)}
			<p className="owl-news-reading-summary">{item.summary}</p>
			<div className="owl-news-actions">
				<button
					type="button"
					disabled={item.withdrawn || item.status !== "ready"}
					className="owl-news-primary"
					onClick={() => props.onDiscuss({ items: [item] })}
				>
					{t("news.ask")}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => void mutate(() => props.api.query({ action: "bookmark", id, saved: !item.saved }))}
				>
					{item.saved ? t("news.unsave") : t("news.save")}
				</button>
				<button
					type="button"
					onClick={() => void props.api.openUrl(item.url).catch((failure) => setError(errorText(failure)))}
				>
					{t("news.original")}
				</button>
				{item.storyId && (
					<button type="button" onClick={() => props.onStory(item.storyId as string)}>
						{t("news.eventContext")}
					</button>
				)}
				<button type="button" onClick={() => setEditing(!editing)}>
					{t("news.editContent")}
				</button>
				{management && (
					<button
						type="button"
						disabled={busy || item.status === "processing"}
						onClick={() => void mutate(() => props.api.query({ action: "retry", itemId: id }))}
					>
						{t("news.reprocess")}
					</button>
				)}
			</div>
			{quote && (
				<div className="owl-news-quote-selection">
					<span>{quote.length > 100 ? `${quote.slice(0, 100)}…` : quote}</span>
					<button
						type="button"
						onClick={() => {
							props.onDiscuss({ items: [item], quote });
							setQuote("");
						}}
					>
						{t("news.discussQuote")}
					</button>
				</div>
			)}
			{error && (
				<p className="owl-news-error" role="alert">
					{error}
				</p>
			)}
			{item.reason && (
				<p className="owl-news-muted">
					{t("news.recommendation")}: {item.reason}
				</p>
			)}
			{item.originalBody && item.fulltextAllowed && (
				<div className="owl-news-tabs">
					<button type="button" className={!original ? "is-active" : ""} onClick={() => setOriginal(false)}>
						{t("news.translation")}
					</button>
					<button type="button" className={original ? "is-active" : ""} onClick={() => setOriginal(true)}>
						{t("news.originalBody")}
					</button>
				</div>
			)}
			<div className="owl-news-prose">
				{item.fulltextAllowed
					? (original ? item.originalBody : item.body) || t("news.bodyPending")
					: t("news.summaryOnly")}
			</div>
			{item.tags.length > 0 && (
				<div className="owl-news-tags">
					{item.tags.map((tag) => (
						<span key={tag}>#{tag}</span>
					))}
				</div>
			)}
			{management && (
				<details className="owl-news-diagnostics">
					<summary>{t("news.processingDetails")}</summary>
					<dl>
						<dt>{t("news.sourceId")}</dt>
						<dd>{item.sourceId}</dd>
						<dt>{t("news.contentId")}</dt>
						<dd>{item.id}</dd>
						<dt>{t("news.revision")}</dt>
						<dd>{item.revision}</dd>
						<dt>{t("news.dualScores")}</dt>
						<dd>{item.scores.join(" / ") || "—"}</dd>
						<dt>{t("news.selection")}</dt>
						<dd>{item.selected ? t("news.selected") : t("news.rejected")}</dd>
						<dt>{t("news.relevance")}</dt>
						<dd>{item.relevance}</dd>
						<dt>{t("news.contentKind")}</dt>
						<dd>{item.contentKind}</dd>
					</dl>
					{item.fact && (
						<p>
							{item.fact.subject} · {item.fact.action} · {item.fact.object}
							<br />
							{item.fact.occurredAt}
							<br />
							{item.fact.evidence.join("\n")}
						</p>
					)}
				</details>
			)}
			{editing && (
				<NewsItemEditor
					key={item.id}
					item={item}
					api={props.api}
					categories={props.snapshot?.categories ?? []}
					onSaved={() => {
						setEditing(false);
						props.onChanged();
					}}
				/>
			)}
		</article>
	);
}

function NewsItemEditor({
	item,
	api,
	categories,
	onSaved,
}: {
	item: NewsItem;
	api: NewsClient;
	categories: { id: string; label: string }[];
	onSaved: () => void;
}): React.JSX.Element {
	const t = useT();
	const [title, setTitle] = useState(item.title);
	const [summary, setSummary] = useState(item.summary);
	const [category, setCategory] = useState(item.category);
	const [tags, setTags] = useState(item.tags.join(", "));
	const [selected, setSelected] = useState(item.selected);
	const [storyId, setStoryId] = useState(item.storyId ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [confirmWithdraw, setConfirmWithdraw] = useState(false);
	async function execute(operation: () => Promise<unknown>): Promise<void> {
		setBusy(true);
		setError("");
		try {
			await operation();
			onSaved();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	}
	return (
		<form
			className="owl-news-form"
			onSubmit={(event) => {
				event.preventDefault();
				void execute(() =>
					api.query({
						action: "editItem",
						id: item.id,
						patch: {
							title,
							summary,
							category,
							tags: tags
								.split(/[,，\n]/)
								.map((tag) => tag.trim())
								.filter(Boolean),
							selected,
						},
					}),
				);
			}}
		>
			<h2>{t("news.editContent")}</h2>
			{error && (
				<p role="alert" className="owl-news-error">
					{error}
				</p>
			)}
			<label>
				{t("news.title")}
				<input required value={title} onChange={(event) => setTitle(event.target.value)} />
			</label>
			<label>
				{t("news.summary")}
				<textarea rows={5} value={summary} onChange={(event) => setSummary(event.target.value)} />
			</label>
			<label>
				{t("news.category")}
				<select value={category} onChange={(event) => setCategory(event.target.value)}>
					{categories.map((entry) => (
						<option key={entry.id} value={entry.id}>
							{entry.label}
						</option>
					))}
				</select>
			</label>
			<label>
				{t("news.tags")}
				<input value={tags} onChange={(event) => setTags(event.target.value)} />
			</label>
			<label className="owl-news-check">
				<input type="checkbox" checked={selected} onChange={(event) => setSelected(event.target.checked)} />
				{t("news.selected")}
			</label>
			<button type="submit" disabled={busy} className="owl-news-primary">
				{t("common.save")}
			</button>
			<label>
				{t("news.storyId")}
				<input
					value={storyId}
					onChange={(event) => setStoryId(event.target.value)}
					placeholder={t("news.detachHint")}
				/>
			</label>
			<button
				type="button"
				disabled={busy}
				onClick={() =>
					void execute(() => api.query({ action: "moveItem", id: item.id, storyId: storyId.trim() || null }))
				}
			>
				{t("news.moveItem")}
			</button>
			<button type="button" disabled={busy} onClick={() => setConfirmWithdraw(true)}>
				{item.withdrawn ? t("news.restoreItem") : t("news.withdraw")}
			</button>
			{confirmWithdraw && (
				<div className="owl-news-confirm">
					<p>{t("news.withdrawHint")}</p>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void execute(() => api.query({ action: "withdraw", id: item.id, withdrawn: !item.withdrawn }))
						}
					>
						{t("common.done")}
					</button>
					<button type="button" onClick={() => setConfirmWithdraw(false)}>
						{t("common.cancel")}
					</button>
				</div>
			)}
		</form>
	);
}

export function NewsStoryReader({ id, ...props }: ReadingProps & { id: string }): React.JSX.Element {
	const t = useT();
	const result = useNewsQuery(props.api, { action: "story", id }, props.revision);
	const [order, setOrder] = useState<"latest" | "oldest">("latest");
	if (result.loading) return <p aria-live="polite">{t("news.loading")}</p>;
	if (result.error)
		return (
			<p role="alert" className="owl-news-error">
				{result.error}
			</p>
		);
	const story = result.data;
	if (!story) return <div className="owl-news-empty">{t("news.itemUnavailable")}</div>;
	const reports = [...story.reports].sort((a, b) =>
		order === "latest" ? b.publishedAt.localeCompare(a.publishedAt) : a.publishedAt.localeCompare(b.publishedAt),
	);
	return (
		<article className="owl-news-reading">
			<div className="owl-news-eyebrow">{t("news.event")}</div>
			<h1>{story.title}</h1>
			<p className="owl-news-reading-summary">{story.summary}</p>
			<div className="owl-news-meta">
				<span>{t("news.sourceCount", { n: story.sourceCount })}</span>
				<span>{t("news.reportCount", { n: story.reports.length })}</span>
				{story.manual && <span>{t("news.manual")}</span>}
			</div>
			<div className="owl-news-actions">
				<button
					type="button"
					className="owl-news-primary"
					onClick={() => props.onDiscuss({ items: story.reports.slice(0, 2), storyId: id })}
				>
					{t("news.ask")}
				</button>
			</div>
			<div className="owl-news-heading">
				<h2>{t("news.timeline")}</h2>
				<select
					aria-label={t("news.order")}
					value={order}
					onChange={(event) => setOrder(event.target.value as typeof order)}
				>
					<option value="latest">{t("news.latestFirst")}</option>
					<option value="oldest">{t("news.oldestFirst")}</option>
				</select>
			</div>
			<div className="owl-news-timeline">
				{reports.map((report) => (
					<article key={report.id}>
						<time>{new Date(report.publishedAt).toLocaleString()}</time>
						<button type="button" className="owl-news-title-link" onClick={() => props.onItem(report.id)}>
							{report.title}
						</button>
						<p>{report.summary}</p>
						<span className="owl-news-muted">{report.sourceName}</span>
					</article>
				))}
			</div>
			{story.relatedStoryIds.length > 0 && (
				<>
					<h2>{t("news.relatedEvents")}</h2>
					{story.relatedStoryIds.map((related) => (
						<button
							key={related}
							type="button"
							className="owl-news-history"
							onClick={() => props.onStory(related)}
						>
							{t("news.openRelatedEvent")} · {related.slice(0, 12)}
						</button>
					))}
				</>
			)}
		</article>
	);
}

export function NewsReportReader({ kind, ...props }: ReadingProps & { kind: NewsReportKind }): React.JSX.Element {
	const t = useT();
	const [key, setKey] = useState("");
	const archive = useNewsQuery(props.api, { action: "reports", kind, limit: 60 }, props.revision);
	const result = useNewsQuery(props.api, { action: "report", kind, ...(key ? { key } : {}) }, props.revision);
	return (
		<section>
			<div className="owl-news-heading">
				<h1>{t(`news.${kind}`)}</h1>
				<select aria-label={t("news.reportArchive")} value={key} onChange={(event) => setKey(event.target.value)}>
					<option value="">{t("news.latestIssue")}</option>
					{archive.data?.map((report) => (
						<option key={report.id} value={report.key}>
							{report.key}
						</option>
					))}
				</select>
			</div>
			{archive.error && (
				<p className="owl-news-error" role="alert">
					{archive.error}
				</p>
			)}
			{result.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{result.error && (
				<p className="owl-news-error" role="alert">
					{result.error}
				</p>
			)}
			{!result.loading && !result.error && !result.data && (
				<div className="owl-news-empty">
					<h2>{t("news.noReports")}</h2>
					<p>{t("news.noReportsHint")}</p>
				</div>
			)}
			{result.data && (
				<article className="owl-news-report">
					<div className="owl-news-eyebrow">
						{result.data.periodStart} — {result.data.periodEnd}
					</div>
					<h1>{result.data.title}</h1>
					<div className="owl-news-meta">
						<span>{t("news.sourceCount", { n: result.data.sourceCount })}</span>
						<span>{t("news.eventCount", { n: result.data.storyCount })}</span>
					</div>
					<p className="owl-news-reading-summary">{result.data.lead}</p>
					<button
						type="button"
						className="owl-news-primary"
						onClick={() => {
							const report = result.data;
							if (report)
								props.onDiscuss({
									items: report.sections.flatMap((section) => section.items).slice(0, 2),
									reportId: report.id,
								});
						}}
					>
						{t("news.ask")}
					</button>
					{result.data.sections.map((section, index) => (
						<section key={`${index}-${section.label}`}>
							<h2>{section.label}</h2>
							<p className="owl-news-muted">{section.summary}</p>
							{section.items.map((item) => (
								<article className="owl-news-report-item" key={item.id}>
									<button type="button" className="owl-news-title-link" onClick={() => props.onItem(item.id)}>
										{item.title}
									</button>
									<p>{item.summary}</p>
									<small>{item.sourceName}</small>
									{(result.data?.relatedItems?.[item.id]?.length ?? 0) > 0 && (
										<details className="owl-news-report-sources">
											<summary>{t("news.otherReports")}</summary>
											{result.data?.relatedItems?.[item.id]?.map((related) => (
												<button
													type="button"
													key={related.id}
													className="owl-news-history"
													onClick={() => props.onItem(related.id)}
												>
													{related.sourceName} · {related.title}
												</button>
											))}
										</details>
									)}
								</article>
							))}
						</section>
					))}
					{result.data.briefs.length > 0 && (
						<section>
							<h2>{t("news.briefs")}</h2>
							{result.data.briefs.map((item) => (
								<button
									type="button"
									className="owl-news-history"
									key={item.id}
									onClick={() => props.onItem(item.id)}
								>
									{item.title}
								</button>
							))}
						</section>
					)}
				</article>
			)}
		</section>
	);
}
