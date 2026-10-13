import { useMemo } from "react";
import { isResearchTaskRecord, type ResearchTaskRecord } from "../../../../../packages/coding-agent/src/core/research/task-state.ts";
import { useResearchText } from "./research-copy.ts";

const statusKeys = { needs_input: "taskNeedsInput", in_progress: "taskInProgress", partial: "taskPartial", blocked: "taskBlocked", unverified: "taskUnverified" } as const;
const factKeys = { target: "taskFactTarget", function: "taskFactFunction", environment: "taskFactEnvironment", dataSource: "taskFactDataSource", authorization: "taskFactAuthorization", deliverable: "taskFactDeliverable", acceptance: "taskFactAcceptance" } as const;
const responseKeys = { not_started: "taskResponseNotStarted", received: "taskResponseReceived", declined_candidate: "taskResponseDeclined", provider_refused: "taskResponseRefused", error: "taskResponseError", cancelled: "taskResponseCancelled" } as const;
const acceptanceKeys = { not_run: "taskAcceptanceNotRun", partial: "taskAcceptancePartial", failed: "taskAcceptanceFailed" } as const;

/** Render session-owned facts and measured checks without promoting them to verified task completion. */
export function ResearchTaskNotice({ task: taskValue, sessionId, running }: { task?: ResearchTaskRecord; sessionId?: string; running: boolean }): React.JSX.Element | null {
	const text = useResearchText();
	const task = useMemo(() => sessionId && isResearchTaskRecord(taskValue, sessionId) ? taskValue : undefined, [taskValue, sessionId]);
	if (!task) return null;
	const selected = task.modelFit.selected;
	const passed = task.acceptance.checks.filter((check) => check.status === "passed").length;
	const attachedPaths = [...new Set(task.inputs.flatMap((input) => input.attachedPaths ?? []))];
	const imageCount = task.inputs.reduce((count, input) => count + (input.imageCount ?? 0), 0);
	const hasLaterText = task.inputs.some((input) => input.text.trim());
	return <section className="research-diagnosis research-task" role="status" aria-label={text("taskTitle")} data-state={task.status}>
		<div className="research-diagnosis-heading"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M5 3h10v14H5zM8 7h4M8 10h4M8 13h2" /></svg><strong>{text(statusKeys[task.status])}</strong>{running && <span className="research-task-processing">{text("taskProcessing")}</span>}</div>
		<p className="research-task-summary">{text(responseKeys[task.response.state])} · {text(acceptanceKeys[task.acceptance.state])}</p>
		{task.missingMaterials.length > 0 && <p className="research-task-missing">{text("taskMissingMaterials")}：{task.missingMaterials.slice(0, 3).join("；")}{task.missingMaterials.length > 3 ? ` · ${text("taskMoreMaterials", { n: task.missingMaterials.length - 3 })}` : ""}</p>}
		<details><summary>{text("taskDetails")}</summary><div className="research-diagnosis-evidence research-task-details">
			<section><h3>{text("taskOriginalRequest")}</h3><p>{task.originalRequest.trim() ? task.originalRequest : text(hasLaterText ? "taskAttachmentsThenText" : "taskAttachmentsOnly")}</p>{task.inputs.some((input) => input.truncated) && <p className="research-task-muted">{text("taskInputTruncated")}</p>}{attachedPaths.length > 0 && <><h4>{text("taskAttachedPaths")}</h4><ul>{attachedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></>}{imageCount > 0 && <p>{text("taskAttachedImages", { n: imageCount })}</p>}{(attachedPaths.length > 0 || imageCount > 0) && <p className="research-task-muted">{text("taskAttachmentLimit")}</p>}</section>
			<section><h3>{text("taskFacts")}</h3><dl className="research-task-facts">{(Object.keys(factKeys) as (keyof typeof factKeys)[]).map((field) => {
				const fact = task.facts[field];
				return <div key={field}><dt>{text(factKeys[field])}</dt><dd>{fact.state === "user_stated" ? <>{fact.value}<small>{text("taskFactUserStated")}</small></> : text(fact.state === "unreviewed" ? "taskFactUnreviewed" : "taskFactUnknown")}{fact.evidence.map((evidence, index) => <blockquote key={index}>{evidence.quote}</blockquote>)}</dd></div>;
			})}</dl></section>
			{task.missingMaterials.length > 0 && <section><h3>{text("taskMissingMaterials")}</h3><ul>{task.missingMaterials.map((material, index) => <li key={index}>{material}</li>)}</ul></section>}
			<section><h3>{text("taskTools")}</h3>{task.toolMatches.length > 0 ? task.toolMatches.map((match, index) => <article key={index}><strong>{match.operation}</strong>{match.requestedTools.length > 0 && <p>{text("taskRequestedTools")}：{match.requestedTools.join("、")}</p>}<p>{text("taskRegisteredTools")}：{match.registeredTools.length > 0 ? match.registeredTools.join("、") : text("taskNoneRegistered")}</p>{match.unavailableTools.length > 0 && <p>{text("taskUnavailableTools")}：{match.unavailableTools.join("、")}</p>}</article>) : <p>{text("taskToolsUnreviewed")}</p>}<p className="research-task-muted">{text("taskToolAvailabilityLimit")}</p></section>
			<section><h3>{text("taskModelFit")}</h3><p>{selected ? `${selected.provider}/${selected.id} · ${text(selected.inputCompatible ? "taskInputCompatible" : "taskInputIncompatible")}` : text("taskModelUnknown")}</p><p>{task.modelFit.basis}</p>{task.modelFit.candidates.length > 0 && <><h4>{text("taskModelCandidates")}</h4><ul>{task.modelFit.candidates.map((candidate, index) => <li key={index}>{candidate.provider}/{candidate.id} · {text(candidate.inputCompatible ? "taskInputCompatible" : "taskInputIncompatible")}</li>)}</ul></>}<p className="research-task-muted">{text("taskModelFitLimit")}</p></section>
			<section><h3>{text("taskResponse")}</h3><p>{text(responseKeys[task.response.state])}</p>{task.response.provider && task.response.model && <p className="research-task-muted">{task.response.provider}/{task.response.model}</p>}{task.response.summary && <p>{task.response.summary}</p>}</section>
			<section><h3>{text("taskAcceptance")}</h3><p>{text(acceptanceKeys[task.acceptance.state])}{task.acceptance.checks.length > 0 ? ` · ${text("taskChecksPassed", { passed, total: task.acceptance.checks.length })}` : ""}</p>{task.acceptance.checks.map((check) => <article key={check.id}><strong>{text(check.status === "passed" ? "taskCheckPassed" : "taskCheckFailed")} · {check.criterion}</strong><p>{check.summary}</p><p className="research-task-muted">{text("taskVerifier")}：{check.verifier}</p><code>{check.artifactPath}</code>{check.artifactSha256 && <code>SHA256 {check.artifactSha256}</code>}</article>)}<p className="research-task-muted">{text("taskGoalUnverified")}</p></section>
		</div></details>
	</section>;
}
