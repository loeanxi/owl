import { useState } from "react";
import type {
	NewsCapability,
	NewsConfiguration,
	NewsConfigurationPatch,
	NewsModelRef,
	NewsSnapshot,
	NewsSourceKind,
} from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { type TextKey, useT } from "../../i18n/index.ts";
import { useNewsToast } from "./NewsToast.tsx";
import { errorText, type NewsClient } from "./news-client.ts";
import { useNewsQuery } from "./use-news-query.ts";

const LEVELS: { label: TextKey; T1: number; T1_5: number; T2: number }[] = [
	{ label: "news.levelStrict", T1: 68, T1_5: 73, T2: 84 },
	{ label: "news.levelBalanced", T1: 60, T1_5: 65, T2: 76 },
	{ label: "news.levelLoose", T1: 52, T1_5: 57, T2: 68 },
];
const FREQUENCIES: { label: TextKey; minutes: number }[] = [
	{ label: "news.every30m", minutes: 30 },
	{ label: "news.every1h", minutes: 60 },
	{ label: "news.every6h", minutes: 360 },
];
const KEYS: { kind: NewsSourceKind; key: string; label: TextKey; provider: string }[] = [
	{ kind: "x_search", key: "SOCIALDATA_API_KEY", label: "news.keyX", provider: "SocialData" },
	{ kind: "mp_account", key: "DAJIALA_KEY", label: "news.keyMp", provider: "极致了" },
];

const modelKey = (model?: NewsModelRef): string => (model ? `${model.provider}/${model.id}` : "");

