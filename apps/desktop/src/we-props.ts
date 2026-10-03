/**
 * WE 壁纸用户属性解析（`project.json` 的 `general.properties`）+ 显隐条件求值 + 颜色转换。
 *
 * 移植自 dsh-wallpaper-engine 的 lib/we-props.js 与 src/we-cond.js（MIT），语义是上游按
 * 上千个真实属性校准出的反直觉结论，别顺手"简化"：
 *  - `order` 浮点升序，并列按**码位**比较（localeCompare 会重排同 order 属性）；
 *  - `combo` 选项值保留声明 JSON 类型（整数/字符串/布尔混用是常态）；
 *  - 文案按 zh-chs → zh-cht → en-us **逐键**回退（表是残缺的）；
 *  - `text` 类型是分节标题，不是输入框；
 *  - condition 只影响面板显隐，**下发绝不过滤**；
 *  - `editable: false` 整条丢弃（面板与 seed 都不含）。
 */

/** 支持的语言标签（按序逐键回退）；表里大小写不敏感 */
const LANG_ORDER = ["zh-chs", "zh-cht", "en-us"];

const KNOWN_TYPES = new Set([
	"color", "bool", "slider", "combo", "text", "textinput",
	"file", "directory", "group", "other",
]);

const FILE_EXT: Record<string, string[]> = {
	image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".apng", ".svg"],
	video: [".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"],
	audio: [".mp3", ".ogg", ".oga", ".wav", ".m4a", ".flac", ".aac"],
};

export interface WallpaperPropOption {
	label: string;
	value: unknown;
	condition?: string;
}

export interface WallpaperPropDef {
	name: string;
	ptype: "color" | "bool" | "slider" | "combo" | "text" | "textinput" | "file" | "directory" | "group" | "other";
	text: string;
	order: number;
	value: unknown;
	default: unknown;
	overridden: boolean;
	condition?: string;
	options?: WallpaperPropOption[];
	min?: number;
	max?: number;
	step?: number;
	precision?: number;
	fileType?: string;
	files?: string[];
}

