import { useState } from "react";
import type { EvaluationRunSummary } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { IconClock, IconPlus, IconSearch } from "./EvaluationIcons.tsx";

export function EvaluationHistory({ runs, t, onOpen, onNew }: { runs: EvaluationRunSummary[]; t: EvaluationText; onOpen: (id: string) => void; onNew: () => void }): React.JSX.Element {
	const [query, setQuery] = useState("");
	const filtered = runs.filter((run) => run.name.toLowerCase().includes(query.toLowerCase()));
	return <div className="eval-page"><div className="eval-toolbar"><div><div className="eval-crumb">{t("title")} / {t("history")}</div><h2 className="eval-page-title">{t("history")}</h2><p className="eval-page-description">{t("historyDesc")}</p></div><span className="eval-spacer" /><button className="eval-button primary" onClick={onNew}><IconPlus />{t("newRun")}</button></div><div className="eval-filters"><span className="eval-muted">{t("historyCount", { n: runs.length })}</span><div className="eval-search"><IconSearch /><input aria-label={t("searchRuns")} placeholder={t("searchRuns")} value={query} onChange={(event) => setQuery(event.target.value)} /></div></div>
		{filtered.length > 0 ? <div className="eval-table-wrap"><table className="eval-table"><thead><tr><th>{t("runName")}</th><th>{t("createdAt")}</th><th>{t("runStatus")}</th><th>{t("calls")}</th><th>{t("manual")}</th><th /></tr></thead><tbody>{filtered.map((run) => <tr key={run.id}><td><strong>{run.name}</strong><small>{t("scope", { tasks: run.taskCount, profiles: run.profileCount, samples: run.samples })}</small></td><td>{new Date(run.createdAt).toLocaleString()}</td><td><span className={`eval-pill ${run.status === "completed" ? "success" : ""}`}>{t(run.status)}</span>{run.failed > 0 && <small>{t("failed")}: {run.failed}</small>}</td><td>{run.completed} / {run.total}<small>{t("completed")}</small></td><td>{run.rated} / {run.total}<small>{t("scoredCount")}</small></td><td><button className="eval-link" onClick={() => onOpen(run.id)}>{t("open")}</button></td></tr>)}</tbody></table></div> : <div className="eval-empty"><IconClock /><h2>{t("emptyHistory")}</h2><p>{t("historyDesc")}</p></div>}
	</div>;
}
