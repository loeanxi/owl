import { useRef, useState } from "react";
import type { ProviderModelsMessage } from "../bridge/protocol.ts";
import type { TaskRecovery } from "../hooks/task-recovery.ts";
import { useT } from "../i18n/index.ts";
import "./task-recovery.css";

export interface TaskRecoveryNoticeProps {
	recovery?: TaskRecovery;
	providers?: ProviderModelsMessage[];
	model?: string;
	disabled?: boolean;
	onContinue: (model?: string) => Promise<boolean>;
	onOpenSettings?: () => void;
}

export function TaskRecoveryNotice(props: TaskRecoveryNoticeProps): React.JSX.Element | null {
	return props.recovery ? <RecoveryCard key={props.recovery.id} {...props} recovery={props.recovery} /> : null;
}

function RecoveryCard({ recovery, providers = [], model, disabled, onContinue, onOpenSettings }: TaskRecoveryNoticeProps & { recovery: TaskRecovery }): React.JSX.Element {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [choosingModel, setChoosingModel] = useState(false);
	const [selectedModel, setSelectedModel] = useState("");
	const [error, setError] = useState<string>();
	const alternatives = providers.map((provider) => ({ ...provider, models: provider.models.filter((candidate) => `${provider.id}/${candidate.id}` !== model) })).filter((provider) => provider.models.length > 0);
	const resume = async (nextModel?: string): Promise<void> => {
		if (busyRef.current || disabled) return;
		busyRef.current = true;
		setBusy(true);
		setError(undefined);
		try {
			if (!(await onContinue(nextModel))) setError(t("recovery.failed"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	return <section className="owl-task-recovery" aria-label={t("recovery.title")}>
		<strong>{t("recovery.title")}</strong>
		<p>{t("recovery.kept", { n: recovery.completedTools })}</p>
		{recovery.uncertainTools > 0 && <p>{t("recovery.uncertain", { n: recovery.uncertainTools })}</p>}
		<details><summary>{t("recovery.reason")}</summary><p className="owl-task-recovery-reason">{recovery.reason}</p></details>
		<div className="owl-task-recovery-actions">
			<button type="button" className="owl-task-recovery-primary" disabled={disabled || busy} onClick={() => void resume()}>{t(busy ? "recovery.continuing" : "recovery.continue")}</button>
			{alternatives.length > 0 && <button type="button" disabled={disabled || busy} aria-expanded={choosingModel} onClick={() => setChoosingModel((value) => !value)}>{t("recovery.chooseModel")}</button>}
			{onOpenSettings && <button type="button" disabled={busy} onClick={onOpenSettings}>{t("recovery.settings")}</button>}
		</div>
		{choosingModel && <div className="owl-task-recovery-model">
			<label>{t("recovery.model")}<select value={selectedModel} disabled={disabled || busy} onChange={(event) => setSelectedModel(event.target.value)}>
				<option value="">{t("recovery.selectModel")}</option>
				{alternatives.map((provider) => <optgroup key={provider.id} label={provider.name ?? provider.id}>{provider.models.map((candidate) => <option key={candidate.id} value={`${provider.id}/${candidate.id}`}>{candidate.name ?? candidate.id}</option>)}</optgroup>)}
			</select></label>
			<button type="button" disabled={disabled || busy || !selectedModel} onClick={() => void resume(selectedModel)}>{t("recovery.switchContinue")}</button>
		</div>}
		{error && <p role="alert" className="owl-task-recovery-reason">{error}</p>}
	</section>;
}