export function NewsQuickSettings({
	api,
	snapshot,
	config,
	capabilities,
	revision,
	onSaved,
	onChanged,
}: {
	api: NewsClient;
	snapshot: NewsSnapshot;
	config: NewsConfiguration;
	capabilities: NewsCapability[];
	revision: number;
	onSaved: (config: NewsConfiguration) => void;
	onChanged: () => void;
}): React.JSX.Element {
	const t = useT();
	const sources = useNewsQuery(api, { action: "sources" }, revision);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [testResult, setTestResult] = useState("");
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [toast, showToast] = useNewsToast();
	async function run(operation: () => Promise<void>, message = t("common.saved")): Promise<boolean> {
		if (busy) return false;
		setBusy(true);
		setError("");
		try {
			await operation();
			if (message) showToast(message);
			return true;
		} catch (failure) {
			setError(errorText(failure));
			return false;
		} finally {
			setBusy(false);
		}
	}
	const save = (patch: NewsConfigurationPatch, secretPatch?: Record<string, string>) =>
		run(async () => {
			onSaved(await api.query({ action: "configure", patch, secrets: secretPatch }));
			onChanged();
		});

	const modelKeys = new Set(capabilities.map((capability) => modelKey(config.models[capability])));
	const model = modelKeys.size === 1 ? [...modelKeys][0]! : "mixed";
	const unifiedModel = model === "mixed" ? undefined : config.models[capabilities[0]!];
	const level = LEVELS.find(
		(entry) =>
			config.thresholds.T1 === entry.T1 &&
			config.thresholds.T1_5 === entry.T1_5 &&
			config.thresholds.T2 === entry.T2,
	);
	const list = sources.data ?? [];
	const intervals = new Set(list.map((source) => source.intervalMinutes));
	const frequency = intervals.size === 1 ? [...intervals][0] : undefined;
	const neededKeys = KEYS.flatMap((entry) => {
		const users = list.filter((source) => source.kind === entry.kind);
		return users.length ? [{ ...entry, names: users.map((source) => source.name).join("、") }] : [];
	});
	return (
		<>
			{toast}
			{error && (
				<p className="owl-news-error" role="alert">
					{error}
				</p>
			)}
			<div className="owl-news-rows">
				<div className="owl-news-setting">
					<div>
						<b>{t("news.autoCollect")}</b>
						<small>{t("news.autoCollectHint")}</small>
					</div>
					<button
						type="button"
						role="switch"
						className="owl-news-switch"
						aria-checked={config.collectEnabled}
						aria-label={t("news.autoCollect")}
						disabled={busy}
						onClick={() =>
							void save({ collectEnabled: !config.collectEnabled, modelCallsEnabled: !config.collectEnabled })
						}
					/>
				</div>
				<div className="owl-news-setting">
					<div>
						<b>{t("news.model")}</b>
						<small>{testResult || t("news.modelSimpleHint")}</small>
					</div>
					<select
						aria-label={t("news.model")}
						value={model}
						disabled={busy}
						onChange={(event) => {
							const picked = snapshot.models.find((entry) => modelKey(entry) === event.target.value);
							const ref = picked ? { provider: picked.provider, id: picked.id } : null;
							setTestResult("");
							void save({ models: Object.fromEntries(capabilities.map((capability) => [capability, ref])) });
						}}
					>
						{model === "mixed" && (
							<option value="mixed" disabled>
								{t("news.modelMixed")}
							</option>
						)}
						<option value="">{t("news.defaultModel")}</option>
						{model && model !== "mixed" && !snapshot.models.some((entry) => modelKey(entry) === model) && (
							<option value={model}>{model}</option>
						)}
						{snapshot.models.map((entry) => (
							<option key={modelKey(entry)} value={modelKey(entry)}>
								{entry.name} · {entry.provider}
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								setTestResult("");
								const result = await api.query({
									action: "test_model",
									...(unifiedModel ? { model: { ...unifiedModel } } : {}),
								});
								setTestResult(t("news.connectionOk", { ms: Math.round(result.durationMs) }));
							}, "")
						}
					>
						{t("news.testConnection")}
					</button>
				</div>
				<div className="owl-news-setting">
					<div>
						<b>{t("news.selectionLevel")}</b>
						<small>{level ? t("news.selectionLevelHint") : t("news.custom")}</small>
					</div>
					<div className="owl-news-seg">
						{LEVELS.map((entry) => (
							<button
								key={entry.label}
								type="button"
								aria-pressed={entry === level}
								disabled={busy}
								onClick={() =>
									void save({
										thresholds: {
											...config.thresholds,
											T1: entry.T1,
											T1_5: entry.T1_5,
											T2: entry.T2,
										},
									})
								}
							>
								{t(entry.label)}
							</button>
						))}
					</div>
				</div>
				<div className="owl-news-setting">
					<div>
						<b>{t("news.frequency")}</b>
						<small>
							{FREQUENCIES.some((entry) => entry.minutes === frequency)
								? t("news.frequencyHint")
								: t("news.custom")}
						</small>
					</div>
					<div className="owl-news-seg">
						{FREQUENCIES.map((entry) => (
							<button
								key={entry.minutes}
								type="button"
								aria-pressed={entry.minutes === frequency}
								disabled={busy || !sources.data}
								onClick={() =>
									void run(async () => {
										for (const source of list)
											if (source.intervalMinutes !== entry.minutes)
												await api.query({
													action: "saveSource",
													source: { ...source, intervalMinutes: entry.minutes },
												});
										onSaved(
											await api.query({ action: "configure", patch: { intervalMinutes: entry.minutes } }),
										);
										onChanged();
									})
								}
							>
								{t(entry.label)}
							</button>
						))}
					</div>
				</div>
			</div>
			{neededKeys.length > 0 && (
				<>
					<div className="owl-news-group">{t("news.keysSection")}</div>
					<div className="owl-news-rows">
						{neededKeys.map((entry) => {
							const filled = config.serviceStatus[entry.key];
							return (
								<form
									key={entry.key}
									className="owl-news-key"
									onSubmit={(event) => {
										event.preventDefault();
										const value = secrets[entry.key]?.trim();
										if (!value) return;
										void save({}, { [entry.key]: value }).then(
											(saved) => saved && setSecrets((current) => ({ ...current, [entry.key]: "" })),
										);
									}}
								>
									<div>
										<b>{t(entry.label)}</b>
										<small>{t("news.keyFor", { provider: entry.provider, names: entry.names })}</small>
									</div>
									<input
										type="password"
										autoComplete="new-password"
										aria-label={t(entry.label)}
										placeholder={filled ? t("news.keyReplace") : t("news.pasteKey")}
										value={secrets[entry.key] ?? ""}
										onChange={(event) => setSecrets({ ...secrets, [entry.key]: event.target.value })}
									/>
									<span className={filled ? "owl-news-tag is-ok" : "owl-news-tag"}>
										{filled ? t("news.keySet") : t("news.keyMissing")}
									</span>
									<button type="submit" disabled={busy || !secrets[entry.key]?.trim()}>
										{t("news.saveKey")}
									</button>
								</form>
							);
						})}
					</div>
				</>
			)}
		</>
	);
}
