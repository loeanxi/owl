import type { ProviderModelsMessage } from "../bridge/protocol.ts";

/** 供应商分组下拉；providers 只含已配置凭据的供应商（与原始 pi 模型选择器同语义）。 */
export function ModelSwitcher({ providers }: { providers: ProviderModelsMessage[] }): React.JSX.Element {
	const stored = localStorage.getItem("pire.model") ?? "";
	const all = providers.flatMap((provider) =>
		provider.models.map((model) => ({ ...model, provider: provider.id })),
	);
	const selected =
		all.find((model) => `${model.provider}/${model.id}` === stored) ??
		all.find((model) => model.id === "glm-5.3-flash") ??
		all[0];
	return (
		<select
			className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
			value={selected ? `${selected.provider}/${selected.id}` : ""}
			onChange={(event) => localStorage.setItem("pire.model", event.target.value)}
			title="新会话使用的模型（按供应商分组，仅已配置凭据的供应商）"
		>
			{all.length === 0 && (
				<option value="">（无可用模型 — 先在 auth.json 或 models.json 配置供应商凭据）</option>
			)}
			{providers.map((provider) => (
				<optgroup key={provider.id} label={provider.name ? `${provider.name} (${provider.id})` : provider.id}>
					{provider.models.map((model) => (
						<option key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>
							{model.id}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}
