/**
 * Codex 桌面版主题（OpenAI.Codex 26.1007.9446.0）移植，由脚本生成，勿手改；配色令牌在 codex-themes.css。
 * 只有一档的主题（如 Tokyo Night 仅深色、Proof 仅浅色）由 presetThemeLock 锁定该档。
 */

export const CODEX_THEME_IDS = [
	"cx-codex",
	"cx-absolutely",
	"cx-ayu",
	"cx-catppuccin",
	"cx-dracula",
	"cx-everforest",
	"cx-github",
	"cx-gruvbox",
	"cx-linear",
	"cx-lobster",
	"cx-material",
	"cx-matrix",
	"cx-monokai",
	"cx-night-owl",
	"cx-nord",
	"cx-notion",
	"cx-og",
	"cx-one",
	"cx-oscurange",
	"cx-proof",
	"cx-raycast",
	"cx-rose-pine",
	"cx-sentry",
	"cx-solarized",
	"cx-temple",
	"cx-tokyo-night",
	"cx-vercel",
	"cx-vscode-plus",
	"cx-xcode",
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
	"cx-codex": {
		label: "ChatGPT",
		dark: { background: "#111111", foreground: "#fcfcfc", accent: "#0169cc" },
		light: { background: "#ffffff", foreground: "#0d0d0d", accent: "#0169cc" },
	},
	"cx-absolutely": {
		label: "Absolutely",
		dark: { background: "#2d2d2b", foreground: "#f9f9f7", accent: "#cc7d5e" },
		light: { background: "#f9f9f7", foreground: "#2d2d2b", accent: "#cc7d5e" },
	},
	"cx-ayu": {
		label: "Ayu",
		dark: { background: "#10141c", foreground: "#bfbdb6", accent: "#e6b450" },
	},
	"cx-catppuccin": {
		label: "Catppuccin",
		dark: { background: "#1e1e2e", foreground: "#cdd6f4", accent: "#cba6f7" },
		light: { background: "#eff1f5", foreground: "#4c4f69", accent: "#8839ef" },
	},
	"cx-dracula": {
		label: "Dracula",
		dark: { background: "#282a36", foreground: "#f8f8f2", accent: "#ff79c6" },
	},
	"cx-everforest": {
		label: "Everforest",
		dark: { background: "#2d353b", foreground: "#d3c6aa", accent: "#a7c080" },
		light: { background: "#fdf6e3", foreground: "#5c6a72", accent: "#93b259" },
	},
	"cx-github": {
		label: "GitHub",
		dark: { background: "#0d1117", foreground: "#e6edf3", accent: "#1f6feb" },
		light: { background: "#ffffff", foreground: "#1f2328", accent: "#0969da" },
	},
	"cx-gruvbox": {
		label: "Gruvbox",
		dark: { background: "#282828", foreground: "#ebdbb2", accent: "#458588" },
		light: { background: "#fbf1c7", foreground: "#3c3836", accent: "#458588" },
	},
	"cx-linear": {
		label: "Linear",
		dark: { background: "#0f0f11", foreground: "#e3e4e6", accent: "#606acc" },
		light: { background: "#fcfcfd", foreground: "#1b1b1b", accent: "#5e6ad2" },
	},
	"cx-lobster": {
		label: "Lobster",
		dark: { background: "#111827", foreground: "#e4e4e7", accent: "#ff5c5c" },
	},
	"cx-material": {
		label: "Material",
		dark: { background: "#212121", foreground: "#eeffff", accent: "#80cbc4" },
	},
	"cx-matrix": {
		label: "Matrix",
		dark: { background: "#040805", foreground: "#b8ffca", accent: "#1eff5a" },
	},
	"cx-monokai": {
		label: "Monokai",
		dark: { background: "#272822", foreground: "#f8f8f2", accent: "#99947c" },
	},
	"cx-night-owl": {
		label: "Night Owl",
		dark: { background: "#011627", foreground: "#d6deeb", accent: "#44596b" },
	},
	"cx-nord": {
		label: "Nord",
		dark: { background: "#2e3440", foreground: "#d8dee9", accent: "#88c0d0" },
	},
	"cx-notion": {
		label: "Notion",
		dark: { background: "#191919", foreground: "#d9d9d8", accent: "#3183d8" },
		light: { background: "#ffffff", foreground: "#37352f", accent: "#3183d8" },
	},
	"cx-og": {
		label: "OG",
		dark: { background: "#343541", foreground: "#d1d5db", accent: "#10a37f" },
	},
	"cx-one": {
		label: "One",
		dark: { background: "#282c34", foreground: "#abb2bf", accent: "#4d78cc" },
		light: { background: "#fafafa", foreground: "#383a42", accent: "#526fff" },
	},
	"cx-oscurange": {
		label: "Oscurange",
		dark: { background: "#0b0b0f", foreground: "#e6e6e6", accent: "#f9b98c" },
	},
	"cx-proof": {
		label: "Proof",
		light: { background: "#f5f3ed", foreground: "#2f312d", accent: "#3d755d" },
	},
	"cx-raycast": {
		label: "Raycast",
		dark: { background: "#101010", foreground: "#fefefe", accent: "#ff6363" },
		light: { background: "#ffffff", foreground: "#030303", accent: "#ff6363" },
	},
	"cx-rose-pine": {
		label: "Rose Pine",
		dark: { background: "#232136", foreground: "#e0def4", accent: "#ea9a97" },
		light: { background: "#faf4ed", foreground: "#575279", accent: "#d7827e" },
	},
	"cx-sentry": {
		label: "Sentry",
		dark: { background: "#2d2935", foreground: "#e6dff9", accent: "#7055f6" },
	},
	"cx-solarized": {
		label: "Solarized",
		dark: { background: "#002b36", foreground: "#839496", accent: "#d30102" },
		light: { background: "#fdf6e3", foreground: "#657b83", accent: "#b58900" },
	},
	"cx-temple": {
		label: "Temple",
		dark: { background: "#02120c", foreground: "#c7e6da", accent: "#e4f222" },
	},
	"cx-tokyo-night": {
		label: "Tokyo Night",
		dark: { background: "#1a1b26", foreground: "#a9b1d6", accent: "#3d59a1" },
	},
	"cx-vercel": {
		label: "Vercel",
		dark: { background: "#000000", foreground: "#ededed", accent: "#006efe" },
		light: { background: "#ffffff", foreground: "#171717", accent: "#006aff" },
	},
	"cx-vscode-plus": {
		label: "VS Code Plus",
		dark: { background: "#1e1e1e", foreground: "#d4d4d4", accent: "#007acc" },
		light: { background: "#ffffff", foreground: "#000000", accent: "#007acc" },
	},
	"cx-xcode": {
		label: "Xcode",
		dark: { background: "#1f1f24", foreground: "#ffffff", accent: "#5482ff" },
		light: { background: "#ffffff", foreground: "#000000", accent: "#0e0eff" },
	},
};

export function isCodexThemeId(value: string): value is CodexThemeId {
	return (CODEX_THEME_IDS as readonly string[]).includes(value);
}
