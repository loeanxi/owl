import { useState } from "react";
import type { EvaluationCategory, EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";
import { CATEGORIES } from "./evaluation-model.ts";
import { IconPlus, IconSearch } from "./EvaluationIcons.tsx";

export function EvaluationLibrary({ tasks, onDetails, onCustom, t }: { tasks: EvaluationTask[]; onDetails: (task: EvaluationTask) => void; onCustom: () => void; t: EvaluationText }): React.JSX.Element {
	const [filter, setFilter] = useState<EvaluationCategory | "all" | "custom">("all");
	const [query, setQuery] = useState("");
	const filtered = tasks.filter((task) => (filter === "all" || filter === "custom" && !task.builtin || task.category === filter) && `${task.id} ${task.title} ${task.prompt}`.toLowerCase().includes(query.toLowerCase()));
	return <div className="eval-page"><div className="eval-toolbar"><div><div className="eval-crumb">{t("title")} / {t("library")}</div><h2 className="eval-page-title">{t("library")}</h2><p className="eval-page-description">{tasks.length} · {t("directHint")}</p></div><span className="eval-spacer" /><button className="eval-button primary" onClick={onCustom}><IconPlus />{t("customTitle")}</button></div>
		<div className="eval-filters">{(["all", ...CATEGORIES, "custom"] as const).map((category) => <button key={category} className={category === filter ? "active" : ""} aria-pressed={category === filter} onClick={() => setFilter(category)}>{t(category)} <small>{tasks.filter((task) => category === "all" || category === "custom" && !task.builtin || task.category === category).length}</small></button>)}<div className="eval-search"><IconSearch /><input placeholder={t("searchTasks")} aria-label={t("searchTasks")} value={query} onChange={(event) => setQuery(event.target.value)} /></div></div>
		<div className="eval-library-grid">{filtered.map((task) => <article className="eval-library-card" key={task.id}><div className="eval-library-art"><span className="eval-pill">{task.id} · {t(task.category)}</span><TaskIllustration category={task.category} /></div><div className="eval-library-info"><h3>{task.title}</h3><p>{task.prompt}</p><div className="eval-library-actions"><span>v{task.version} · {task.builtin ? "Owl" : t("custom")}</span><button className="eval-link" onClick={() => onDetails(task)}>{t("details")}</button></div></div></article>)}</div>{filtered.length === 0 && <div className="eval-empty">{t("noTasks")}</div>}
	</div>;
}

/** Static task-category illustrations describe the library, never pretend to be generated results. */
function TaskIllustration({ category }: { category: EvaluationCategory }): React.JSX.Element {
	return <svg viewBox="0 0 150 90" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{category === "svg" ? <><rect x="23" y="15" width="105" height="65" rx="6" opacity=".25" /><circle cx="53" cy="42" r="14" fill="currentColor" fillOpacity=".15" /><path d="m75 65 18-35 20 35ZM41 68h22" /><circle cx="115" cy="25" r="3" fill="currentColor" /></> : category === "html" ? <><rect x="21" y="15" width="110" height="65" rx="5" /><path d="M21 29h110M42 40h27v29H42ZM80 40h32M80 50h25M80 60h28" opacity=".65" /><circle cx="29" cy="22" r="1" /><circle cx="35" cy="22" r="1" /><circle cx="41" cy="22" r="1" /></> : <><rect x="21" y="15" width="110" height="65" rx="5" opacity=".3" /><path d="m57 34-14 14 14 14m37-28 14 14-14 14m-14-34-10 40" /></>}</svg>;
}
