import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import {
	GUIDE_CHAPTERS,
	GUIDE_LICENSE_URL,
	GUIDE_REPO_URL,
	fetchGuideChapters,
	guideChapterUrl,
	loadCachedGuide,
	saveCachedGuide,
	type GuideChapter,
	type GuideTip,
} from "./guide-content.ts";
import "./guide.css";
import { UpGuidePanel } from "./UpGuidePanel.tsx";

type GradeFilter = "all" | "A" | "B" | "C" | "disputed";
/** 人生指南视图内的两份指南；选择跨会话记忆。 */
type GuideTab = "better" | "up";
const GUIDE_TAB_KEY = "owl.guide.tab.v1";

interface GuidePanelProps {
	active: boolean;
	/** 外链统一走宿主（open.external → 系统浏览器）。 */
	onOpenUrl: (url: string) => void;
}

interface LoadState {
	status: "idle" | "loading" | "ready" | "error";
	chapters: GuideChapter[];
	savedAt?: string;
	done: number;
	total: number;
}

const URL_RE = /<?(https?:\/\/[^\s>））；;，,]+)>?/g;

/** 来源字段里的 URL 拆成可点链接（原文里是 <https://…> 形态）。 */
function linkify(text: string, onOpenUrl: (url: string) => void, keyBase: string): React.ReactNode[] {
	const nodes: React.ReactNode[] = [];
	let last = 0;
	let index = 0;
	URL_RE.lastIndex = 0;
	for (let match = URL_RE.exec(text); match; match = URL_RE.exec(text)) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		const url = match[1];
		nodes.push(
			<a key={`${keyBase}-${index++}`} href={url} onClick={(event) => { event.preventDefault(); onOpenUrl(url); }}>{url}</a>,
		);
		last = match.index + match[0].length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

/** 人生指南阅读面板：头部双 tab 切换「高性价比人生指南」与「人生进阶指南」，
 *  两个面板懒加载保活（内容抓一次留在内存与 localStorage）。 */
export function GuidePanel({ active, onOpenUrl }: GuidePanelProps): React.JSX.Element {
	const t = useT();
	const [tab, setTab] = useState<GuideTab>(() => (localStorage.getItem(GUIDE_TAB_KEY) === "up" ? "up" : "better"));
	const selectTab = (next: GuideTab): void => {
		setTab(next);
		try {
			localStorage.setItem(GUIDE_TAB_KEY, next);
		} catch {
			// 忽略。
		}
	};
	const [state, setState] = useState<LoadState>({ status: "idle", chapters: [], done: 0, total: GUIDE_CHAPTERS.length });
	const [activeNo, setActiveNo] = useState(1);
	const [query, setQuery] = useState("");
	const [grade, setGrade] = useState<GradeFilter>("all");
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

	const sync = (): void => {
		setState((current) => ({ ...current, status: "loading", done: 0, total: GUIDE_CHAPTERS.length }));
		void fetchGuideChapters((done, total) => setState((current) => ({ ...current, done, total })))
			.then((result) => {
				if (result.chapters.length === 0) {
					setState((current) => ({ ...current, status: "error" }));
					return;
				}
				const savedAt = saveCachedGuide(result.chapters);
				setState({ status: "ready", chapters: result.chapters, savedAt, done: result.chapters.length, total: GUIDE_CHAPTERS.length });
			})
			.catch(() => setState((current) => ({ ...current, status: "error" })));
	};

	useEffect(() => {
		if (!active || tab !== "better" || state.status !== "idle") return;
		const cached = loadCachedGuide();
		if (cached.chapters.length > 0) {
			setState({ status: "ready", chapters: cached.chapters, savedAt: cached.savedAt, done: cached.chapters.length, total: GUIDE_CHAPTERS.length });
			return;
		}
		sync();
		// eslint 只在该 tab 首次激活时触发加载；state.status 变化后不再重入。
	}, [active, tab]);

	const counts = useMemo(() => {
		let total = 0;
		let a = 0;
		let b = 0;
		let c = 0;
		let disputed = 0;
		for (const chapter of state.chapters) {
			for (const tip of chapter.tips) {
				total += 1;
				if (tip.grade === "A") a += 1;
				else if (tip.grade === "B") b += 1;
				else c += 1;
				if (tip.disputed) disputed += 1;
			}
		}
		return { total, a, b, c, disputed };
	}, [state.chapters]);

	const titleOf = useMemo(() => {
		const map = new Map<number, string>(GUIDE_CHAPTERS.map((meta) => [meta.no, meta.title]));
		for (const chapter of state.chapters) map.set(chapter.no, chapter.title);
		return (no: number): string => map.get(no) ?? `第 ${no} 节`;
	}, [state.chapters]);

	const filtering = query.trim() !== "" || grade !== "all";
	const needle = query.trim().toLowerCase();

	const groups = useMemo(() => {
		if (state.status !== "ready") return [];
		const match = (tip: GuideTip): boolean => {
			if (grade === "disputed" ? !tip.disputed : grade !== "all" && tip.grade !== grade) return false;
			if (needle && !(tip.title.toLowerCase().includes(needle) || tip.plain.toLowerCase().includes(needle))) return false;
			return true;
		};
		const scope = filtering ? state.chapters : state.chapters.filter((chapter) => chapter.no === activeNo);
		return scope
			.map((chapter) => ({ chapter, tips: chapter.tips.filter(match) }))
			.filter((group) => group.tips.length > 0);
	}, [state.chapters, state.status, filtering, needle, grade, activeNo]);

	const toggleTip = (key: string): void => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return (
		<div className={`owl-guide${active ? " is-active" : ""}`}>
			<div className="owl-guide-head">
				<span className="owl-guide-avatar" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.4" cy="4.6" r="2.4" /><path d="M13 7.4 11.6 13.4" /><path d="M12.8 8.6 17.2 10.2" /><path d="M12.4 9 8 10.6" /><path d="M11.6 13.4 15 15.8 14.6 19.6" /><path d="M11.6 13.4 8.8 16.6 5.9 19.2" /></svg>
				</span>
				<div className="owl-guide-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab === "better"} className={tab === "better" ? "on" : ""} onClick={() => selectTab("better")}>{t("guide.tabBetter")}</button>
					<button type="button" role="tab" aria-selected={tab === "up"} className={tab === "up" ? "on" : ""} onClick={() => selectTab("up")}>{t("guide.tabUp")}</button>
				</div>
				{tab === "better" && (
					<>
						<label className="owl-guide-search">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={t("guide.searchPlaceholder")}
								aria-label={t("guide.searchPlaceholder")}
							/>
							{query && <button type="button" aria-label="×" onClick={() => setQuery("")}>×</button>}
						</label>
						<span className="owl-guide-sync" data-status={state.status}>
							{state.status === "loading" ? t("guide.loading", { done: state.done, total: state.total })
								: state.status === "error" ? t("guide.fetchFailed")
								: state.savedAt ? t("guide.cachedAt", { date: state.savedAt })
								: ""}
							{(state.status === "ready" || state.status === "error") && (
								<button type="button" onClick={sync}>{t("guide.resync")}</button>
							)}
						</span>
					</>
				)}
			</div>
			{/* 两个 tab 都保活：display:contents 让可见面板的子元素直接参与 .owl-guide 布局。 */}
			<div style={{ display: tab === "better" ? "contents" : "none" }}>
				<div className="owl-guide-filters" role="group">
					<FilterChip current={grade} value="all" label={t("guide.filterAll")} count={counts.total} onPick={setGrade} />
					<FilterChip current={grade} value="A" label={t("guide.filterA")} count={counts.a} onPick={setGrade} />
					<FilterChip current={grade} value="B" label={t("guide.filterB")} count={counts.b} onPick={setGrade} />
					<FilterChip current={grade} value="C" label={t("guide.filterC")} count={counts.c} onPick={setGrade} />
					<FilterChip current={grade} value="disputed" label={t("guide.filterDisputed")} count={counts.disputed} onPick={setGrade} />
					<span className="owl-guide-sort">{t("guide.sortNote")}</span>
				</div>
				<div className="owl-guide-main">
					<nav className="owl-guide-chapters" aria-label={t("titlebar.lifeGuide")}>
						{GUIDE_CHAPTERS.map((meta) => (
							<button
								key={meta.no}
								type="button"
								className={`owl-guide-ch${!filtering && activeNo === meta.no ? " on" : ""}`}
								onClick={() => { setActiveNo(meta.no); setQuery(""); setGrade("all"); }}
							>
								<span className="no">{String(meta.no).padStart(2, "0")}</span>
								<span>{titleOf(meta.no)}</span>
							</button>
						))}
					</nav>
					<div className="owl-guide-stream">
						{state.status === "loading" && (
							<div className="owl-guide-state">
								<p>{t("guide.loading", { done: state.done, total: state.total })}</p>
								<div className="bar"><i style={{ width: `${Math.round((state.done / Math.max(1, state.total)) * 100)}%` }} /></div>
							</div>
						)}
						{state.status === "error" && (
							<div className="owl-guide-state">
								<p className="err">{t("guide.fetchFailed")}</p>
								<p><button type="button" className="owl-guide-linkbtn" onClick={sync}>{t("guide.retry")}</button></p>
							</div>
						)}
						{state.status === "ready" && groups.length === 0 && (
							<div className="owl-guide-state"><p>{t("guide.noMatch")}</p></div>
						)}
						{groups.map(({ chapter, tips }) => (
							<section key={chapter.no} className="owl-guide-section">
								<header className="owl-guide-sec-head">
									<h2>{t("guide.section", { no: chapter.no, title: titleOf(chapter.no) })}</h2>
									<span>{t("guide.sortNote")}</span>
									<a href={guideChapterUrl(chapter.file)} onClick={(event) => { event.preventDefault(); onOpenUrl(guideChapterUrl(chapter.file)); }}>{t("guide.viewChapter")} ↗</a>
								</header>
								{tips.map((tip) => (
									<TipCard
										key={tip.key}
										tip={tip}
										expanded={expanded.has(tip.key)}
										onToggle={() => toggleTip(tip.key)}
										onOpenUrl={onOpenUrl}
									/>
								))}
							</section>
						))}
					</div>
				</div>
				<div className="owl-guide-foot">
					<span>
						{t("guide.attribution")}
						{state.savedAt && ` · ${t("guide.mayLagUpstream", { date: state.savedAt })}`}
					</span>
					<span className="right">
						<a href={GUIDE_LICENSE_URL} onClick={(event) => { event.preventDefault(); onOpenUrl(GUIDE_LICENSE_URL); }}>{t("guide.license")} ↗</a>
						<a href={GUIDE_REPO_URL} onClick={(event) => { event.preventDefault(); onOpenUrl(GUIDE_REPO_URL); }}>{t("guide.openOnGithub")} ↗</a>
					</span>
				</div>
			</div>
			<div style={{ display: tab === "up" ? "contents" : "none" }}>
				<UpGuidePanel active={active && tab === "up"} onOpenUrl={onOpenUrl} />
			</div>
		</div>
	);
}

function FilterChip({ current, value, label, count, onPick }: {
	current: GradeFilter;
	value: GradeFilter;
	label: string;
	count: number;
	onPick: (value: GradeFilter) => void;
}): React.JSX.Element {
	return (
		<button type="button" className={`owl-guide-fchip${current === value ? " on" : ""}`} onClick={() => onPick(value)}>
			{label}<span className="n">{count}</span>
		</button>
	);
}

function TipCard({ tip, expanded, onToggle, onOpenUrl }: {
	tip: GuideTip;
	expanded: boolean;
	onToggle: () => void;
	onOpenUrl: (url: string) => void;
}): React.JSX.Element {
	const t = useT();
	return (
		<article className="owl-guide-tip">
			<div className="tip-top">
				<span className="tip-no">{tip.key}</span>
				<h3 className="tip-title">{tip.title}</h3>
				<span className={`grade g${tip.grade}`}>{t("guide.gradeBadge", { grade: tip.grade })}</span>
				{tip.disputed && <span className="grade disputed">{t("guide.filterDisputed")}</span>}
			</div>
			{tip.tags.length > 0 && (
				<div className="tags">
					{tip.tags.map((tag) => (
						<span key={tag.k} className={`tag${tag.k === "收益" && tag.v === "大" ? " hot" : ""}`}>{tag.k} <b>{tag.v}</b></span>
					))}
				</div>
			)}
			{tip.plain && <p className="plain"><span className="lbl">{t("guide.labelPlain")}</span>{tip.plain}</p>}
			<button type="button" className="tip-more" onClick={onToggle}>
				{expanded ? t("guide.collapse") : t("guide.expand")} {expanded ? "▴" : "▾"}
			</button>
			{expanded && (
				<div className="tip-detail">
					{tip.cost && <p className="d-field"><span className="lbl">{t("guide.labelCost")}</span>{tip.cost}</p>}
					{tip.benefit && <p className="d-field"><span className="lbl">{t("guide.labelBenefit")}</span>{tip.benefit}</p>}
					{tip.sources && <p className="d-field"><span className="lbl">{t("guide.labelSources")}</span>{linkify(tip.sources, onOpenUrl, tip.key)}</p>}
					{tip.remark && <p className={`d-note${tip.disputed ? " warn" : ""}`}><span className="lbl">{t("guide.labelRemark")}</span>{tip.remark}</p>}
				</div>
			)}
		</article>
	);
}
