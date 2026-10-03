import { useEffect, useState } from "react";
import type { NewsItem, NewsSnapshot } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { useT } from "../../i18n/index.ts";
import { errorText, type NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";

type ContentStatus = NewsItem["status"] | "withdrawn" | "";
const STATUSES: ContentStatus[] = ["", "pending", "processing", "ready", "failed", "blocked", "withdrawn"];

export function NewsContentManagement({
	api,
	revision,
	snapshot,
	onItem,
	onChanged,
}: {
	api: NewsClient;
	revision: number;
	snapshot?: NewsSnapshot;
	onItem: (id: string) => void;
	onChanged: () => void;
}): React.JSX.Element {
	const t = useT();
	const [status, setStatus] = useState<ContentStatus>("");
	const [queryInput, setQueryInput] = useState("");
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("");
	const [offset, setOffset] = useState(0);
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");
	useEffect(() => setOffset(0), [status, query, category]);
	const result = useNewsQuery(
		api,
		{
			action: "adminItems",
			query: { mode: "all", query, category, limit: 20, offset },
			...(status ? { status } : {}),
		},
		revision,
	);
	async function retry(itemId: string): Promise<void> {
		setBusy(itemId);
		setError("");
		try {
			await api.query({ action: "retry", itemId });
			onChanged();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(undefined);
		}
	}
	return (
		<section>
			<div className="owl-news-heading">
				<div>
					<h1>{t("news.contentManagement")}</h1>
					<p>{t("news.contentManagementHint")}</p>
				</div>
			</div>
			<form
				className="owl-news-search"
				onSubmit={(event) => {
					event.preventDefault();
					setQuery(queryInput.trim());
				}}
			>
				<input
					value={queryInput}
					onChange={(event) => setQueryInput(event.target.value)}
					placeholder={t("news.searchPlaceholder")}
					aria-label={t("news.search")}
				/>
				<button type="submit">{t("news.search")}</button>
			</form>
			<div className="owl-news-actions">
				<select
					value={status}
					aria-label={t("news.contentStatus")}
					onChange={(event) => setStatus(event.target.value as ContentStatus)}
				>
					{STATUSES.map((entry) => (
						<option key={entry} value={entry}>
							{entry === "withdrawn"
								? t("news.withdrawn")
								: entry
									? t(`news.status.${entry}`)
									: t("news.allStatuses")}
						</option>
					))}
				</select>
				<select
					value={category}
					aria-label={t("news.category")}
					onChange={(event) => setCategory(event.target.value)}
				>
					<option value="">{t("news.allCategories")}</option>
					{snapshot?.categories.map((entry) => (
						<option key={entry.id} value={entry.id}>
							{entry.label}
						</option>
					))}
				</select>
			</div>
			{(error || result.error) && (
				<p className="owl-news-error" role="alert">
					{error || result.error}
				</p>
			)}
			{result.loading && <p aria-live="polite">{t("news.loading")}</p>}
			{result.data?.items.length === 0 && <p className="owl-news-empty">{t("news.noItems")}</p>}
			<div className="owl-news-feed">
				{result.data?.items.map((item) => (
					<article key={item.id} className="owl-news-card">
						<div className="owl-news-meta">
							<span>{item.sourceName}</span>
							<span>{t(`news.status.${item.status}`)}</span>
							{item.withdrawn && <span>{t("news.withdrawn")}</span>}
							<span>{item.participation}</span>
							<time>{new Date(item.updatedAt).toLocaleString()}</time>
						</div>
						<button type="button" className="owl-news-title-link" onClick={() => onItem(item.id)}>
							{item.title || item.originalTitle}
						</button>
						{item.error && <p className="owl-news-error">{item.error}</p>}
						<p className="owl-news-card-summary">{item.summary}</p>
						<div className="owl-news-actions">
							<button type="button" onClick={() => onItem(item.id)}>
								{t("news.diagnoseEdit")}
							</button>
							{(item.status === "failed" || item.status === "pending") && (
								<button type="button" disabled={busy === item.id} onClick={() => void retry(item.id)}>
									{t("news.retry")}
								</button>
							)}
							<span className="owl-news-muted">
								{t("news.score")}: {item.score ?? "—"} · {item.id}
							</span>
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
		</section>
	);
}
