import { useEffect, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ExecutionAnomalyProcessingKind, ExecutionAnomalyRecord } from "../../bridge/protocol.ts";
import { useExecutionAnomaliesCopy } from "./execution-anomalies-copy.ts";

export function ExecutionAnomalyProcessing({ record, client, formatTime, onChanged }: {
	record: ExecutionAnomalyRecord;
	client: BridgeClient;
	formatTime: (value: number) => string;
	onChanged: () => void;
}): React.JSX.Element {
	const copy = useExecutionAnomaliesCopy();
	const [kind, setKind] = useState<ExecutionAnomalyProcessingKind | null>(null);
	const [note, setNote] = useState("");
	const [verification, setVerification] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (record.processing) setKind(null);
	}, [record.processing]);

	async function save(): Promise<void> {
		if (!kind || busy) return;
		const trimmedNote = note.trim();
		const trimmedVerification = verification.trim();
		if (!trimmedNote || !trimmedVerification) {
			setError(copy.processingRequired);
			return;
		}
		setBusy(true);
		setError("");
		try {
			const response = await client.processExecutionAnomaly({ id: record.id, kind, note: trimmedNote, verification: trimmedVerification });
			if (!response.ok || !response.result) throw new Error(response.error || copy.processingSaveError);
			setKind(null);
			onChanged();
		} catch (reason: unknown) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	async function restore(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await client.restoreExecutionAnomaly(record.id);
			if (!response.ok || !response.result) throw new Error(response.error || copy.processingRestoreError);
			setKind(null);
			onChanged();
		} catch (reason: unknown) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	return <section className="owl-execution-anomaly-processing" aria-label={copy.processingTitle}>
		{record.processing ? <>
			<h4>{copy.processingKinds[record.processing.kind]}</h4>
			<dl>
				<div><dt>{copy.processingNote}</dt><dd>{record.processing.note}</dd></div>
				<div><dt>{copy.processingVerification}</dt><dd>{record.processing.verification}</dd></div>
				<div><dt>{copy.processedAt}</dt><dd>{formatTime(record.processing.processedAt)}</dd></div>
			</dl>
			<button type="button" className="owl-settings-button" disabled={busy} onClick={() => void restore()}>{busy ? copy.processingSaving : copy.processingRestore}</button>
		</> : kind ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
			<fieldset disabled={busy}>
				<legend>{copy.processingActions[kind]}</legend>
				<p className="owl-execution-anomaly-processing-hint">{copy.processingHint}</p>
				<label><span>{copy.processingNote}</span><textarea required maxLength={4000} rows={3} value={note} onChange={(event) => setNote(event.currentTarget.value)} /></label>
				<label><span>{copy.processingVerification}</span><textarea required maxLength={4000} rows={3} value={verification} onChange={(event) => setVerification(event.currentTarget.value)} /></label>
				<div className="owl-execution-anomaly-processing-actions">
					<button type="submit" className="owl-settings-button" disabled={!note.trim() || !verification.trim()}>{busy ? copy.processingSaving : copy.processingSave}</button>
					<button type="button" className="owl-settings-button" onClick={() => { setKind(null); setError(""); }}>{copy.processingCancel}</button>
				</div>
			</fieldset>
		</form> : <div className="owl-execution-anomaly-processing-actions">
			{(["optimized", "dismissed"] as const).map((value) => <button key={value} type="button" className="owl-settings-button" disabled={busy} onClick={() => { setKind(value); setNote(""); setVerification(""); setError(""); }}>{copy.processingActions[value]}</button>)}
		</div>}
		{error && <p className="owl-settings-notice is-error" role="alert">{error}</p>}
	</section>;
}
