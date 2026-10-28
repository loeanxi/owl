import type { CSSProperties } from "react";
import {
	CODEX_THEME_IDS,
	CODEX_THEMES,
	type CodexThemeId,
	type CodexThemeVariant,
	isCodexThemeId,
} from "../../codex-themes.ts";
import { useT } from "../../i18n/index.ts";
import { Menu } from "../Menu.tsx";

/** Codex 菜单里默认主题单列在顶层（显示为 ChatGPT），其余收进「Codex 主题」分组。 */
const CHATGPT_THEME_ID: CodexThemeId = "cx-codex";
const GROUPED_THEME_IDS = CODEX_THEME_IDS.filter((id) => id !== CHATGPT_THEME_ID);

function themeVariant(id: CodexThemeId, mode: "dark" | "light"): CodexThemeVariant {
	const theme = CODEX_THEMES[id];
	return theme[mode] ?? theme.dark ?? theme.light!;
}

function Badge({ variant }: { variant: CodexThemeVariant }): React.JSX.Element {
	return (
		<span
			className="owl-codex-theme-badge"
			aria-hidden="true"
			style={{ "--cx-bg": variant.background, "--cx-fg": variant.accent } as CSSProperties}
		>
			Aa
		</span>
	);
}

function Preview({ variant }: { variant: CodexThemeVariant }): React.JSX.Element {
	const { background: bg, foreground: fg, accent } = variant;
	return (
		<span
			className="owl-settings-preset-preview"
			aria-hidden="true"
			style={
				{
					"--pv-bg": bg,
					"--pv-rail": `color-mix(in srgb, ${bg} 88%, ${fg})`,
					"--pv-line": `color-mix(in srgb, ${bg} 55%, ${fg})`,
					"--pv-panel": `color-mix(in srgb, ${bg} 92%, ${fg})`,
					"--color-owl-accent": accent,
				} as CSSProperties
			}
		>
			<span className="pv-rail">
				<i className="is-accent" />
				<i />
				<i />
			</span>
			<span className="pv-main">
				<i />
				<i />
				<b />
			</span>
		</span>
	);
}

/** 主题预设网格里的 Codex 卡片：预览当前选中的 Codex 主题，点开是 Codex 同款主题菜单。 */
export function CodexThemePicker({
	preset,
	mode,
	disabled,
	onSelect,
}: {
	preset: string;
	mode: "dark" | "light";
	disabled: boolean;
	onSelect: (id: CodexThemeId) => void;
}): React.JSX.Element {
	const t = useT();
	const active = isCodexThemeId(preset) ? preset : null;
	const card = (
		<>
			<Preview variant={themeVariant(active ?? CHATGPT_THEME_ID, mode)} />
			<span className="owl-settings-preset-label">
				<span className="owl-codex-theme-card-label">
					{t("settings.appearance.codexThemes")}
					{active && <span className="owl-codex-theme-current">{CODEX_THEMES[active].label}</span>}
				</span>
				{active && (
					<span className="owl-settings-preset-check" aria-hidden="true">
						✓
					</span>
				)}
			</span>
		</>
	);
	const cardClass = `owl-settings-preset-card owl-codex-theme-card ${active ? "is-active" : ""}`;
	const option = (id: CodexThemeId, close: () => void) => {
		const theme = CODEX_THEMES[id];
		const only = !theme.light
			? t("settings.appearance.codexDarkOnly")
			: !theme.dark
				? t("settings.appearance.codexLightOnly")
				: "";
		return (
			<button
				key={id}
				type="button"
				role="option"
				aria-selected={id === active}
				className={`owl-codex-theme-option ${id === active ? "is-active" : ""}`}
				onClick={() => {
					close();
					if (id !== active) onSelect(id);
				}}
			>
				<Badge variant={themeVariant(id, mode)} />
				<span className="owl-codex-theme-name">{theme.label}</span>
				{only && <span className="owl-codex-theme-only">{only}</span>}
				{id === active && (
					<span className="owl-codex-theme-check" aria-hidden="true">
						✓
					</span>
				)}
			</button>
		);
	};
	return (
		<div className="owl-codex-theme-slot">
			{disabled ? (
				<button type="button" className={cardClass} disabled>
					{card}
				</button>
			) : (
				<Menu
					trigger={card}
					triggerClassName={cardClass}
					triggerTitle={t("settings.appearance.codexThemesDesc")}
					panelClassName="owl-codex-theme-panel right-0"
				>
					{(close) => (
						<div role="listbox" aria-label={t("settings.appearance.codexThemes")}>
							{option(CHATGPT_THEME_ID, close)}
							<div className="owl-codex-theme-group" role="presentation">
								{t("settings.appearance.codexThemes")}
							</div>
							{GROUPED_THEME_IDS.map((id) => option(id, close))}
						</div>
					)}
				</Menu>
			)}
		</div>
	);
}
