import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { getUiLanguage, subscribeUiLanguage, useT } from "../../i18n/index.ts";
import { SettingRow } from "./settings-widgets.tsx";

const COPY = {
	zh: {
		title: "每次回复输出预算",
		description:
			"默认 16384 tokens。调高可用于较长回复，也可能增加中转站预留积分；思考 tokens 可能额外加入，实际输出仍受模型和上下文限制。",
		label: "输出预算（tokens）",
		invalid: "请输入大于 0 的整数。",
		failed: "尚未保存，输入已保留，可再次点击保存。",
		restart: "保存后重新启动 Owl，让已有会话使用新预算。",
		saved: "已保存。重新启动 Owl 后生效。",
	},
	en: {
		title: "Reply output budget",
		description:
			"Defaults to 16384 tokens. Increase it for longer replies; your gateway may reserve more credits. Thinking tokens may be added separately, and model and context limits still apply.",
		label: "Output budget (tokens)",
		invalid: "Enter a positive whole number.",
		failed: "Not saved. Your input is kept; select Save to try again.",
		restart: "Restart Owl after saving so existing sessions use the new budget.",
		saved: "Saved. Restart Owl to apply the change.",
	},
};

export function RequestBudgetSetting({
	value,
	busy,
	onSave,
}: {
	value: unknown;
	busy: boolean;
	onSave: (value: number) => Promise<boolean>;
}): React.JSX.Element {
	const t = useT();
	const language = useSyncExternalStore(subscribeUiLanguage, getUiLanguage);
	const copy = COPY[language];
	const inputId = useId();
	const hintId = useId();
	const validationId = useId();
	const savedValue = value === undefined ? "16384" : String(value);
	const [draft, setDraft] = useState(savedValue);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<"idle" | "invalid" | "failed" | "saved">("idle");
	const inFlight = useRef(false);

	// Successful settings responses update value. Failed saves keep the draft.
	useEffect(() => {
		if (!dirty) setDraft(savedValue);
	}, [savedValue, dirty]);

	const save = async (): Promise<void> => {
		if (busy || inFlight.current) return;
		const budget = Number(draft);
		if (!Number.isSafeInteger(budget) || budget < 1) {
			setStatus("invalid");
			return;
		}
		inFlight.current = true;
		setStatus("idle");
		try {
			if (await onSave(budget)) {
				setDirty(false);
				setStatus("saved");
			} else {
				setStatus("failed");
			}
		} catch {
			setStatus("failed");
		} finally {
			inFlight.current = false;
		}
	};

	return (
		<SettingRow
			title={copy.title}
			desc={copy.description}
			control={
				<button
					type="button"
					className="owl-settings-button is-primary"
					disabled={busy}
					onClick={() => void save()}
				>
					{t("common.save")}
				</button>
			}
		>
			<label className="block text-owl-muted" htmlFor={inputId}>
				{copy.label}
			</label>
			<input
				id={inputId}
				type="number"
				min={1}
				max={Number.MAX_SAFE_INTEGER}
				step={1}
				required
				className="owl-settings-input mt-1 w-full tabular-nums"
				value={draft}
				disabled={busy}
				aria-invalid={status === "invalid"}
				aria-describedby={`${hintId}${status === "invalid" ? ` ${validationId}` : ""}`}
				onChange={(event) => {
					setDraft(event.currentTarget.value);
					setDirty(true);
					setStatus("idle");
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void save();
					}
				}}
			/>
			<p id={hintId} className="owl-settings-row-description mt-2">
				{copy.restart}
			</p>
			{status === "invalid" && (
				<p id={validationId} className="owl-settings-notice is-error mt-2" role="alert">
					{copy.invalid}
				</p>
			)}
			{status === "failed" && (
				<p className="owl-settings-notice is-error mt-2" role="alert">
					{copy.failed}
				</p>
			)}
			{status === "saved" && <output className="owl-settings-row-description mt-2 block">{copy.saved}</output>}
		</SettingRow>
	);
}
