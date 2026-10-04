import { getUiLanguage, t } from "../../i18n/index.ts";

/** settings.json 的 plugins 条目：npm:/git/本地目录/本地单文件统一形态。 */
export type PluginEntry =
	| string
	| {
			source: string;
			disabled?: boolean;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export type PluginType = "npm" | "git" | "local-file" | "local-dir";

export type ArchiveEntry = { sessionId: string; archivedAt: string };

export type ArchiveConfigResult = { retentionDays: number; sessions: ArchiveEntry[] };

export type SessionListRow = { id?: string; name?: string; firstMessage?: string; cwd?: string; parentSessionPath?: string };

/** 会话显示名（与侧边栏同规则）：自定义名 > 首条用户消息 > id 前缀。无名分支会话
 * 追加「· 分支」（fork 时已持久化「forkN · 来自「…」」名字的不重复加）。 */
export function sessionDisplayName(row: SessionListRow): string {
	const named = row.name?.trim();
	if (named) return named;
	const first = row.firstMessage?.trim().replace(/\s+/g, " ");
	let base: string;
	if (first) base = first.length > 48 ? `${first.slice(0, 48)}…` : first;
	else if (row.id) base = t("settings.sessionFallback", { id: row.id.slice(0, 8) });
	else base = t("settings.sessionUnnamed");
	return row.parentSessionPath ? `${base} · ${t("app.branchSuffix")}` : base;
}

/** 距自动删除还剩几天（保留期 - 已归档天数）。 */
export function daysLeft(archivedAt: string, retentionDays: number): number {
	const t = Date.parse(archivedAt);
	if (!Number.isFinite(t)) return retentionDays;
	return retentionDays - Math.floor((Date.now() - t) / 86_400_000);
}

export function formatDateTime(iso: string): string {
	const t = new Date(iso);
	return Number.isFinite(t.getTime())
		? t.toLocaleString(getUiLanguage() === "en" ? "en-US" : "zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
		: iso;
}

/** Token 数的紧凑显示：<1K 原样，之后 1.2K / 3.4M / 1.2G（统计卡与图表共用）。 */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
	return `${(n / 1_000_000_000).toFixed(1)}G`;
}

/** 费用显示：无记录（0）显示 —，小额保留 4 位避免看到 $0.00。 */
export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "—";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1000) return `$${n.toFixed(2)}`;
	return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** 「更新于 HH:MM:SS」用（实时刷新的时间戳要能看到秒级跳动）。 */
export function formatClock(iso: string): string {
	const d = new Date(iso);
	return Number.isFinite(d.getTime())
		? d.toLocaleTimeString(getUiLanguage() === "en" ? "en-US" : "zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
		: iso;
}

export function pluginSourceLabel(entry: PluginEntry): string {
	return typeof entry === "string" ? entry : entry.source;
}

/** 按来源字符串判定插件类型（与加载管线的路由一致）。 */
export function pluginType(source: string): PluginType {
	if (source.startsWith("npm:")) return "npm";
	if (/^(git|ssh|https?):/i.test(source) || source.endsWith(".git") || /^git@/i.test(source)) return "git";
	if (/\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(source)) return "local-file";
	return "local-dir";
}

/** 插件类型的展示名（npm/git 本身就是通用写法，原样展示）。 */
export function pluginTypeLabel(type: PluginType): string {
	if (type === "local-file") return t("settings.plugins.typeLocalFile");
	if (type === "local-dir") return t("settings.plugins.typeLocalDir");
	return type;
}

export function pluginBadgeClass(type: PluginType): string {
	switch (type) {
		case "npm":
			return "border-sky-400/30 text-sky-400";
		case "git":
			return "border-violet-400/30 text-violet-400";
		case "local-file":
			return "border-emerald-400/30 text-emerald-400";
		default:
			return "border-amber-400/30 text-amber-400";
	}
}

/** 启停切换：字符串 → 对象（停用）；重新启用且对象只剩 source 时折叠回字符串。 */
export function togglePluginEntry(entry: PluginEntry): PluginEntry {
	if (typeof entry === "string") return { source: entry, disabled: true };
	if (!entry.disabled) return { ...entry, disabled: true };
	const { disabled: _disabled, ...rest } = entry;
	return Object.keys(rest).length === 1 ? rest.source : rest;
}
