// Replays Codex desktop's theme seed + chrome derivation and emits owl preset tokens.
// Usage (regenerates src/codex-themes.{css,ts}):
//   npx @electron/asar extract "<Codex install>/app/resources/app.asar" <tmp>/codex-asar
//   node gen.mjs <tmp>/codex-asar/webview/assets <tmp>/out
//   node emit.mjs <tmp>/out/codex-themes.json ../../src "OpenAI.Codex <version>"
// Registry parsing keys off minified names (SN / aba / oba); recheck them after a Codex upgrade.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const assets = process.argv[2];
const outDir = process.argv[3];
fs.writeFileSync(path.join(assets, "package.json"), JSON.stringify({ type: "module" }));
const appInitial = fs.readdirSync(assets).find((name) => /^app-initial-[0-9a-f]+\.js$/.test(name));
const src = fs.readFileSync(path.join(assets, appInitial), "utf8");
const shared = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find((n) => /^app-shared-[0-9a-f]+\.js$/.test(n))), "utf8");

// --- registry parsing -------------------------------------------------------
const snBody = shared.match(/SN=\{(AYU:[^}]+)\}/)[1];
const SN = Object.fromEntries([...snBody.matchAll(/(\w+):`([^`]+)`/g)].map((m) => [m[1], m[2]]));
const labels = Object.fromEntries([...shared.matchAll(/\[SN\.(\w+)\]:\{label:`([^`]+)`,variants:\[([^\]]+)\]\}/g)].map((m) => [m[1], { label: m[2], variants: [...m[3].matchAll(/`(\w+)`/g)].map((v) => v[1]) }]));

