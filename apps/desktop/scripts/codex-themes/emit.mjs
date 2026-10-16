import fs from "node:fs";
import path from "node:path";

const [jsonPath, srcDir, codexVersion] = process.argv.slice(2);
const themes = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const presetId = (id) => `cx-${id}`;
const variantNote = (t) => (t.variants.dark && t.variants.light ? "深浅两档" : t.variants.dark ? "仅深色，锁定深色档" : "仅浅色，锁定浅色档");

const header = [
	"/*",
	` * Codex 桌面版主题（${codexVersion}）移植，由脚本生成，勿手改。`,
	" * 每个主题先按 Codex 的规则从其 VS Code 配色里取 surface / ink / accent 三色，",
	" * 再用 Codex 的 contrast 混色公式铺出侧栏、面板、悬停、描边与文字层级。",
	" * 选择器带 data-owl-theme，优先级高于通用浅色块，与 index.css 的层叠顺序无关。",
	" */",
	"",
].join("\n");

let css = header;
for (const theme of themes) {
	css += `/* ${theme.label}（${variantNote(theme)}） */\n`;
	for (const [variant, { tokens: k }] of Object.entries(theme.variants)) {
		const sel = `html[data-owl-preset="${presetId(theme.id)}"][data-owl-theme="${variant}"]`;
		css += `${sel} {
	color-scheme: ${variant};
	--owl-conversation-bg: ${k.bg};
	--owl-preset-accent: ${k.accent};
	--owl-preset-accent-hover: ${k.accentHover};
	--color-owl-bg: ${k.bg};
	--color-owl-sidebar: ${k.sidebar};
	--color-owl-rail: ${k.rail};
	--color-owl-panel: ${k.panel};
	--color-owl-bubble: ${k.bubble};
	--color-owl-hover: ${k.hover};
	--color-owl-border: ${k.border};
	--color-owl-text: ${k.text};
	--color-owl-muted: ${k.muted};
	--color-owl-faint: ${k.faint};
	--color-owl-sidebar-bg: ${k.sidebar};
	--color-owl-sidebar-surface: ${k.sidebarSurface};
	--color-owl-sidebar-hover: ${k.sidebarHover};
	--color-owl-sidebar-selected: ${k.sidebarSelected};
	--color-owl-sidebar-border: ${k.sidebarBorder};
	--color-owl-sidebar-text: ${k.text};
	--color-owl-sidebar-muted: ${k.sidebarMuted};
	--color-owl-sidebar-faint: ${k.sidebarFaint};
}
${sel} .owl-desktop-shell {
	--owl-ui-canvas: var(--owl-ui-canvas-override, ${k.bg});
	--owl-ui-panel: ${k.panel};
	--owl-ui-sidebar: ${k.sidebar};
	--owl-ui-border: ${k.border};
	--owl-ui-text: var(--owl-ui-text-override, ${k.text});
	--owl-ui-muted: ${k.muted};
	--owl-ui-hover: ${k.hover};
	--owl-ui-menu-hover: ${k.menuHover};
}
`;
	}
	css += "\n";
}
fs.writeFileSync(path.join(srcDir, "codex-themes.css"), css.trimEnd() + "\n");

const variantTs = (v) => (v ? `{ background: "${v.tokens.bg}", foreground: "${v.tokens.text}", accent: "${v.tokens.accent}" }` : undefined);
let ts = `/**
 * Codex 桌面版主题（${codexVersion}）移植，由脚本生成，勿手改；配色令牌在 codex-themes.css。
 * 只有一档的主题（如 Tokyo Night 仅深色、Proof 仅浅色）由 presetThemeLock 锁定该档。
 */

export const CODEX_THEME_IDS = [
${themes.map((t) => `\t"${presetId(t.id)}",`).join("\n")}
] as const;

export type CodexThemeId = (typeof CODEX_THEME_IDS)[number];

export interface CodexThemeVariant {
	background: string;
	foreground: string;
	accent: string;
}

export interface CodexTheme {
	label: string;
	dark?: CodexThemeVariant;
	light?: CodexThemeVariant;
}

export const CODEX_THEMES: Record<CodexThemeId, CodexTheme> = {
${themes.map((t) => {
	const parts = [`label: "${t.label}"`];
	if (t.variants.dark) parts.push(`dark: ${variantTs(t.variants.dark)}`);
	if (t.variants.light) parts.push(`light: ${variantTs(t.variants.light)}`);
	return `\t"${presetId(t.id)}": {\n\t\t${parts.join(",\n\t\t")},\n\t},`;
}).join("\n")}
};

export function isCodexThemeId(value: string): value is CodexThemeId {
	return (CODEX_THEME_IDS as readonly string[]).includes(value);
}
`;
fs.writeFileSync(path.join(srcDir, "codex-themes.ts"), ts);
console.log(`themes: ${themes.length}, css bytes: ${css.length}`);
