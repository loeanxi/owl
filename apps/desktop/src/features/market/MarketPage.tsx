import { useEffect, useMemo, useRef, useState } from "react";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import {
	buildImportPrompt,
	isMarketStale,
	loadMarket,
	MARKET_CATS,
	type MarketPlugin,
	type MarketSnapshot,
	type MarketSrc,
	peekMarket,
} from "./market-service.ts";
import "./market.css";

/** 引入记录在应用运行期内记忆（模块级）：回到市场页还能看到「已引入」，重启即清零。 */
const importedKeys = new Set<string>();

const EMPTY: MarketSnapshot = { plugins: [], dshTotal: 0, piTotal: 0 };

type SortKey = "dl" | "stars" | "new" | "name";
const SORT_KEYS: SortKey[] = ["dl", "stars", "new", "name"];

/** 主键相同或缺失时按下载量兜底，保证顺序稳定。 */
const SORTERS: Record<SortKey, (a: MarketPlugin, b: MarketPlugin) => number> = {
	dl: (a, b) => (b.dl ?? -1) - (a.dl ?? -1),
	stars: (a, b) => b.stars - a.stars || (b.dl ?? -1) - (a.dl ?? -1),
	new: (a, b) => (b.added ?? "").localeCompare(a.added ?? "") || (b.dl ?? -1) - (a.dl ?? -1),
	name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
};

