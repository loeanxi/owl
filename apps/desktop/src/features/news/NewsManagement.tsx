import { useEffect, useState } from "react";
import type {
	NewsCapability,
	NewsConfiguration,
	NewsEvaluation,
	NewsEvaluationSample,
	NewsSnapshot,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { useT } from "../../i18n/index.ts";
import { NewsModelTest } from "./NewsModelTest.tsx";
import { downloadNews, errorText, type NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";

const CAPABILITIES: NewsCapability[] = [
	"prefilter",
	"score",
	"structure",
	"understand",
	"summarize",
	"group",
	"groupReview",
	"digest",
	"report",
	"translate",
	"assistant",
];
const SECRET_KEYS = ["SOCIALDATA_API_KEY", "DAJIALA_KEY", "EMBEDDING_API_KEY", "GITHUB_TOKEN", "ingest"];

export function NewsManagement({
	api,
	snapshot,
	section,
	revision,
	onChanged,
	onOpenModelSettings,
}: {
	api: NewsClient;
	snapshot: NewsSnapshot;
	section: "configuration" | "operations" | "evaluation" | "exports";
	revision: number;
	onChanged: () => void;
	onOpenModelSettings: () => void;
}): React.JSX.Element {
	const t = useT();
	const [config, setConfig] = useState<NewsConfiguration>(() => structuredClone(snapshot.configuration));
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [samplesText, setSamplesText] = useState("");
	const [evaluation, setEvaluation] = useState<NewsEvaluation>();
	const [backup, setBackup] = useState<{ path: string; createdAt: string }>();
	const [fulltext, setFulltext] = useState(false);
	const [exportMode, setExportMode] = useState<"selected" | "all" | "saved">("selected");
	async function perform(operation: () => Promise<unknown>, message = t("common.done")): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await operation();
			setNotice(message);
			onChanged();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	}
	const titles = {
		configuration: t("news.configuration"),
		operations: t("news.operations"),
		evaluation: t("news.evaluation"),
		exports: t("news.exports"),
	};
	return (
		<section>
			<div className="owl-news-heading">
				<div>
					<h1>{titles[section]}</h1>
					<p>{t("news.managementHint")}</p>
				</div>
			</div>
			{error && (
				<p className="owl-news-error" role="alert">
					{error}
				</p>
			)}
			{notice && (
				<p className="owl-news-notice" aria-live="polite">
					{notice}
				</p>
			)}
			{section === "configuration" && (
				<form
					className="owl-news-form"
					onSubmit={(event) => {
						event.preventDefault();
						void perform(async () => {
							const saved = await api.query({
								action: "configure",
								patch: config,
								secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim())),
							});
							setConfig(saved);
							setSecrets({});
						}, t("common.saved"));
					}}
				>
					<fieldset disabled={busy}>
						<legend>{t("news.switches")}</legend>
						<div className="owl-news-checks">
							<label>
								<input
									type="checkbox"
									checked={config.collectEnabled}
									onChange={(event) => setConfig({ ...config, collectEnabled: event.target.checked })}
								/>
								{t("news.collectEnabled")}
							</label>
							<label>
								<input
									type="checkbox"
									checked={config.modelCallsEnabled}
									onChange={(event) => setConfig({ ...config, modelCallsEnabled: event.target.checked })}
								/>
								{t("news.modelsEnabled")}
							</label>
						</div>
						<div className="owl-news-grid">
							{(["intervalMinutes", "maxItemsPerSource", "retentionDays", "understandFloor"] as const).map(
								(key) => (
									<label key={key}>
										{t(`news.${key}`)}
										<input
											type="number"
											required
											min={key === "understandFloor" ? 0 : 1}
											value={config[key]}
											onChange={(event) => setConfig({ ...config, [key]: Number(event.target.value) })}
										/>
									</label>
								),
							)}
						</div>
					</fieldset>
					<fieldset disabled={busy}>
						<legend>{t("news.processingModels")}</legend>
						<p className="owl-news-muted">{t("news.modelsHint")}</p>
						<div className="owl-news-grid">
							{CAPABILITIES.map((capability) => (
								<label key={capability}>
									{t(`news.capability.${capability}`)}
									<select
										aria-label={t(`news.capability.${capability}`)}
										value={
											config.models[capability]
												? `${config.models[capability]?.provider}/${config.models[capability]?.id}`
												: ""
										}
										onChange={(event) => {
											const next = { ...config.models };
											const selectedModel = snapshot.models.find(
												(model) => `${model.provider}/${model.id}` === event.target.value,
											);
											if (selectedModel)
												next[capability] = { provider: selectedModel.provider, id: selectedModel.id };
											else delete next[capability];
											setConfig({ ...config, models: next });
										}}
									>
										<option value="">{t("news.defaultModel")}</option>
										{snapshot.models.map((model) => (
											<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
												{model.name} · {model.provider}
											</option>
										))}
									</select>
								</label>
							))}
						</div>
						<NewsModelTest
							api={api}
							model={config.models.assistant}
							modelName={snapshot.models.find((model) => model.provider === config.models.assistant?.provider && model.id === config.models.assistant?.id)?.name}
							disabled={busy}
							draft
							onBusyChange={setBusy}
						/>
						<div className="owl-news-actions">
							<button type="button" disabled={busy} onClick={onOpenModelSettings}>{t("news.manageModelServices")}</button>
						</div>
					</fieldset>
					<fieldset disabled={busy}>
						<legend>{t("news.thresholds")}</legend>
						<div className="owl-news-grid">
							{(["T1", "T1_5", "T2", "EXCLUDE_MP"] as const).map((tier) => (
								<label key={tier}>
									{tier}
									<input
										type="number"
										min={0}
										max={100}
										value={config.thresholds[tier] ?? ""}
										placeholder={t("news.excluded")}
										onChange={(event) =>
											setConfig({
												...config,
												thresholds: {
													...config.thresholds,
													[tier]: event.target.value === "" ? null : Number(event.target.value),
												},
											})
										}
									/>
								</label>
							))}
						</div>
					</fieldset>
					<fieldset disabled={busy}>
						<legend>{t("news.budget")}</legend>
						<p className="owl-news-muted">{t("news.budgetHint")}</p>
						<div className="owl-news-grid">
							{(["perMinute", "perHour", "perDay"] as const).map((key) => (
								<label key={key}>
									{t(`news.${key}`)}
									<input
										type="number"
										required
										min={0}
										value={config.budget[key]}
										onChange={(event) =>
											setConfig({
												...config,
												budget: { ...config.budget, [key]: Number(event.target.value) },
											})
										}
									/>
								</label>
							))}
						</div>
					</fieldset>
					<fieldset disabled={busy}>
						<legend>{t("news.embedding")}</legend>
						<label className="owl-news-check">
							<input
								type="checkbox"
								checked={config.embedding.enabled}
								onChange={(event) =>
									setConfig({ ...config, embedding: { ...config.embedding, enabled: event.target.checked } })
								}
							/>
							{t("news.enableEmbedding")}
						</label>
						<div className="owl-news-grid">
							<label>
								{t("news.baseUrl")}
								<input
									type="url"
									value={config.embedding.baseUrl}
									onChange={(event) =>
										setConfig({ ...config, embedding: { ...config.embedding, baseUrl: event.target.value } })
									}
								/>
							</label>
							<label>
								{t("news.modelId")}
								<input
									value={config.embedding.model}
									onChange={(event) =>
										setConfig({ ...config, embedding: { ...config.embedding, model: event.target.value } })
									}
								/>
							</label>
							<label>
								{t("news.dimensions")}
								<input
									type="number"
									min={1}
									value={config.embedding.dimensions ?? ""}
									onChange={(event) =>
										setConfig({
											...config,
											embedding: {
												...config.embedding,
												dimensions: event.target.value ? Number(event.target.value) : null,
											},
										})
									}
								/>
							</label>
						</div>
					</fieldset>
					<fieldset disabled={busy}>
						<legend>{t("news.serviceKeys")}</legend>
						<p className="owl-news-muted">{t("news.secretHint")}</p>
						<div className="owl-news-grid">
							{SECRET_KEYS.map((key) => (
								<label key={key}>
									{key === "ingest" ? t("news.ingestKey") : key}
									<span className="owl-news-muted">
										{snapshot.configuration.serviceStatus[key]
											? t("news.configured")
											: t("news.notConfigured")}
									</span>
									<input
										type="password"
										minLength={key === "ingest" ? 16 : undefined}
										autoComplete="new-password"
										value={secrets[key] ?? ""}
										onChange={(event) => setSecrets({ ...secrets, [key]: event.target.value })}
										placeholder={t("news.replaceKey")}
									/>
								</label>
							))}
						</div>
					</fieldset>
					<fieldset disabled={busy}>
						<legend>{t("news.network")}</legend>
						<label className="owl-news-check">
							<input
								type="checkbox"
								checked={config.allowPrivateNetwork}
								onChange={(event) => setConfig({ ...config, allowPrivateNetwork: event.target.checked })}
							/>
							{t("news.allowPrivate")}
						</label>
						<p className="owl-news-muted">{t("news.privateHint")}</p>
					</fieldset>
					<button type="submit" className="owl-news-primary" disabled={busy}>
						{t("common.save")}
					</button>
				</form>
			)}
			{section === "operations" && <NewsRuns api={api} revision={revision} busy={busy} perform={perform} />}
			{section === "evaluation" && (
				<>
					<form
						className="owl-news-form"
						onSubmit={(event) => {
							event.preventDefault();
							void perform(async () => {
								const samples = JSON.parse(samplesText) as NewsEvaluationSample[];
								if (!Array.isArray(samples) || !samples.length) throw new Error(t("news.samplesRequired"));
								setEvaluation(await api.query({ action: "evaluate", samples }));
							});
						}}
					>
						<label>
							{t("news.samples")}
							<textarea
								rows={9}
								value={samplesText}
								onChange={(event) => setSamplesText(event.target.value)}
								placeholder='[{"id":"sample-1","tier":"T1","gold":"select","material":{"title":"...","url":"https://...","body":"..."}}]'
							/>
						</label>
						<p className="owl-news-muted">{t("news.samplesHint")}</p>
						<button type="submit" disabled={busy || !samplesText.trim()} className="owl-news-primary">
							{busy ? t("common.processing") : t("news.runEvaluation")}
						</button>
					</form>
					{evaluation && <EvaluationResult value={evaluation} />}
					<NewsEvaluations api={api} revision={revision} onSelect={setEvaluation} />
				</>
			)}
			{section === "exports" && (
				<div className="owl-news-form">
					<label>
						{t("news.exportScope")}
						<select
							value={exportMode}
							onChange={(event) => setExportMode(event.target.value as typeof exportMode)}
						>
							<option value="selected">{t("news.selected")}</option>
							<option value="all">{t("news.all")}</option>
							<option value="saved">{t("news.saved")}</option>
						</select>
					</label>
					<label className="owl-news-check">
						<input type="checkbox" checked={fulltext} onChange={(event) => setFulltext(event.target.checked)} />
						{t("news.exportFulltext")}
					</label>
					<div className="owl-news-actions">
						{(["markdown", "json", "rss"] as const).map((format) => (
							<button
								key={format}
								type="button"
								disabled={busy}
								onClick={() =>
									void perform(async () => {
										const output = await api.query({
											action: "export",
											format,
											fulltext,
											query: { mode: exportMode },
										});
										downloadNews(output.content, output.filename, output.mimeType);
									})
								}
							>
								{t("news.export")} {format.toUpperCase()}
							</button>
						))}
					</div>
					<h2>{t("news.backup")}</h2>
					<p className="owl-news-muted">{t("news.backupHint")}</p>
					<button
						type="button"
						disabled={busy}
						onClick={() => void perform(async () => setBackup(await api.query({ action: "backup" })))}
					>
						{t("news.createBackup")}
					</button>
					{backup && (
						<p aria-live="polite">
							{backup.createdAt}
							<br />
							<code>{backup.path}</code>
						</p>
					)}
				</div>
			)}
		</section>
	);
}