interface RawPropDef {
	[k: string]: unknown;
	type?: unknown;
	value?: unknown;
	text?: unknown;
	order?: unknown;
	editable?: unknown;
	condition?: unknown;
	options?: unknown;
	min?: unknown;
	max?: unknown;
	step?: unknown;
	precision?: unknown;
	fileType?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function orderOf(def: RawPropDef): number {
	const n = Number(def.order);
	return Number.isFinite(n) ? n : 0;
}

function strField(v: RawPropDef | Record<string, unknown>, key: string): string | undefined {
	const s = v[key];
	if (typeof s !== "string") return undefined;
	const t = s.trim();
	return t === "" ? undefined : t;
}

/** 去标签 + 解常见实体（WE 属性文案里带 HTML 是常态） */
function stripHtml(raw: string): string {
	return raw
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;|&apos;/gi, "'")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

function lookupLocalization(project: unknown, key: string): string | undefined {
	const general = asRecord(asRecord(project).general);
	const table = asRecord(general.localization);
	if (!Object.keys(table).length) return undefined;
	const byLang: Record<string, unknown> = {};
	for (const k of Object.keys(table)) byLang[k.toLowerCase()] = table[k];
	for (const lang of LANG_ORDER) {
		const entry = asRecord(byLang[lang]);
		if (typeof entry[key] === "string") return entry[key] as string;
	}
	return undefined;
}

function resolveText(project: unknown, raw: string, key: string, fallback: string): string {
	const loc = lookupLocalization(project, key);
	const src = typeof loc === "string" && loc.trim() !== "" ? loc : raw;
	const clean = stripHtml(src);
	return clean !== "" ? clean : fallback;
}

/** project.json 属性值 → WE 线格式；无值（如未选文件的 file）返回 undefined */
function wireValue(ptype: string, def: RawPropDef): unknown {
	if (!("value" in def) || def.value === null || def.value === undefined) return undefined;
	const raw = def.value;
	switch (ptype) {
		case "color":
			return typeof raw === "string" ? raw : undefined;
		case "bool":
			return typeof raw === "boolean" ? raw : undefined;
		case "slider": {
			const n = typeof raw === "number" ? raw : Number(raw);
			return Number.isFinite(n) ? n : undefined;
		}
		case "combo":
			return raw; // 保留声明类型（数字 / 字符串 / 布尔混用）
		default:
			return typeof raw === "string" ? raw : JSON.stringify(raw);
	}
}

function rawProps(project: unknown): [string, RawPropDef][] {
	const general = asRecord(asRecord(project).general);
	const props = asRecord(general.properties);
	const out = Object.entries(props).filter(
		(entry): entry is [string, RawPropDef] =>
			typeof entry[1] === "object" && entry[1] !== null && typeof (entry[1] as RawPropDef).type === "string",
	);
	out.sort((a, b) => orderOf(a[1]) - orderOf(b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return out;
}

/** 解析成面板用的属性列表。overrides = 用户覆盖值 {name: wireValue} */
export function parseUserPropDefs(
	project: unknown,
	overrides: Record<string, unknown> | undefined,
	opts: { filePrefix?: string; listFiles?: string[] } = {},
): WallpaperPropDef[] {
	const ov = overrides ?? {};
	const filePrefix = typeof opts.filePrefix === "string" ? opts.filePrefix : "";
	const out: WallpaperPropDef[] = [];
	for (const [name, rawDef] of rawProps(project)) {
		// 作者标记「用户不可编辑」：整条丢弃（上游同语义）
		if (rawDef.editable === false) continue;
		const ptype = String(rawDef.type ?? "other");
		const kind = (KNOWN_TYPES.has(ptype) ? ptype : "other") as WallpaperPropDef["ptype"];
		const dflt = wireValue(kind, rawDef);
		const overridden = Object.prototype.hasOwnProperty.call(ov, name);
		let value = overridden ? ov[name] : dflt;
		// file：值相对壁纸根存储，下发时按入口目录补前缀（空值不补）
		if (kind === "file" && typeof value === "string" && value !== "" && filePrefix) value = `${filePrefix}${value}`;
		const entry: WallpaperPropDef = {
			name,
			ptype: kind,
			text: resolveText(project, typeof rawDef.text === "string" ? rawDef.text : "", name, name),
			order: orderOf(rawDef),
			value: value === undefined ? null : value,
			default: dflt === undefined ? null : dflt,
			overridden,
		};
		const cond = strField(rawDef, "condition");
		if (cond) entry.condition = cond;
		if (Array.isArray(rawDef.options)) {
			const options = (rawDef.options as unknown[])
				.map((o) => asRecord(o))
				.filter((o) => typeof o.label === "string" && "value" in o)
				.map((o) => {
					const opt: WallpaperPropOption = {
						label: resolveText(
							project,
							o.label as string,
							o.label as string,
							typeof o.value === "string" ? o.value : JSON.stringify(o.value),
						),
						value: o.value,
					};
					const oc = strField(o, "condition");
					if (oc) opt.condition = oc;
					return opt;
				});
			if (options.length) entry.options = options;
		}
		if (Number.isFinite(Number(rawDef.min))) entry.min = Number(rawDef.min);
		if (Number.isFinite(Number(rawDef.max))) entry.max = Number(rawDef.max);
		if (Number.isFinite(Number(rawDef.step))) entry.step = Number(rawDef.step);
		if (Number.isFinite(Number(rawDef.precision))) entry.precision = Number(rawDef.precision);
		const ft = strField(rawDef, "fileType");
		if (ft) entry.fileType = ft;
		if ((kind === "file" || kind === "directory") && Array.isArray(opts.listFiles)) {
			const exts = ft ? FILE_EXT[ft] ?? null : null;
			const files = (opts.listFiles as string[]).filter((f) => {
				if (exts === null) return true;
				const lower = f.toLowerCase();
				return exts.some((e) => lower.endsWith(e));
			});
			if (files.length) entry.files = files.slice(0, 200);
		}
		out.push(entry);
	}
	return out;
}

/** 入口文件的目录前缀（相对壁纸根，带末尾 /；根入口为空串） */
export function entryDirPrefix(entryRel: unknown): string {
	if (typeof entryRel !== "string") return "";
	const rel = entryRel.trim().replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) return "";
	const i = rel.lastIndexOf("/");
	return i < 0 ? "" : rel.slice(0, i + 1);
}

// ---------------------------------------------------------------- 显隐条件求值

const WE_COND_OPS = ["===", "!==", "&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")", ".", "-"];
const weCondCache = new Map<string, ((v: Record<string, unknown>) => boolean) | null>();

type WeCondToken = { k: "str"; v: string } | { k: "num"; v: string } | { k: "id"; v: string } | { k: "op"; v: string };

function weCondTokenize(src: string): WeCondToken[] {
	const out: WeCondToken[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
		if (c === "'" || c === '"') {
			const end = src.indexOf(c, i + 1);
			if (end < 0) throw new Error("unterminated string");
			out.push({ k: "str", v: src.slice(i + 1, end) });
			i = end + 1;
			continue;
		}
		if (c >= "0" && c <= "9") {
			let j = i;
			while (j < src.length && /[0-9.]/.test(src[j])) j++;
			out.push({ k: "num", v: src.slice(i, j) });
			i = j;
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			let j = i;
			while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
			out.push({ k: "id", v: src.slice(i, j) });
			i = j;
			continue;
		}
		const op = WE_COND_OPS.find((o) => src.startsWith(o, i));
		if (!op) throw new Error(`bad char ${c}`);
		out.push({ k: "op", v: op });
		i += op.length;
	}
	return out;
}

/** 宽松相等：值经 project.json → 宿主 wire → JSON → JS 传递，"1" 与 1 混用是常态 */
function weCondLooseEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined || a === null || b === undefined || b === null) {
		return (a === undefined || a === null) && (b === undefined || b === null);
	}
	if (typeof a === typeof b) return false;
	const na = Number(a);
	const nb = Number(b);
	return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}

