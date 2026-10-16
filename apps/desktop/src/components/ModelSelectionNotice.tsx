import type { ProviderModelsMessage } from "../bridge/protocol.ts";
import type { ModelSelectionFeedback } from "../hooks/use-model-selection.ts";
import { useModelSelectionText } from "./model-selection-copy.ts";
import "./model-selection.css";
import "./composer-feedback.css";

export function ModelSelectionNotice({ feedback, providers, onRetry }: { feedback?: ModelSelectionFeedback; providers: ProviderModelsMessage[]; onRetry?: () => void }): React.JSX.Element | null {
	const text = useModelSelectionText();
	if (!feedback) return null;
	const model = feedback.status === "pending" ? feedback.target : feedback.actual;
	const separator = model.indexOf("/");
	const entry = providers.find((provider) => provider.id === model.slice(0, separator))?.models.find((item) => item.id === model.slice(separator + 1));
	const name = entry?.name ?? model;
	const error = feedback.error ?? text("unconfirmed");
	const compactError = error.trim().split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
	const settled = feedback.status === "confirmed" || feedback.status === "selected";
	const details = <details className="owl-composer-notice-details" key={`${feedback.status}:${feedback.target}:${feedback.actual}`}>
		<summary>{text("details")}</summary>
		<div className="owl-composer-notice-body">
			{feedback.status === "error" && <pre>{error}</pre>}
			<p>{text("requested", { model: feedback.target })}</p>
			{(feedback.status === "pending" || feedback.status === "error") && feedback.actual && <p>{text("previous", { model: feedback.actual })}</p>}
			{feedback.status === "confirmed" && <p>{text("confirmed", { model: feedback.actual })}</p>}
			{feedback.status !== "selected" && <p>{text(feedback.running ? "running" : "idle")}</p>}
			{feedback.status !== "error" && entry && <p>{[entry.contextWindow ? text("capacity", { n: entry.contextWindow.toLocaleString() }) : undefined, entry.input ? text(entry.input.includes("image") ? "images" : "textOnly") : undefined].filter(Boolean).join(" · ")}</p>}
		</div>
	</details>;
	return <div className={`owl-model-selection is-${feedback.status}${settled ? " is-settled" : ""}`} role={feedback.status === "error" ? "alert" : "status"} aria-busy={feedback.status === "pending"}>
		<div className="owl-composer-notice-head">
			<div className="owl-composer-notice-summary">
				<strong>{feedback.status === "error" ? text("failed") : text(feedback.status, { model: name })}</strong>
				{feedback.status === "error" && <span>{compactError.length > 120 ? `${compactError.slice(0, 120)}…` : compactError}</span>}
			</div>
			{feedback.status === "error" && onRetry && <div className="owl-composer-notice-actions"><button type="button" onClick={onRetry}>{text("retry")}</button></div>}
			{settled && details}
		</div>
		{!settled && details}
	</div>;
}
