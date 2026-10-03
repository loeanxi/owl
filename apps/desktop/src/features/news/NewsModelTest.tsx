import { useEffect, useRef, useState } from "react";
import type {
	NewsModelRef,
	NewsModelTestResult,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { useT } from "../../i18n/index.ts";
import { errorText, type NewsClient } from "./news-client.ts";

export function NewsModelTest({
	api,
	model,
	modelName,
	disabled = false,
	draft = false,
	onBusyChange,
}: {
	api: NewsClient;
	model?: NewsModelRef;
	modelName?: string;
	disabled?: boolean;
	draft?: boolean;
	onBusyChange?: (busy: boolean) => void;
}): React.JSX.Element {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<NewsModelTestResult>();
	const [error, setError] = useState("");
	const inFlight = useRef(false);
	const mounted = useRef(true);
	const selection = `${model?.provider ?? ""}/${model?.id ?? ""}`;
	const currentSelection = useRef(selection);
	currentSelection.current = selection;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		setResult(undefined);
		setError("");
	}, [selection]);
	async function test(): Promise<void> {
		if (disabled || inFlight.current) return;
		inFlight.current = true;
		const submittedSelection = selection;
		setBusy(true);
		onBusyChange?.(true);
		setResult(undefined);
		setError("");
		try {
			const response = await api.query({ action: "test_model", ...(model ? { model: { ...model } } : {}) });
			if (mounted.current && currentSelection.current === submittedSelection) setResult(response);
		} catch (failure) {
			if (mounted.current && currentSelection.current === submittedSelection) setError(errorText(failure));
		} finally {
			inFlight.current = false;
			if (mounted.current) {
				setBusy(false);
				onBusyChange?.(false);
			}
		}
	}
	return (
		<div className="owl-news-model-test">
			<div className="owl-news-model-test-header">
				<span className="owl-news-muted">{t("news.capability.assistant")}</span>
				<strong>{model ? `${modelName || model.id} · ${model.provider}` : t("news.defaultModel")}</strong>
			</div>
			<button type="button" className="owl-news-primary" disabled={disabled || busy} onClick={() => void test()}>
				{busy ? t("news.modelTesting") : t("news.modelTest")}
			</button>
			<p className="owl-news-muted">{t(draft ? "news.modelTestDraftHint" : "news.modelTestHint")}</p>
			{busy && <p aria-live="polite">{t("news.modelTesting")}</p>}
			{result && (
				<div className="owl-news-notice" role="status" data-testid="news-model-test-result">
					<strong>{t("news.modelTestPassed")}</strong>
					<p>{result.answer}</p>
					<p>{t("news.modelTestDetails", { provider: result.model.provider, model: result.model.id, ms: Math.round(result.durationMs) })}</p>
					{result.usage && <p>{t("news.modelTestUsage", { input: result.usage.input, output: result.usage.output })}</p>}
				</div>
			)}
			{error && (
				<div className="owl-news-error" role="alert" data-testid="news-model-test-result">
					<strong>{t("news.modelTestFailed")}</strong>
					<p>{error}</p>
				</div>
			)}
		</div>
	);
}
