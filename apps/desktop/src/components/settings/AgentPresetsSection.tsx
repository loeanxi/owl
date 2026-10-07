import { useEffect, useState } from "react";
import type { AgentPresetDefinition } from "../../bridge/protocol.ts";
import { useT, type TextKey } from "../../i18n/index.ts";
import { PresetAvatar } from "../agent-preset-meta.tsx";
import { SectionHeader } from "./settings-widgets.tsx";

const APPROVAL_LABELS: Record<string, TextKey> = {
	auto: "composer.mode.auto.label",
	confirm: "composer.mode.confirm.label",
	plan: "composer.mode.plan.label",
};

const chip = "rounded border border-owl-border bg-owl-sidebar px-1.5 py-px font-mono text-[9.5px] text-owl-muted";
const chipAdd = "rounded border border-owl-accent/35 bg-owl-sidebar px-1.5 py-px font-mono text-[9.5px] text-owl-accent";
const chipDel = "rounded border border-owl-border bg-owl-sidebar px-1.5 py-px font-mono text-[9.5px] text-owl-muted line-through opacity-70";
const opBtn = "rounded-md border border-owl-border px-2 py-1 text-[10.5px] text-owl-muted transition-colors hover:border-owl-accent hover:text-owl-accent disabled:opacity-50";
const fieldInput = "w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none transition-colors focus:border-owl-accent";

function ToolChips({ tools, inheritLabel }: { tools: string[] | undefined; inheritLabel: string }): React.JSX.Element {
	if (!tools || tools.length === 0) return <span className="text-[10.5px] text-owl-faint">{inheritLabel}</span>;
	return (
		<span className="flex flex-wrap gap-1">
			{tools.map((entry) => (
				<span key={entry} className={entry.startsWith("+") ? chipAdd : entry.startsWith("-") ? chipDel : chip}>{entry}</span>
			))}
		</span>
	);
}

