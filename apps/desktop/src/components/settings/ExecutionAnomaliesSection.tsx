import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ExecutionAnomalyListInput, ExecutionAnomalyRecord } from "../../bridge/protocol.ts";
import { IconRefresh } from "../icons.tsx";
import { useExecutionAnomaliesCopy } from "./execution-anomalies-copy.ts";
import { ExecutionAnomalyProcessing } from "./ExecutionAnomalyProcessing.tsx";
import { SectionHeader } from "./settings-widgets.tsx";
import "./execution-anomalies.css";

const PAGE_SIZE = 40;

export function ExecutionAnomaliesSection({ client, onOpenSession }: {
	client: BridgeClient;
	onOpenSession?: (record: ExecutionAnomalyRecord) => void;
}): React.JSX.Element {
	const copy = useExecutionAnomaliesCopy();
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<ExecutionAnomalyRecord["status"] | undefined>();
	const [processing, setProcessing] = useState<NonNullable<ExecutionAnomalyListInput["processing"]>>("active");
	const [offset, setOffset] = useState(0);
	const [refreshKey, setRefreshKey] = useState(0);
	const [result, setResult] = useState<{ records: ExecutionAnomalyRecord[]; total: number } | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [failed, setFailed] = useState(false);
	const requestRevision = useRef(0);
	const previousFilter = useRef<{ client: BridgeClient; key: string } | undefined>(undefined);

	useEffect(() => client.onExecutionAnomaliesChanged(() => setRefreshKey((key) => key + 1)), [client]);

	useEffect(() => {
		const revision = ++requestRevision.current;
		setLoading(true);
		setError("");
		setFailed(false);
		const key = JSON.stringify([search, status, processing, offset]);
		if (previousFilter.current?.client !== client || previousFilter.current?.key !== key) setResult(null);
		previousFilter.current = { client, key };
		void client.listExecutionAnomalies({ query: search || undefined, status, processing, limit: PAGE_SIZE, offset })
			.then((response) => {
				if (requestRevision.current !== revision) return;
				if (!response.ok || !response.result) {
					setError(response.error || "");
					setFailed(true);
					return;
				}
				if (offset > 0 && response.result.total <= offset) {
					setOffset(Math.max(0, Math.ceil(response.result.total / PAGE_SIZE) - 1) * PAGE_SIZE);
					return;
				}
				setResult(response.result);
			})
			.catch((reason: unknown) => {
				if (requestRevision.current === revision) {
					setError(reason instanceof Error ? reason.message : String(reason));
					setFailed(true);
				}
			})
			.finally(() => {
				if (requestRevision.current === revision) setLoading(false);
			});
		return () => { requestRevision.current++; };
	}, [client, search, status, processing, offset, refreshKey]);

	const hasError = !loading && failed;
	const formatTime = (value: number): string => Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
		? new Intl.DateTimeFormat(copy.locale, { dateStyle: "medium", timeStyle: "medium" }).format(value) : "—";

	return (
		<>
			<SectionHeader title={copy.title} desc={copy.description} />
			<div className="owl-execution-anomalies-toolbar">
				<form className="owl-execution-anomalies-search" role="search" onSubmit={(event) => {
					event.preventDefault();
					setSearch(query.trim());
					setOffset(0);
				}}>
					<input type="search" className="owl-settings-input" aria-label={copy.searchLabel} placeholder={copy.searchPlaceholder} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
					<button type="submit" className="owl-settings-button">{copy.search}</button>
				</form>
				<button type="button" className="owl-settings-button" disabled={loading} onClick={() => setRefreshKey((key) => key + 1)}>
					<IconRefresh />{copy.refresh}
				</button>
			</div>
			<div className="owl-execution-anomalies-filters">
				<div className="owl-settings-filter-chips" role="group" aria-label={copy.filterLabel}>
					{([undefined, "pending", "reported"] as const).map((item) => (
						<button key={item ?? "all"} type="button" className={`owl-settings-filter-chip ${status === item ? "is-active" : ""}`} aria-pressed={status === item} onClick={() => { setStatus(item); setOffset(0); }}>
							{item ? copy[item] : copy.all}
						</button>
					))}
				</div>
				<label className="owl-execution-anomalies-processing-filter"><span>{copy.processingFilter}</span><select value={processing} onChange={(event) => {
					const value = event.currentTarget.value;
					if (value === "active" || value === "optimized" || value === "dismissed" || value === "all") {
						setProcessing(value);
						setOffset(0);
					}
				}}>{(["active", "optimized", "dismissed", "all"] as const).map((value) => <option key={value} value={value}>{copy.processingViews[value]}</option>)}</select></label>
				{result && <span className="owl-execution-anomalies-count" role="status">{loading ? copy.refreshing : copy.count(result.total)}</span>}
			</div>

			<div className="owl-execution-anomalies-results" aria-busy={loading}>
				{loading && !result && <div className="owl-settings-notice" role="status">{copy.loading}</div>}
				{hasError && <div className="owl-settings-notice is-error owl-execution-anomalies-error" role="alert">
					<div>{copy.error}{error && <p>{error}</p>}</div>
					<button type="button" className="owl-settings-button" onClick={() => setRefreshKey((key) => key + 1)}>{copy.retry}</button>
				</div>}
				{result?.records.length === 0 && <div className="owl-settings-notice" role="status">{search || status || processing !== "active" ? copy.noMatches : copy.empty}</div>}
				{result?.records.map((record) => (
					<article className="owl-execution-anomaly" key={record.id} aria-label={record.summary}>
						<header className="owl-execution-anomaly-heading">
							<div className="owl-execution-anomaly-heading-main"><span className={`owl-execution-anomaly-status is-${record.status}`}>{copy[record.status]}</span><span className="owl-execution-anomaly-kind">{record.kind === "tool_error" ? copy.toolError : copy.modelError}</span></div>
							<time dateTime={Number.isFinite(record.createdAt) && !Number.isNaN(new Date(record.createdAt).getTime()) ? new Date(record.createdAt).toISOString() : undefined}>{formatTime(record.createdAt)}</time>
						</header>
						<h3>{record.summary}</h3>
						<dl className="owl-execution-anomaly-metadata">
							<div><dt>{copy.session}</dt><dd>{record.sessionName || record.sessionId}</dd></div>
							{(record.provider || record.model) && <div><dt>{copy.model}</dt><dd>{[record.provider, record.model].filter(Boolean).join(" / ")}</dd></div>}
							{record.toolName && <div><dt>{copy.tool}</dt><dd><code>{record.toolName}</code></dd></div>}
							{record.cwd && <div><dt>{copy.workspace}</dt><dd><code>{record.cwd}</code></dd></div>}
						</dl>
						<details className="owl-execution-anomaly-details"><summary>{copy.rawError}</summary><pre>{record.details || record.summary}</pre></details>
						{record.report ? <section className="owl-execution-anomaly-report" aria-label={copy.modelReport}><h4>{copy.modelReport}</h4><dl>
							<div><dt>{copy.cause}</dt><dd>{record.report.cause}</dd></div>
							<div><dt>{copy.action}</dt><dd>{record.report.action}</dd></div>
							<div><dt>{copy.outcome}</dt><dd>{copy[record.report.outcome]}</dd></div>
							<div><dt>{copy.reportedAt}</dt><dd>{formatTime(record.report.reportedAt)}</dd></div>
						</dl></section> : <p className="owl-execution-anomaly-awaiting">{copy.awaitingReport}</p>}
						<ExecutionAnomalyProcessing record={record} client={client} formatTime={formatTime} onChanged={() => setRefreshKey((key) => key + 1)} />
						{onOpenSession && <button type="button" className="owl-settings-button" onClick={() => onOpenSession(record)}>{copy.openSession}</button>}
					</article>
				))}
			</div>
			{result && (offset > 0 || result.total > PAGE_SIZE) && <nav className="owl-execution-anomalies-pagination" aria-label={copy.title}>
				<button type="button" className="owl-settings-button" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>{copy.previous}</button>
				<span>{copy.page(Math.floor(offset / PAGE_SIZE) + 1, Math.max(1, Math.ceil(result.total / PAGE_SIZE)))}</span>
				<button type="button" className="owl-settings-button" disabled={offset + PAGE_SIZE >= result.total} onClick={() => setOffset((value) => value + PAGE_SIZE)}>{copy.next}</button>
			</nav>}
		</>
	);
}
