import { Fragment, useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionSearchHit, SessionSearchResult } from "../bridge/protocol.ts";
import { getUiLanguage } from "../i18n/index.ts";
import { getProjectDisplayName } from "../project-sidebar-model.ts";
import { samePath } from "../utils/paths.ts";
import { useSessionSearchText } from "./session-search-copy.ts";
import "./session-search.css";

export type SessionSearchPanelProps = {
	client: BridgeClient;
	connected: boolean;
	query: string;
	activeProject: string;
	refreshKey: string;
	revision: number;
	metadataSessions: readonly SessionSearchHit[];
	projects: readonly string[];
	onOpenHit: (hit: SessionSearchHit, query: string) => void;
	onSelectProject: (path: string) => void;
};

/** Render only text nodes and marks; excerpts can contain arbitrary user or model output. */
function HighlightedExcerpt({ hit }: { hit: SessionSearchHit }): React.JSX.Element {
	const ranges = hit.matchRanges
		.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
		.map((range) => ({
			start: Math.max(0, Math.floor(range.start)),
			end: Math.min(hit.excerpt.length, Math.floor(range.end)),
		}))
		.filter((range) => range.end > range.start)
		.sort((left, right) => left.start - right.start);
	const merged: { start: number; end: number }[] = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	let cursor = 0;
	return (
		<>
			{merged.map((range) => {
				const preceding = hit.excerpt.slice(cursor, range.start);
				cursor = range.end;
				return (
					<Fragment key={range.start}>
						{preceding}
						<mark>{hit.excerpt.slice(range.start, range.end)}</mark>
					</Fragment>
				);
			})}
			{hit.excerpt.slice(cursor)}
		</>
	);
}

