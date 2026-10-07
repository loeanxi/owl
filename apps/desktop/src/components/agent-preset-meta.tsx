import type { AgentPresetDefinition } from "../bridge/protocol.ts";

/**
 * Agent 预设的视觉身份：内置四预设固定配色与徽字（标准绿 / PTC 紫 / 极简橙 / 创造粉），
 * 自定义预设取名称首字、中性灰。侧栏色点、选择器与设置页共用这一份。
 */
export const PRESET_COLORS: Record<string, string> = {
	standard: "#268574",
	ptc: "#7c5cd6",
	minimal: "#b45309",
	cordis: "#c2477e",
};

export const PRESET_BADGES: Record<string, string> = { standard: "标", ptc: "PT", minimal: "极", cordis: "创" };

export function presetColor(id: string): string {
	return PRESET_COLORS[id] ?? "#8f948c";
}

export function PresetAvatar({ preset, sizeClass = "h-5 w-5 text-[9px]" }: { preset: AgentPresetDefinition; sizeClass?: string }): React.JSX.Element {
	return (
		<span
			className={`${sizeClass} grid shrink-0 place-items-center rounded font-semibold text-white`}
			style={{ backgroundColor: presetColor(preset.id) }}
			aria-hidden
		>
			{PRESET_BADGES[preset.id] ?? preset.name.slice(0, 1)}
		</span>
	);
}