/** 设置页 · Agent 预设：内置四预设只读（复制创建），自定义可编辑/删除，右栏抽屉查看/编辑。 */
export function AgentPresetsSection({ client, agentDir, onAskAgent }: {
	client: import("../../bridge/client.ts").BridgeClient;
	agentDir: string;
	/** 「让 Agent 帮我创建预设模式」：切到创造模式开新会话并填入引导草稿（App 实现）。 */
	onAskAgent?: () => void;
}): React.JSX.Element {
	const t = useT();
	const [rows, setRows] = useState<AgentPresetDefinition[]>([]);
	const [defaultId, setDefaultId] = useState("standard");
	const [drawer, setDrawer] = useState<{ mode: "view" | "edit"; draft: AgentPresetDefinition; toolsText: string } | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const load = (): void => {
		void client
			.request<{ presets: AgentPresetDefinition[]; defaultPreset: string }>({ type: "preset.list" })
			.then((response) => {
				if (response.ok && response.result) {
					setRows(response.result.presets);
					setDefaultId(response.result.defaultPreset);
				} else if (response.error) setError(response.error);
			})
			.catch(() => {});
	};

	useEffect(load, [client]);

	const run = (action: () => Promise<void>): void => {
		setBusy(true);
		setError("");
		void action()
			.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setBusy(false));
	};

	const setDefault = (id: string): void =>
		run(async () => {
			const response = await client.request<{ defaultPreset: string }>({ type: "preset.setDefault", agentPreset: id });
			if (!response.ok || !response.result) throw new Error(response.error ?? "failed");
			setDefaultId(response.result.defaultPreset);
		});

	const duplicate = (src: AgentPresetDefinition): void =>
		run(async () => {
			let id = `${src.id}-copy`;
			for (let n = 2; rows.some((row) => row.id === id); n++) id = `${src.id}-copy${n}`;
			const copy: AgentPresetDefinition = { ...src, id, name: `${src.name} 副本`, builtin: false, order: Math.max(100, src.order) };
			const response = await client.request<{ preset: AgentPresetDefinition }>({ type: "preset.save", preset: copy });
			if (!response.ok || !response.result) throw new Error(response.error ?? "failed");
			load();
			openEdit(response.result.preset);
		});

	const openEdit = (preset: AgentPresetDefinition): void =>
		setDrawer({ mode: "edit", draft: { ...preset }, toolsText: (preset.tools ?? []).join(" ") });

	const saveDraft = (): void => {
		if (!drawer || drawer.mode !== "edit") return;
		const tools = drawer.toolsText.split(/[\s,]+/).filter(Boolean);
		const draft: AgentPresetDefinition = {
			...drawer.draft,
			builtin: false,
			...(tools.length > 0 ? { tools } : {}),
		};
		run(async () => {
			const response = await client.request<{ preset: AgentPresetDefinition }>({ type: "preset.save", preset: draft });
			if (!response.ok) throw new Error(response.error ?? "failed");
			setDrawer(null);
			load();
		});
	};

	const remove = (preset: AgentPresetDefinition): void =>
		run(async () => {
			const response = await client.request<{ presets: AgentPresetDefinition[] }>({ type: "preset.delete", agentPreset: preset.id });
			if (!response.ok || !response.result) throw new Error(response.error ?? "failed");
			setConfirmingDelete("");
			if (drawer?.draft.id === preset.id) setDrawer(null);
			setRows(response.result.presets);
		});

	const openConfigDir = (): void => {
		if (!agentDir) return;
		const url = `file:///${agentDir.replace(/\\/g, "/").replace(/^\/+/, "")}/presets`;
		void client.request({ type: "open.external", action: "url", target: encodeURI(url) }).catch(() => {});
	};

	const rowCard = "flex items-center gap-3 rounded-xl border border-owl-border bg-owl-panel px-3.5 py-3";
	const builtIn = rows.filter((row) => row.builtin);
	const custom = rows.filter((row) => !row.builtin);

	return (
		<>
			<SectionHeader title={t("settings.presets.title")} desc={t("settings.presets.desc")} />
			{error !== "" && <p className="owl-settings-notice is-error" role="alert">{t("settings.presets.opFailed", { error })}</p>}
			<div className="mb-4 flex justify-end">
				<button type="button" className={opBtn} onClick={openConfigDir} disabled={agentDir === ""}>{t("settings.presets.openConfig")}</button>
			</div>

			<p className="mb-2 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.builtInGroup")}</p>
			<div className="mb-5 flex flex-col gap-2">
				{builtIn.map((preset) => (
					<div key={preset.id} className={rowCard}>
						<PresetAvatar preset={preset} sizeClass="h-7 w-7 text-[10px]" />
						<div className="min-w-0 flex-1">
							<p className="flex items-center gap-2 text-xs font-semibold text-owl-text">
								{preset.name}
								{preset.id === defaultId && (
									<span className="rounded-full bg-owl-accent/12 px-2 py-px text-[9.5px] font-semibold text-owl-accent">{t("settings.presets.isDefault")}</span>
								)}
								<span className="text-[9.5px] tracking-wide text-owl-faint">{preset.id}</span>
							</p>
							<p className="mt-0.5 text-[10.8px] leading-snug text-owl-muted">{preset.description}</p>
							<div className="mt-1.5">
								<ToolChips tools={preset.tools} inheritLabel={t("settings.presets.toolsInherit")} />
							</div>
						</div>
						<div className="flex flex-none items-center gap-1.5">
							{preset.id !== defaultId && (
								<button type="button" className={opBtn} disabled={busy} onClick={() => setDefault(preset.id)}>{t("settings.presets.setDefault")}</button>
							)}
							<button type="button" className={opBtn} onClick={() => setDrawer({ mode: "view", draft: preset, toolsText: (preset.tools ?? []).join(" ") })}>{t("settings.presets.view")}</button>
							<button type="button" className={opBtn} disabled={busy} onClick={() => duplicate(preset)}>{t("settings.presets.duplicate")}</button>
						</div>
					</div>
				))}
			</div>

			<p className="mb-2 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.customGroup")}</p>
			<div className="flex flex-col gap-2">
				{custom.map((preset) => (
					<div key={preset.id} className={rowCard}>
						<PresetAvatar preset={preset} sizeClass="h-7 w-7 text-[10px]" />
						<div className="min-w-0 flex-1">
							<p className="flex items-center gap-2 text-xs font-semibold text-owl-text">
								{preset.name}
								{preset.id === defaultId && (
									<span className="rounded-full bg-owl-accent/12 px-2 py-px text-[9.5px] font-semibold text-owl-accent">{t("settings.presets.isDefault")}</span>
								)}
							</p>
							{preset.description !== "" && <p className="mt-0.5 text-[10.8px] leading-snug text-owl-muted">{preset.description}</p>}
							<div className="mt-1.5">
								<ToolChips tools={preset.tools} inheritLabel={t("settings.presets.toolsInherit")} />
							</div>
						</div>
						<div className="flex flex-none items-center gap-1.5">
							{preset.id !== defaultId && (
								<button type="button" className={opBtn} disabled={busy} onClick={() => setDefault(preset.id)}>{t("settings.presets.setDefault")}</button>
							)}
							<button type="button" className={opBtn} onClick={() => openEdit(preset)}>{t("settings.presets.edit")}</button>
							<button
								type="button"
								className={`${opBtn} hover:!border-red-400 hover:!text-red-400`}
								disabled={busy}
								onClick={() => {
									if (confirmingDelete === preset.id) remove(preset);
									else setConfirmingDelete(preset.id);
								}}
								onBlur={() => setConfirmingDelete("")}
							>
								{confirmingDelete === preset.id ? "✓" : t("settings.presets.delete")}
							</button>
						</div>
					</div>
				))}
				<button
					type="button"
					className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-owl-border px-3.5 py-3.5 text-xs text-owl-muted transition-colors hover:border-owl-accent hover:text-owl-accent"
					onClick={() => onAskAgent?.()}
				>
					<span aria-hidden>＋</span>
					{t("settings.presets.creatorCta")}
				</button>
			</div>

			{/* 查看/编辑抽屉 */}
			{drawer && (
				<div className="fixed inset-0 z-50 flex justify-end bg-black/35" onClick={() => setDrawer(null)}>
					<div className="flex h-full w-[360px] flex-col border-l border-owl-border bg-owl-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
						<div className="flex items-start gap-2.5 px-4 pb-2 pt-4">
							<PresetAvatar preset={drawer.draft} sizeClass="h-7 w-7 text-[10px]" />
							<div className="min-w-0 flex-1">
								<p className="truncate text-[13px] font-semibold text-owl-text">{drawer.draft.name}</p>
								<p className="text-[10.5px] text-owl-faint">{drawer.draft.id}</p>
							</div>
							<button type="button" className="text-owl-faint hover:text-owl-text" onClick={() => setDrawer(null)} aria-label={t("settings.presets.close")}>✕</button>
						</div>
						{drawer.mode === "view" && drawer.draft.builtin && (
							<p className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10.5px] leading-snug text-amber-600">
								{t("settings.presets.readonlyBanner")}
							</p>
						)}
						<div className="flex-1 overflow-y-auto px-4 pb-2">
							{drawer.mode === "edit" ? (
								<>
								<p className="mb-1 mt-2 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.form.name")}</p>
								<input className={fieldInput} value={drawer.draft.name} onChange={(event) => setDrawer({ ...drawer, draft: { ...drawer.draft, name: event.target.value } })} />
								<p className="mb-1 mt-3 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.form.description")}</p>
								<textarea className={`${fieldInput} h-16 resize-none`} value={drawer.draft.description} onChange={(event) => setDrawer({ ...drawer, draft: { ...drawer.draft, description: event.target.value } })} />
								</>
							) : (
								<p className="mt-2 text-[11px] leading-relaxed text-owl-muted">{drawer.draft.description}</p>
							)}
							<p className="mb-1 mt-3 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.appendPromptLabel")}</p>
							<textarea
								className={`${fieldInput} h-40 resize-none font-mono text-[10.5px] leading-relaxed`}
								spellCheck={false}
								value={drawer.draft.appendPrompt ?? ""}
								readOnly={drawer.mode === "view"}
								onChange={(event) => setDrawer({ ...drawer, draft: { ...drawer.draft, appendPrompt: event.target.value } })}
							/>
							<p className="mb-1 mt-3 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.toolsLabel")}</p>
							{drawer.mode === "edit" ? (
								<input className={fieldInput} value={drawer.toolsText} spellCheck={false} placeholder={t("settings.presets.toolsInherit")} onChange={(event) => setDrawer({ ...drawer, toolsText: event.target.value })} />
							) : (
								<ToolChips tools={drawer.draft.tools} inheritLabel={t("settings.presets.toolsInherit")} />
							)}
							<p className="mb-1 mt-3 text-[10.5px] font-semibold tracking-wide text-owl-faint">{t("settings.presets.approvalLabel")}</p>
							{drawer.mode === "edit" ? (
								<select
									className={fieldInput}
									value={drawer.draft.approvalMode ?? ""}
									onChange={(event) => setDrawer({ ...drawer, draft: { ...drawer.draft, approvalMode: (event.target.value || undefined) as AgentPresetDefinition["approvalMode"] } })}
								>
									<option value="">—</option>
									{(Object.keys(APPROVAL_LABELS) as string[]).map((value) => (
										<option key={value} value={value}>{t(APPROVAL_LABELS[value])}</option>
									))}
								</select>
							) : (
								<p className="text-[11px] text-owl-muted">{drawer.draft.approvalMode ? t(APPROVAL_LABELS[drawer.draft.approvalMode]) : "—"}</p>
							)}
						</div>
						<div className="flex gap-2 border-t border-owl-border px-4 py-3">
							{drawer.mode === "edit" ? (
								<button type="button" className="rounded-lg bg-owl-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={saveDraft}>{t("settings.presets.form.save")}</button>
							) : (
								<button type="button" className="rounded-lg bg-owl-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => duplicate(drawer.draft)}>{t("settings.presets.duplicate")}</button>
							)}
							<button type="button" className="rounded-lg border border-owl-border px-3.5 py-1.5 text-xs text-owl-muted hover:text-owl-text" onClick={() => setDrawer(null)}>{t("settings.presets.form.cancel")}</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