export function SessionSearchPanel({
	client,
	connected,
	query,
	activeProject,
	refreshKey,
	revision,
	metadataSessions,
	projects,
	onOpenHit,
	onSelectProject,
}: SessionSearchPanelProps): React.JSX.Element {
	const text = useSessionSearchText();
	const [currentProjectOnly, setCurrentProjectOnly] = useState(false);
	const [includeArchived, setIncludeArchived] = useState(false);
	const [retry, setRetry] = useState(0);
	const queryText = query.trim();
	const cwd = currentProjectOnly ? activeProject : undefined;
	const filterKey = JSON.stringify([queryText, cwd, includeArchived]);
	const [limitState, setLimitState] = useState({ key: "", limit: 50 });
	const limit = limitState.key === filterKey ? limitState.limit : 50;
	const requestKey = JSON.stringify([filterKey, limit, connected, refreshKey, revision, retry]);
	const [response, setResponse] = useState<{ key: string; result?: SessionSearchResult; error?: string }>();
	const currentResponse = response?.key === requestKey ? response : undefined;
	const result = currentResponse?.result;
	const loading = connected && queryText !== "" && currentResponse === undefined;

	useEffect(() => {
		if (!connected || !queryText) return;
		let cancelled = false;
		// Typing and filter changes invalidate the previous response before this debounce starts.
		const timer = setTimeout(() => {
			void client
				.request<SessionSearchResult>({ type: "session.search", query: queryText, cwd, includeArchived, limit })
				.then((value) => {
					if (cancelled) return;
					setResponse(
						value.ok && value.result
							? { key: requestKey, result: value.result }
							: { key: requestKey, error: value.error || "" },
					);
				})
				.catch((error: unknown) => {
					if (!cancelled)
						setResponse({ key: requestKey, error: error instanceof Error ? error.message : String(error) });
				});
		}, 220);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [client, connected, queryText, cwd, includeArchived, limit, requestKey]);

	const matchingSessionIds = new Set(result?.hits.map((hit) => hit.sessionId));
	const metadata = metadataSessions.filter(
		(hit) =>
			(!cwd || samePath(hit.cwd, cwd)) &&
			(includeArchived || !hit.archived) &&
			!matchingSessionIds.has(hit.sessionId),
	);
	const projectMatches = projects.filter((path) => !cwd || samePath(path, cwd));
	const renderHit = (hit: SessionSearchHit, body: boolean): React.JSX.Element => {
		const date = new Date(hit.modified);
		const validDate = Number.isFinite(date.getTime());
		const projectName = hit.cwd ? getProjectDisplayName(hit.cwd) : text("noProject");
		return (
			<li key={`${hit.sessionId}:${hit.entryId}`}>
				<button
					type="button"
					className="owl-session-search-hit"
					onClick={() => onOpenHit(hit, queryText)}
					title={hit.title}
				>
					<span className="owl-session-search-title">{hit.title}</span>
					<span className="owl-session-search-meta">
						<span className="owl-session-search-source">
							{text(hit.scope === "research" ? "research" : "chat")}
						</span>
						{hit.archived && <span className="owl-session-search-archived">{text("archived")}</span>}
						{validDate && (
							<time
								dateTime={hit.modified}
								title={date.toLocaleString(getUiLanguage() === "en" ? "en-US" : "zh-CN")}
							>
								{date.toLocaleDateString(getUiLanguage() === "en" ? "en-US" : "zh-CN", {
									month: "2-digit",
									day: "2-digit",
								})}
							</time>
						)}
					</span>
					<span className="owl-session-search-project" title={hit.cwd}>
						{projectName}
					</span>
					{body && (
						<span className="owl-session-search-excerpt">
							<span className="owl-session-search-role">
								{text(hit.role === "user" ? "user" : "assistant")} ·{" "}
							</span>
							<HighlightedExcerpt hit={hit} />
						</span>
					)}
				</button>
			</li>
		);
	};

	return (
		<div className="owl-session-search-panel">
			<div className="owl-session-search-filters">
				<div className="owl-session-search-scope" role="group" aria-label={text("filters")}>
					<button type="button" aria-pressed={!currentProjectOnly} onClick={() => setCurrentProjectOnly(false)}>
						{text("allProjects")}
					</button>
					<button
						type="button"
						aria-pressed={currentProjectOnly}
						disabled={!activeProject}
						title={activeProject}
						onClick={() => setCurrentProjectOnly(true)}
					>
						{text("currentProject")}
					</button>
				</div>
				<label className="owl-session-search-archive">
					<input
						type="checkbox"
						checked={includeArchived}
						onChange={(event) => setIncludeArchived(event.target.checked)}
					/>
					{text("includeArchived")}
				</label>
			</div>
			<section aria-label={text("contents")} aria-busy={loading}>
				<h3 className="owl-session-search-heading">
					{text("contents")}
					{result && (
						<span>
							{result.hits.length}
							{result.hasMore ? "+" : ""}
						</span>
					)}
				</h3>
				<div className="owl-session-search-status" role="status" aria-live="polite">
					{!connected ? (
						<p>{text("offline")}</p>
					) : loading ? (
						<p>{text("loading")}</p>
					) : result?.hits.length === 0 ? (
						<p>{text("empty")}</p>
					) : null}
				</div>
				{connected && currentResponse?.error !== undefined && (
					<div className="owl-session-search-error" role="alert">
						<p>
							{text("failed")}
							{currentResponse.error ? `：${currentResponse.error}` : ""}
						</p>
						<button type="button" onClick={() => setRetry((value) => value + 1)}>
							{text("retry")}
						</button>
					</div>
				)}
				{result && <ul className="owl-session-search-results">{result.hits.map((hit) => renderHit(hit, true))}</ul>}
				{result?.hasMore &&
					(limit < 200 ? (
						<button
							type="button"
							className="owl-session-search-more"
							onClick={() => setLimitState({ key: filterKey, limit: Math.min(limit + 50, 200) })}
						>
							{text("more")}
						</button>
					) : (
						<p className="owl-session-search-limit">{text("limit")}</p>
					))}
			</section>
			{(metadata.length > 0 || projectMatches.length > 0) && (
				<section aria-label={text("metadata")}>
					<h3 className="owl-session-search-heading">{text("metadata")}</h3>
					<ul className="owl-session-search-results">
						{projectMatches.map((path) => (
							<li key={path}>
								<button
									type="button"
									className="owl-session-search-hit owl-session-search-project-hit"
									title={path}
									onClick={() => onSelectProject(path)}
								>
									<span className="owl-session-search-title">{getProjectDisplayName(path)}</span>
									<span className="owl-session-search-project">{path}</span>
								</button>
							</li>
						))}
						{metadata.map((hit) => renderHit(hit, false))}
					</ul>
				</section>
			)}
		</div>
	);
}