function fmtCount(n: number | null): string {
	if (n === null) return "—";
	if (getUiLanguage() === "zh") {
		if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}万`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return String(n);
	}
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function initials(name: string): string {
	return name.replace(/^(dsh-|DSH-|pi-|@[^/]+\/)/, "").slice(0, 2).toUpperCase();
}

function relTime(at: number | undefined, lang: "zh" | "en"): string {
	if (!at) return "—";
	const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
	if (lang === "zh") return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
	return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function SourceBadge({ plugin }: { plugin: MarketPlugin }): React.JSX.Element {
	const t = useT();
	return <span className={`owl-market-badge ${plugin.src === "pi" ? "is-pi" : "is-adapt"}`}>{t(plugin.src === "pi" ? "market.badgePi" : "market.badgeDsh")}</span>;
}

/**
 * 「插件市场」：实时聚合 pi 生态与 DSH 社区插件；目录列表 + 右侧详情抽屉。
 * 两个源的插件均非 owl 原生，点「引入」组装改造任务书交给 App 开新会话，由 Agent 按流程自适应改造。
 */
export function MarketPage({ active, connected, agentDir, workspaceDir, onImport }: {
	active: boolean;
	/** 桥连接状态：引入需要新开会话，未连接时禁用。 */
	connected: boolean;
	/** owl agent 配置目录：改造产物（npm/skills/themes）的安装目标。 */
	agentDir: string;
	workspaceDir: string;
	/** App 侧实现：新开会话、发出任务书并跳转；失败时 reject，由页面回滚按钮态。 */
	onImport: (promptText: string) => Promise<void>;
}): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [snapshot, setSnapshot] = useState<MarketSnapshot>(EMPTY);
	const [loading, setLoading] = useState(false);
	const [source, setSource] = useState<MarketSrc | "all">("all");
	const [cat, setCat] = useState("all");
	const [query, setQuery] = useState("");
	const [selKey, setSelKey] = useState("dsh:billion-context");
	const [importing, setImporting] = useState<string>();
	const [importError, setImportError] = useState<string>();
	const [srcPopOpen, setSrcPopOpen] = useState(false);
	const [sort, setSort] = useState<SortKey>("dl");
	const [sortOpen, setSortOpen] = useState(false);
	const sortRef = useRef<HTMLDivElement>(null);
	const [importedBump, setImportedBump] = useState(0);
	const loadSeq = useRef(0);

	useEffect(() => {
		if (!sortOpen) return;
		const onDown = (event: MouseEvent): void => {
			if (!sortRef.current?.contains(event.target as Node)) setSortOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [sortOpen]);

	const load = async (force: boolean): Promise<void> => {
		const seq = ++loadSeq.current;
		if (force || isMarketStale()) setLoading(true);
		try {
			const next = await loadMarket(force);
			if (seq === loadSeq.current) setSnapshot(next);
		} finally {
			if (seq === loadSeq.current) setLoading(false);
		}
	};

	// 每次进入：先秒开本地快照，再由 loadMarket 判断是否过期、过期才后台刷新。
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void (async () => {
			const cached = await peekMarket();
			if (cancelled) return;
			if (cached) setSnapshot((cur) => (cur.plugins.length > 0 ? cur : cached));
			await load(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [active]); // eslint-disable-line react-hooks/exhaustive-deps

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return snapshot.plugins.filter((p) =>
			(source === "all" || p.src === source)
			&& (cat === "all" || p.cat === cat)
			&& (!q || `${p.name} ${p.descZh} ${p.descEn} ${p.owner}`.toLowerCase().includes(q)))
			.sort(SORTERS[sort]);
	}, [snapshot, source, cat, query, sort]);

	const selected = filtered.find((p) => p.key === selKey) ?? filtered[0];

	const importState = (key: string): "idle" | "run" | "ok" => {
		if (importing === key) return "run";
		return importedKeys.has(key) ? "ok" : "idle";
	};

	const doImport = async (plugin: MarketPlugin): Promise<void> => {
		if (!connected || importing) return;
		setImporting(plugin.key);
		setImportError(undefined);
		try {
			await onImport(buildImportPrompt(plugin, agentDir, workspaceDir));
			importedKeys.add(plugin.key);
			setImportedBump((n) => n + 1);
		} catch (error) {
			setImportError(error instanceof Error ? error.message : String(error));
		} finally {
			setImporting(undefined);
		}
	};

	const catCount = (key: string): number => snapshot.plugins.filter((p) => (source === "all" || p.src === source) && (key === "all" || p.cat === key)).length;

	return (
		<div className="owl-market" data-active={active ? "true" : "false"} data-imported-bump={importedBump}>
			<div className="owl-market-head">
				<div className="owl-market-head-text">
					<div className="owl-market-title">{t("market.title")}</div>
					<div className="owl-market-sub">
						{t("market.subtitle", {
							dsh: snapshot.dshTotal || "—",
							pi: snapshot.piTotal || "—",
						})}
					</div>
				</div>
				<div className="owl-market-srcwrap">
					<button type="button" className="owl-market-srcpill" onClick={() => setSrcPopOpen((v) => !v)}>
						<span className="owl-market-livedot" aria-hidden="true" />
						{t("market.sources")}
						{loading && snapshot.plugins.length > 0 && <span className="owl-market-srcpill-busy">· {t("market.refreshing")}</span>}
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
					</button>
					{srcPopOpen && (
						<div className="owl-market-srcpop" role="dialog">
							<div className="owl-market-srcitem">
								<div className="owl-market-srcitem-t">
									<span className="owl-market-livedot" aria-hidden="true" />
									{t("market.srcPiName")}
									<span className="owl-market-srcitem-cnt">{snapshot.piTotal ? `× ${snapshot.piTotal}` : "—"}</span>
								</div>
								<div className="owl-market-srcitem-d">{t("market.srcPiDesc")}</div>
								<div className="owl-market-srcitem-ep">registry.npmjs.org · keywords:pi-package · {relTime(snapshot.piAt, lang)}</div>
							</div>
							<div className="owl-market-srcitem">
								<div className="owl-market-srcitem-t">
									<span className="owl-market-livedot" aria-hidden="true" />
									{t("market.srcDshName")}
									<span className="owl-market-srcitem-cnt">{snapshot.dshTotal ? `× ${snapshot.dshTotal}` : "—"}</span>
								</div>
								<div className="owl-market-srcitem-d">{t("market.srcDshDesc")}</div>
								<div className="owl-market-srcitem-ep">awesome-dsh-plugin.com/plugins.json · {relTime(snapshot.dshAt, lang)}</div>
							</div>
							{snapshot.dshError || snapshot.piError ? (
								<button type="button" className="owl-market-srcretry" disabled={loading} onClick={() => void load(true)}>
									{t("market.retry")} · {snapshot.piError ?? snapshot.dshError}
								</button>
							) : (
								<button type="button" className="owl-market-srcretry" disabled={loading} onClick={() => void load(true)}>
									{loading ? t("market.refreshing") : t("market.refreshNow")}
								</button>
							)}
							<div className="owl-market-srcfoot">{t("market.srcFoot")}</div>
						</div>
					)}
				</div>
			</div>

			<div className="owl-market-toolbar">
				<div className="owl-market-seg" role="tablist">
					{(["all", "pi", "dsh"] as const).map((key) => (
						<button key={key} type="button" className={source === key ? "is-on" : undefined} onClick={() => setSource(key)}>
							{t(key === "all" ? "market.srcAll" : key === "pi" ? "market.srcPi" : "market.srcDsh")}
						</button>
					))}
				</div>
				<label className="owl-market-search">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
					<input value={query} placeholder={t("market.search")} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<div className="owl-market-sort" ref={sortRef}>
					<button type="button" className="owl-market-sort-btn" aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => setSortOpen((v) => !v)}>
						{t("market.sortBy", { label: t(`market.sort.${sort}`) })}
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
					</button>
					{sortOpen && (
						<div className="owl-market-sort-pop" role="listbox">
							{SORT_KEYS.map((key) => (
								<button
									key={key}
									type="button"
									role="option"
									aria-selected={sort === key}
									className={sort === key ? "is-on" : undefined}
									onClick={() => {
										setSort(key);
										setSortOpen(false);
									}}
								>{t(`market.sort.${key}`)}</button>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="owl-market-cats">
				<button type="button" className={`owl-market-chip${cat === "all" ? " is-on" : ""}`} onClick={() => setCat("all")}>
					{t("market.catAll")}<span className="owl-market-chip-n">{catCount("all")}</span>
				</button>
				{MARKET_CATS.filter((c) => catCount(c.key) > 0).map((c) => (
					<button key={c.key} type="button" className={`owl-market-chip${cat === c.key ? " is-on" : ""}`} onClick={() => setCat(c.key)}>
						{lang === "zh" ? c.zh : c.en}<span className="owl-market-chip-n">{catCount(c.key)}</span>
					</button>
				))}
			</div>

			<div className="owl-market-body">
				<div className="owl-market-list" role="listbox" aria-label={t("market.title")}>
					{loading && snapshot.plugins.length === 0 && <div className="owl-market-state">{t("market.loading")}</div>}
					{!loading && snapshot.plugins.length === 0 && (snapshot.dshError || snapshot.piError) && (
						<div className="owl-market-state">
							{t("market.loadFailed", { message: snapshot.piError ?? snapshot.dshError ?? "" })}
							<button type="button" className="owl-market-retry" onClick={() => void load(true)}>{t("market.retry")}</button>
						</div>
					)}
					{snapshot.plugins.length > 0 && filtered.length === 0 && <div className="owl-market-state">{t("market.empty")}</div>}
					{filtered.map((p) => {
						const state = importState(p.key);
						return (
							<button
								key={p.key}
								type="button"
								role="option"
								aria-selected={selected?.key === p.key}
								className={`owl-market-prow${selected?.key === p.key ? " is-sel" : ""}`}
								onClick={() => setSelKey(p.key)}
							>
								<span className="owl-market-ico">{initials(p.name)}</span>
								<span className="owl-market-prow-mid">
									<span className="owl-market-prow-l1">
										<span className="owl-market-prow-nm">{p.name}</span>
										{p.ver && <span className="owl-market-prow-v">{p.ver}</span>}
										<SourceBadge plugin={p} />
										{state === "ok" && <span className="owl-market-badge is-done">{t("market.importedBadge")}</span>}
									</span>
									<span className="owl-market-prow-ds">{(lang === "zh" ? p.descZh : p.descEn) || p.descEn}</span>
								</span>
								<span className="owl-market-prow-st">
									<b>{fmtCount(p.dl)}</b>/mo
									<span className="owl-market-prow-stars">★ {fmtCount(p.stars || 0)}</span>
								</span>
							</button>
						);
					})}
				</div>

				<aside className="owl-market-drawer">
					{selected ? (
						<>
							<div className="owl-market-drawer-hd">
								<span className="owl-market-ico is-big">{initials(selected.name)}</span>
								<span className="owl-market-drawer-title">
									<span className="owl-market-drawer-nm">
										{selected.name}
										{selected.ver && <span className="owl-market-prow-v"> {selected.ver}</span>}
									</span>
									<span className="owl-market-drawer-ow">by {selected.owner} · ★ {fmtCount(selected.stars || 0)} · {fmtCount(selected.dl)}/mo</span>
								</span>
								{importState(selected.key) === "ok" && <span className="owl-market-badge is-done">{t("market.importedBadge")}</span>}
							</div>
							<div className="owl-market-desc">{(lang === "zh" ? selected.descZh : selected.descEn) || selected.descEn}</div>
							<div className="owl-market-kv">
								<span className="owl-market-kv-k">{t("market.kSource")}</span>
								<span>{t(selected.src === "pi" ? "market.srcPiValue" : "market.srcDshValue")}</span>
								<span className="owl-market-kv-k">{t("market.kCategory")}</span>
								<span>{lang === "zh" ? MARKET_CATS.find((c) => c.key === selected.cat)?.zh : MARKET_CATS.find((c) => c.key === selected.cat)?.en}</span>
								<span className="owl-market-kv-k">{t("market.kPerms")}</span>
								<span className="owl-market-caps">
									{selected.caps.length === 0 && selected.red.length === 0
										? <span className="owl-market-badge is-cap">{t("market.noPerms")}</span>
										: selected.caps.map((c) => <span key={c} className="owl-market-badge is-cap">{c}</span>)}
									{selected.red.map((c) => <span key={c} className="owl-market-badge is-red">{t("market.redLine", { name: c })}</span>)}
								</span>
								<span className="owl-market-kv-k">{t("market.kInstallAs")}</span>
								<span>{t("market.installAs")}</span>
							</div>
							<div className="owl-market-hint">{t(selected.src === "pi" ? "market.hintPi" : "market.hintDsh")}</div>
							<div className="owl-market-acts">
								{importState(selected.key) === "ok"
									? <button type="button" className="owl-market-import" disabled>{t("market.imported")}</button>
									: <button
										type="button"
										className="owl-market-import"
										disabled={!connected || importState(selected.key) === "run"}
										onClick={() => void doImport(selected)}
									>{importState(selected.key) === "run" ? t("market.importing") : t("market.import")}</button>}
								<a className="owl-market-repo" href={selected.url} target="_blank" rel="noreferrer">{t("market.repo")}</a>
							</div>
							{importError && <div className="owl-market-import-error">{t("market.importFailed", { message: importError })}</div>}
							<div className="owl-market-pipe">
								<div className="owl-market-pipe-t">{t("market.pipeTitle")}</div>
								{(["pull", "analyze", "map", "generate", "install", "verify"] as const).map((stepKey) => (
									<div key={stepKey} className="owl-market-step"><span className="owl-market-step-dot" aria-hidden="true" /><span>{t(`market.step.${stepKey}`)}</span></div>
								))}
								<div className="owl-market-pipe-note">{t("market.pipeNote")}</div>
							</div>
						</>
					) : (
						<div className="owl-market-state">{t("market.empty")}</div>
					)}
				</aside>
			</div>
		</div>
	);
}
