import type { ModelInfoMessage } from "../bridge/protocol.ts";

export function ModelSwitcher({ models }: { models: ModelInfoMessage[] }): React.JSX.Element {
	const stored = localStorage.getItem("pire.model") ?? "";
	const selected =
		models.find((model) => `${model.provider}/${model.id}` === stored) ??
		models.find((model) => model.id === "glm-5.3-flash") ??
		models[0];
	return (
		<select
			className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
			value={selected ? `${selected.provider}/${selected.id}` : ""}
			onChange={(event) => localStorage.setItem("pire.model", event.target.value)}
			title="新会话使用的模型"
		>
			{models.length === 0 && <option value="">（未获取模型列表）</option>}
			{models.map((model) => (
				<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
					{model.provider}/{model.id}
				</option>
			))}
		</select>
	);
}
