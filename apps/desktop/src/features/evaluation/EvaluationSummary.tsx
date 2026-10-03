import { useState } from "react";
import type { EvaluationCategory, EvaluationRunView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { CATEGORIES, evaluationStatistics } from "./evaluation-model.ts";

export function EvaluationSummary({ run, t, onResults }: { run: EvaluationRunView; t: EvaluationText; onResults: () => void }): React.JSX.Element {
	const [category, setCategory] = useState<EvaluationCategory>("svg");
	const rows = evaluationStatistics(run, category);
	const count = rows.reduce((sum, row) => sum + row.count, 0);
	const scored = rows.reduce((sum, row) => sum + row.scored, 0);
	const scoreTotal = rows.reduce((sum, row) => sum + row.scoreTotal, 0);
	const passed = rows.reduce((sum, row) => sum + row.passed, 0);
	const checked = rows.reduce((sum, row) => sum + row.checked, 0);
	const costTotal = rows.reduce((sum, row) => sum + row.costTotal, 0);
	const knownCosts = rows.reduce((sum, row) => sum + row.costCount, 0);
	const hidden = run.results.filter((result) => !result.revealed).length;
	return <div className="eval-page"><div className="eval-toolbar"><div><div className="eval-crumb">{run.name} / {t("summary")}</div><h2 className="eval-page-title">{t("summary")}</h2><p className="eval-page-description">{t("summaryDesc")}</p></div><span className="eval-spacer" /><button className="eval-button" onClick={onResults}>{t("results")}</button></div>
		<div className="eval-filters">{CATEGORIES.map((value) => <button key={value} className={value === category ? "active" : ""} aria-pressed={value === category} onClick={() => setCategory(value)}>{t(value)}</button>)}<span className="eval-spacer" /><span className="eval-muted">{t("sampleCount")}: {count}</span></div>
		<div className="eval-kpis"><div className="eval-kpi"><small>{t("sampleCount")}</small><strong>{count}</strong><small>{t(category)}</small></div><div className="eval-kpi"><small>{t("automaticPass")}</small><strong>{checked ? `${passed} / ${checked}` : "—"}</strong><small>{t("uncheckedCount")}: {rows.reduce((sum, row) => sum + row.unchecked, 0)}</small></div><div className="eval-kpi"><small>{t("manualAverage")}</small><strong>{scored ? (scoreTotal / scored).toFixed(2) : "—"}</strong><small>{t("scoredCount")}: {scored} / {count}</small></div><div className="eval-kpi"><small>{t("knownCost")}</small><strong>{knownCosts ? `US$${costTotal.toFixed(4)}` : t("unknown")}</strong><small>{t("partialCost", { n: count - knownCosts })}</small></div></div>
		{rows.length > 0 ? <div className="eval-table-wrap"><table className="eval-table"><thead><tr><th>{t("model")}</th><th>{t("sampleCount")}</th><th>{t("automaticPass")}</th><th>{t("manualAverage")}</th><th>{t("averageTime")}</th><th>{t("knownCost")}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td><strong>{row.name}</strong><small>{row.thinkingLevel === "default" ? t("defaultThinking") : row.thinkingLevel}</small></td><td>{row.count}<small>{t("failures")}: {row.failed}</small></td><td>{row.checked ? `${row.passed} / ${row.checked}` : "—"}<small>{t("uncheckedCount")}: {row.unchecked}</small></td><td>{row.scored ? `${(row.scoreTotal / row.scored).toFixed(2)} / 5` : "—"}<small>{t("scoredCount")}: {row.scored} / {row.count}</small></td><td>{row.durationCount ? t("seconds", { n: (row.durationTotal / row.durationCount / 1000).toFixed(1) }) : t("unknown")}<small>{t("partialTime", { n: row.count - row.durationCount })}</small></td><td>{row.costCount ? `US$${row.costTotal.toFixed(5)}` : t("unknown")}<small>{t("partialCost", { n: row.count - row.costCount })}</small></td></tr>)}</tbody></table></div> : <div className="eval-empty">{t("noSummary")}</div>}
		{hidden > 0 && <p className="eval-page-description" style={{ marginTop: 15 }}>{t("summaryHidden")} ({hidden})</p>}
	</div>;
}