function NewsRuns({
	api,
	revision,
	busy,
	perform,
}: {
	api: NewsClient;
	revision: number;
	busy: boolean;
	perform: (operation: () => Promise<unknown>, message?: string) => Promise<void>;
}): React.JSX.Element {
	const t = useT();
	const [pollRevision, setPollRevision] = useState(0);
	const [retryReceiptId, setRetryReceiptId] = useState<string>();
	useEffect(() => {
		const timer = setInterval(() => setPollRevision((current) => current + 1), 10_000);
		return () => clearInterval(timer);
	}, []);
	const jobs = useNewsQuery(api, { action: "jobs", limit: 100 }, revision + pollRevision);
	const receipts = useNewsQuery(api, { action: "receipts", limit: 100 }, revision + pollRevision);
	return (
		<>
			<div className="owl-news-actions">
				<button
					type="button"
					disabled={busy}
					onClick={() => void perform(() => api.query({ action: "run" }), t("news.queued"))}
				>
					{t("news.collectNow")}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => void perform(() => api.query({ action: "retry" }), t("news.queued"))}
				>
					{t("news.retryFailed")}
				</button>
			</div>
			<h2>{t("news.jobs")}</h2>
			{jobs.loading && <p>{t("news.loading")}</p>}
			{jobs.error && (
				<p role="alert" className="owl-news-error">
					{jobs.error}
				</p>
			)}
			{jobs.data?.length === 0 && <p className="owl-news-empty">{t("news.noJobs")}</p>}
			<div className="owl-news-records">
				{jobs.data?.map((job) => (
					<article key={job.id}>
						<div>
							<strong>
								{job.kind} · {job.subject}
							</strong>
							<small>
								{t(`news.status.${job.status}`)} · {job.attempts} · {new Date(job.updatedAt).toLocaleString()}
							</small>
							{job.error && <p className="owl-news-error">{job.error}</p>}
						</div>
						{job.status === "failed" && (
							<button
								type="button"
								disabled={busy}
								onClick={() =>
									void perform(() => api.query({ action: "retry", jobId: job.id }), t("news.queued"))
								}
							>
								{t("news.retry")}
							</button>
						)}
					</article>
				))}
			</div>
			<h2>{t("news.receipts")}</h2>
			{receipts.loading && <p>{t("news.loading")}</p>}
			{receipts.error && (
				<p role="alert" className="owl-news-error">
					{receipts.error}
				</p>
			)}
			{receipts.data?.length === 0 && <p className="owl-news-empty">{t("news.noReceipts")}</p>}
			<div className="owl-news-records">
				{receipts.data?.map((receipt) => (
					<article key={receipt.id}>
						<div>
							<strong>
								{receipt.capability} · {receipt.model}
							</strong>
							<small>
								{t(`news.status.${receipt.status}`)} · {receipt.attempts} ·{" "}
								{new Date(receipt.createdAt).toLocaleString()}
							</small>
							{receipt.usage && (
								<small>
									{t("news.usage", {
										input: receipt.usage.input,
										output: receipt.usage.output,
										cache: receipt.usage.cacheRead + receipt.usage.cacheWrite,
									})}
								</small>
							)}
							{receipt.error && <p className="owl-news-error">{receipt.error}</p>}
						</div>
						{(receipt.status === "unknown" || receipt.status === "failed") && (
							<button type="button" disabled={busy} onClick={() => setRetryReceiptId(receipt.id)}>
								{t("news.retryReceipt")}
							</button>
						)}
					</article>
				))}
			</div>
			{retryReceiptId && (
				<div className="owl-news-confirm">
					<p>{t("news.retryReceiptHint")}</p>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void perform(async () => {
								await api.query({ action: "retry", receiptId: retryReceiptId });
								setRetryReceiptId(undefined);
							}, t("news.queued"))
						}
					>
						{t("news.confirmRetryReceipt")}
					</button>
					<button type="button" disabled={busy} onClick={() => setRetryReceiptId(undefined)}>
						{t("common.cancel")}
					</button>
				</div>
			)}
		</>
	);
}