const abaStart = src.indexOf("aba={");
const abaEnd = src.indexOf("},oba=[", abaStart);
const aba = Object.fromEntries([...src.slice(abaStart, abaEnd).matchAll(/"?([\w-]+)"?\(\)\{return Q\(\(\)=>import\(`\.\/([^`]+)`\)/g)].map((m) => [m[1], m[2]]));
const obaStart = abaEnd + 2;
const obaEnd = src.indexOf("],sba=", obaStart);
const obaText = src.slice(obaStart, obaEnd);
const registry = [];
for (const m of obaText.matchAll(/qJ\(Mf\.(\w+),\{([^}]*)\}\)/g)) {
	const files = {};
	for (const v of m[2].matchAll(/(dark|light):`([^`]+)`/g)) files[v[1]] = aba[v[2]];
	registry.push({ key: m[1], files });
}
for (const m of obaText.matchAll(/JJ\(Mf\.(\w+),\{(.*?)\}\}\)/g)) {
	const files = {};
	for (const v of m[2].matchAll(/(dark|light):\{load:\(\)=>Q\(\(\)=>import\(`\.\/([^`]+)`\)/g)) files[v[1]] = v[2];
	registry.push({ key: m[1], files });
}

// --- Codex seed derivation (Dya / Oya / jya / kya) --------------------------
const KJ = {
	dark: { accent: "#339cff", contrast: 60, ink: "#ffffff", surface: "#181818", semanticColors: { diffAdded: "#40c977", diffRemoved: "#fa423e", skill: "#ad7bf9" } },
	light: { accent: "#339cff", contrast: 45, ink: "#1a1c1f", surface: "#ffffff", semanticColors: { diffAdded: "#00a240", diffRemoved: "#ba2623", skill: "#924ff7" } },
};
const SURFACE_KEYS = ["editor.background", "sideBar.background", "editorGroupHeader.tabsBackground", "panel.background", "activityBar.background"];
const INK_KEYS = ["editor.foreground", "sideBarTitle.foreground", "sideBar.foreground", "foreground"];
const ACCENT_KEYS = ["activityBarBadge.background", "textLink.foreground", "editorCursor.foreground", "focusBorder", "button.background", "activityBar.activeBorder"];

function parse(hex) {
	if (typeof hex !== "string") return undefined;
	const t = hex.trim();
	if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(t)) return undefined;
	const a = t.length === 9 ? t.slice(7, 9) : "ff";
	return { alpha: parseInt(a, 16) / 255, red: parseInt(t.slice(1, 3), 16), green: parseInt(t.slice(3, 5), 16), blue: parseInt(t.slice(5, 7), 16) };
}
const chroma = (c) => Math.max(c.red, c.green, c.blue) - Math.min(c.red, c.green, c.blue);
const toHex = (c) => `#${[c.red, c.green, c.blue].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function pick(value, { minimumAlpha = 0.98, minimumChromaticRange = 0 } = {}) {
	const c = parse(value);
	if (!c || c.alpha < minimumAlpha || chroma(c) < minimumChromaticRange) return undefined;
	return toHex(c);
}
const dist = (a, b) => Math.sqrt((a.red - b.red) ** 2 + (a.green - b.green) ** 2 + (a.blue - b.blue) ** 2);
const near = (a, b) => { const x = parse(a), y = parse(b); return x && y ? dist(x, y) < 42 : false; };
function score(e, t, n) { const r = parse(e), i = parse(t), a = parse(n); return r && i && a ? chroma(r) + dist(r, i) / 4 + dist(r, a) / 4 : 0; }
function first(colors, keys) { if (!colors) return undefined; for (const k of keys) { const v = pick(colors[k]); if (v) return v; } }
function accentOf(theme, surface, ink) {
	for (const k of ACCENT_KEYS) {
		const v = pick(theme.colors?.[k], { minimumAlpha: 0.45, minimumChromaticRange: 24 });
		if (v && !near(v, surface) && !near(v, ink)) return v;
	}
	let best, bestScore = -1;
	for (const rule of [...(theme.tokenColors ?? []), ...(theme.settings ?? [])]) {
		const v = pick(rule.settings?.foreground, { minimumAlpha: 0.45, minimumChromaticRange: 24 });
		if (!v || near(v, surface) || near(v, ink)) continue;
		const s = score(v, surface, ink);
		if (s > bestScore) { best = v; bestScore = s; }
	}
	return best;
}
function seedOf(theme, variant) {
	const d = KJ[variant];
	const surface = first(theme.colors, SURFACE_KEYS) ?? d.surface;
	const ink = first(theme.colors, INK_KEYS) ?? d.ink;
	const accent = accentOf(theme, surface, ink) ?? d.accent;
	let seed = { accent, ink, surface, contrast: d.contrast };
	if (theme.chromeTheme) seed = { ...seed, ...theme.chromeTheme };
	for (const k of ["accent", "ink", "surface"]) seed[k] = seed[k].toLowerCase();
	return seed;
}

// --- Codex chrome mixing (kba / Fba / Iba / Nba / jba) -----------------------
const BLACK = { red: 0, green: 0, blue: 0 };
const WHITE = { red: 255, green: 255, blue: 255 };
const mix = (a, b, t) => { const r = Math.min(1, Math.max(0, t)); return { red: Math.round(a.red + (b.red - a.red) * r), green: Math.round(a.green + (b.green - a.green) * r), blue: Math.round(a.blue + (b.blue - a.blue) * r) }; };
const DEFAULT_CONTRAST = { dark: 60, light: 45 };
function normContrast(e, variant) {
	const n = DEFAULT_CONTRAST[variant], r = n / 100, i = e / 100 + ((e - n) / 60) * 0.7;
	return e <= n ? i : r + (i - r) * 2;
}

function owlTokens(seed, variant) {
	const c = normContrast(seed.contrast, variant);
	const surface = parse(seed.surface), ink = parse(seed.ink), accent = parse(seed.accent);
	const underAmount = { dark: 0.16, light: 0.04 }[variant] + (seed.contrast - DEFAULT_CONTRAST[variant]) * { dark: 0.0015, light: 0.0012 }[variant];
	const under = variant === "light" ? mix(surface, ink, underAmount) : mix(surface, BLACK, underAmount);
	const dark = variant === "dark";
	const panel = dark ? mix(surface, ink, 0.04 + c * 0.05) : mix(surface, WHITE, 0.08 + c * 0.08);
	// owl 的悬停常叠在面板上，深色档要比面板（0.04 + 0.05c）再亮一档才看得出。
	const hoverA = dark ? 0.07 + c * 0.07 : 0.08 + c * 0.04;
	const activeA = dark ? 0.1 + c * 0.08 : 0.16 + c * 0.08;
	// owl 靠描边分区比 Codex 多，边框在 Codex 的 border 上再加一档。
	const borderA = 0.06 + c * 0.04 + 0.03;
	const mutedA = 0.65 + c * 0.1;
	const faintA = (dark ? 0.42 : 0.45) + c * 0.1;
	const on = (base) => ({
		hover: toHex(mix(base, ink, hoverA)),
		active: toHex(mix(base, ink, activeA)),
		border: toHex(mix(base, ink, borderA)),
		muted: toHex(mix(base, ink, mutedA)),
		faint: toHex(mix(base, ink, faintA)),
	});
	const main = on(surface);
	const side = on(under);
	return {
		bg: toHex(surface),
		sidebar: toHex(under),
		rail: toHex(dark ? mix(under, BLACK, 0.18) : mix(under, ink, 0.035)),
		panel: toHex(panel),
		bubble: toHex(mix(surface, ink, 0.05)),
		hover: main.hover,
		border: main.border,
		text: toHex(ink),
		muted: main.muted,
		faint: main.faint,
		accent: toHex(accent),
		accentHover: toHex(dark ? mix(accent, WHITE, 0.15) : mix(accent, BLACK, 0.12)),
		sidebarSurface: toHex(dark ? mix(under, ink, 0.04 + c * 0.05) : mix(under, WHITE, 0.6)),
		sidebarHover: side.hover,
		sidebarSelected: side.active,
		sidebarBorder: side.border,
		sidebarMuted: side.muted,
		sidebarFaint: side.faint,
		menuHover: toHex(mix(panel, ink, activeA)),
	};
}

// --- emit ------------------------------------------------------------------
const themes = [];
for (const entry of registry) {
	const id = SN[entry.key];
	const meta = labels[entry.key];
	const variants = {};
	for (const variant of ["dark", "light"]) {
		const file = entry.files[variant];
		if (!file) continue;
		const mod = await import(pathToFileURL(path.join(assets, file)).href);
		const theme = mod.default ?? mod;
		const seed = seedOf(theme, variant);
		variants[variant] = { seed, tokens: owlTokens(seed, variant) };
	}
	// Codex's menu shows its default "codex" theme as a top-level "ChatGPT" item above the "Codex themes" submenu.
	themes.push({ id, label: id === "codex" ? "ChatGPT" : meta.label, variants });
}
themes.sort((a, b) => (a.id === "codex" ? -1 : b.id === "codex" ? 1 : a.label.localeCompare(b.label, "en", { sensitivity: "base" })));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "codex-themes.json"), JSON.stringify(themes, null, "\t"));
console.log(themes.map((t) => `${t.id}: ${Object.entries(t.variants).map(([v, x]) => `${v} bg=${x.tokens.bg} fg=${x.tokens.text} accent=${x.tokens.accent}`).join(" | ")}`).join("\n"));