function weCondNumCmp(a: unknown, b: unknown, op: string): boolean {
	const x = Number(a);
	const y = Number(b);
	if (Number.isNaN(x) || Number.isNaN(y)) return false;
	if (op === ">") return x > y;
	if (op === "<") return x < y;
	if (op === ">=") return x >= y;
	return x <= y;
}

type WeCondNode = (v: Record<string, unknown>) => unknown;

function weCondParse(tokens: WeCondToken[]): WeCondNode {
	let pos = 0;
	const peek = (): WeCondToken | undefined => tokens[pos];
	const eat = (v: string): void => {
		const t = peek();
		if (!t || t.k !== "op" || t.v !== v) throw new Error(`expect ${v}`);
		pos++;
	};
	function or(): WeCondNode {
		let left = and();
		for (;;) {
			const t = peek();
			if (!t || t.k !== "op" || t.v !== "||") break;
			pos++;
			const right = and();
			const l = left;
			left = (v) => Boolean(l(v)) || Boolean(right(v));
		}
		return left;
	}
	function and(): WeCondNode {
		let left = cmp();
		for (;;) {
			const t = peek();
			if (!t || t.k !== "op" || t.v !== "&&") break;
			pos++;
			const right = cmp();
			const l = left;
			left = (v) => Boolean(l(v)) && Boolean(right(v));
		}
		return left;
	}
	function cmp(): WeCondNode {
		const left = unary();
		const t = peek();
		if (t && t.k === "op" && ["==", "!=", "===", "!==", ">", "<", ">=", "<="].includes(t.v)) {
			pos++;
			const right = unary();
			const op = t.v;
			if (op === "==" || op === "===") return (v) => weCondLooseEq(left(v), right(v));
			if (op === "!=" || op === "!==") return (v) => !weCondLooseEq(left(v), right(v));
			return (v) => weCondNumCmp(left(v), right(v), op);
		}
		return left;
	}
	function unary(): WeCondNode {
		const t = peek();
		if (t && t.k === "op" && t.v === "!") { pos++; const inner = unary(); return (v) => !inner(v); }
		if (t && t.k === "op" && t.v === "-") { pos++; const inner = unary(); return (v) => -Number(inner(v)); }
		return primary();
	}
	function primary(): WeCondNode {
		const t = peek();
		if (!t) throw new Error("unexpected end");
		if (t.k === "op" && t.v === "(") { pos++; const inner = or(); eat(")"); return inner; }
		if (t.k === "num") { pos++; const n = Number(t.v); if (Number.isNaN(n)) throw new Error("bad num"); return () => n; }
		if (t.k === "str") { pos++; const s = t.v; return () => s; }
		if (t.k === "id") {
			pos++;
			if (t.v === "true") return () => true;
			if (t.v === "false") return () => false;
			const name = t.v;
			// 只认 `ident` 与 `ident.value`；`.text`（赋值语句里的成员）落到 fail open
			const dot = peek();
			if (dot && dot.k === "op" && dot.v === ".") {
				pos++;
				const m = peek();
				if (!m || m.k !== "id" || m.v !== "value") throw new Error("only .value");
				pos++;
			}
			return (v) => v[name];
		}
		throw new Error("unexpected token");
	}
	const root = or();
	if (pos !== tokens.length) throw new Error("trailing tokens");
	return root;
}

/** 属性显隐条件：无条件 / 空条件 / 语法不支持 → 一律可见（fail open） */
export function weEvalCondition(expr: unknown, values: Record<string, unknown>): boolean {
	if (!expr || !String(expr).trim()) return true;
	const key = String(expr);
	let fn = weCondCache.get(key);
	if (fn === undefined) {
		try {
			const node = weCondParse(weCondTokenize(key));
			fn = (v) => Boolean(node(v));
		} catch {
			fn = null; // 不支持的语法 → 恒显示
		}
		weCondCache.set(key, fn);
	}
	if (!fn) return true;
	try {
		return fn(values);
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------- 颜色转换

/** WE 颜色 "r g b"（0..1 浮点）→ #rrggbb */
export function weColorToHex(v: unknown): string {
	if (typeof v !== "string") return "#000000";
	const parts = v.trim().split(/\s+/).map(Number);
	if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return "#000000";
	const hex = parts.slice(0, 3)
		.map((n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0"))
		.join("");
	return `#${hex}`;
}

/** #rrggbb → WE 颜色 "r g b"（0..1 浮点，三位小数） */
export function weHexToColor(hex: unknown): string {
	const h = String(hex ?? "").replace(/^#/, "");
	if (h.length !== 6) return "0 0 0";
	const r = Number.parseInt(h.slice(0, 2), 16) / 255;
	const g = Number.parseInt(h.slice(2, 4), 16) / 255;
	const b = Number.parseInt(h.slice(4, 6), 16) / 255;
	return [r, g, b].map((n) => Math.round(n * 1000) / 1000).join(" ");
}