function NewsEvaluations({
	api,
	revision,
	onSelect,
}: {
	api: NewsClient;
	revision: number;
	onSelect: (value: NewsEvaluation) => void;
}): React.JSX.Element {
	const t = useT();
	const result = useNewsQuery(api, { action: "evaluations" }, revision);
	return (
		<>
			<h2>{t("news.evaluationHistory")}</h2>
			{result.error && (
				<p role="alert" className="owl-news-error">
					{result.error}
				</p>
			)}
			{result.loading && <p>{t("news.loading")}</p>}
			{result.data?.length === 0 && <p className="owl-news-empty">{t("news.noEvaluations")}</p>}
			{result.data?.map((entry) => (
				<button key={entry.id} type="button" className="owl-news-history" onClick={() => onSelect(entry)}>
					{new Date(entry.createdAt).toLocaleString()} · {entry.count} · {(entry.accuracy * 100).toFixed(1)}%
				</button>
			))}
		</>
	);
}

function EvaluationResult({ value }: { value: NewsEvaluation }): React.JSX.Element {
	const t = useT();
	return (
		<div className="owl-news-evaluation">
			<div className="owl-news-metrics">
				<span>
					{t("news.accuracy")} {(value.accuracy * 100).toFixed(1)}%
				</span>
				<span>
					{t("news.precision")} {(value.precision * 100).toFixed(1)}%
				</span>
				<span>
					{t("news.recall")} {(value.recall * 100).toFixed(1)}%
				</span>
			</div>
			<table>
				<thead>
					<tr>
						<th>{t("news.sampleId")}</th>
						<th>{t("news.gold")}</th>
						<th>{t("news.selection")}</th>
						<th>{t("news.score")}</th>
					</tr>
				</thead>
				<tbody>
					{value.cases.map((entry) => (
						<tr key={entry.id}>
							<td>
								{entry.id}
								{entry.error && <p className="owl-news-error">{entry.error}</p>}
							</td>
							<td>{entry.gold}</td>
							<td>{entry.selected ? t("news.selected") : t("news.rejected")}</td>
							<td>{entry.score ?? "—"}</td>
						</tr>
					))}
				</tbody>
			</table>
			<h3>{t("news.thresholdComparison")}</h3>
			<table>
				<thead>
					<tr>
						<th>{t("news.threshold")}</th>
						<th>{t("news.precision")}</th>
						<th>{t("news.recall")}</th>
					</tr>
				</thead>
				<tbody>
					{value.thresholds.map((entry) => (
						<tr key={entry.threshold}>
							<td>{entry.threshold}</td>
							<td>{(entry.precision * 100).toFixed(1)}%</td>
							<td>{(entry.recall * 100).toFixed(1)}%</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
