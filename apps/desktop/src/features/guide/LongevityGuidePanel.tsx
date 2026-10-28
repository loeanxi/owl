import MarkdownIt from "markdown-it";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import {
	fetchLongevityDoc,
	injectHeadingIds,
	LONGEVITY_LICENSE_URL,
	LONGEVITY_REPO_URL,
	LONGEVITY_SOURCE_URL,
	type LongevityDoc,
	type LongevityTocEntry,
	loadCachedLongevity,
	resolveLongevityUrl,
	saveCachedLongevity,
} from "./longevity-guide-content.ts";

interface LongevityGuidePanelProps {
	active: boolean;
	/** 外链统一走宿主（open.external → 系统浏览器）。 */
	onOpenUrl: (url: string) => void;
}

interface LoadState {
	status: "idle" | "loading" | "ready" | "error";
	doc?: LongevityDoc;
	savedAt?: string;
}

const md = new MarkdownIt({ html: false, linkify: true });
const EMPTY_RENDER: { html: string; toc: LongevityTocEntry[] } = { html: "", toc: [] };

/** 「延寿指南」阅读面板：左侧小节目录（可筛选）+ 右侧长文；整篇一次拉取，缓存进 localStorage。 */
export function LongevityGuidePanel({ active, onOpenUrl }: LongevityGuidePanelProps): React.JSX.Element {
	const t = useT();
	const [state, setState] = useState<LoadState>({ status: "idle" });
	const [tocQuery, setTocQuery] = useState("");
	const [activeId, setActiveId] = useState<string>();
	const readerRef = useRef<HTMLDivElement>(null);

	const sync = (): void => {
		setState((current) => ({ ...current, status: "loading" }));
		void fetchLongevityDoc()
			.then((doc) => setState({ status: "ready", doc, savedAt: saveCachedLongevity(doc) }))
			.catch(() => setState((current) => ({ ...current, status: "error" })));
	};

	useEffect(() => {
		if (!active || state.status !== "idle") return;
		const cached = loadCachedLongevity();
		if (cached.doc) {
			setState({ status: "ready", doc: cached.doc, ...(cached.savedAt ? { savedAt: cached.savedAt } : {}) });
			return;
		}
		sync();
		// 只在该 tab 首次激活时触发加载；state.status 变化后不再重入。
	}, [active]);

	const rendered = useMemo(
		() => (state.doc ? injectHeadingIds(md.render(state.doc.body)) : EMPTY_RENDER),
		[state.doc],
	);

	const needle = tocQuery.trim().toLowerCase();
	const tocItems = useMemo(
		() => rendered.toc.filter((item) => !needle || item.title.toLowerCase().includes(needle)),
		[rendered, needle],
	);

	const jumpTo = (id: string): void => {
		setActiveId(id);
		readerRef.current?.querySelector<HTMLElement>(`[id="${id}"]`)?.scrollIntoView({ block: "start" });
	};

	/** 正文点击代理：站内锚点跳小节（按 GitHub slug 匹配），其余交宿主。 */
	const onContentClick = (event: React.MouseEvent<HTMLDivElement>): void => {
		const anchor = (event.target as HTMLElement).closest("a");
		if (!anchor) return;
		const href = anchor.getAttribute("href") ?? "";
		if (!href) return;
		event.preventDefault();
		if (href.startsWith("#")) {
			const slug = decodeURIComponent(href.slice(1)).toLowerCase();
			const target = rendered.toc.find((item) => item.slug === slug);
			if (target) jumpTo(target.id);
			return;
		}
		onOpenUrl(resolveLongevityUrl(href));
	};

	return (
		<div className="owl-longevity">
			<div className="owl-longevity-main">
				<nav className="owl-longevity-toc" aria-label={t("longevity.toc")}>
					<label className="owl-longevity-tocfilter">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<circle cx="11" cy="11" r="7" />
							<path d="m20 20-3.5-3.5" />
						</svg>
						<input
							value={tocQuery}
							onChange={(event) => setTocQuery(event.target.value)}
							placeholder={t("longevity.tocFilter")}
							aria-label={t("longevity.tocFilter")}
						/>
						{tocQuery && (
							<button type="button" aria-label="×" onClick={() => setTocQuery("")}>
								×
							</button>
						)}
					</label>
					<div className="owl-longevity-toclist">
						{tocItems.map((item) => (
							<button
								key={item.id}
								type="button"
								className={`owl-longevity-tocb lv${item.level}${activeId === item.id ? " on" : ""}`}
								onClick={() => jumpTo(item.id)}
							>
								{item.title}
							</button>
						))}
						{tocItems.length === 0 && <div className="owl-longevity-tocempty">{t("longevity.noSection")}</div>}
					</div>
					<div className="owl-longevity-tocfoot" data-status={state.status}>
						<span>
							{state.status === "loading"
								? t("longevity.loading")
								: state.status === "error"
									? t("longevity.fetchFailed")
									: state.savedAt
										? t("longevity.cachedAt", { date: state.savedAt })
										: ""}
						</span>
						{(state.status === "ready" || state.status === "error") && (
							<button type="button" onClick={sync}>
								{t("longevity.resync")}
							</button>
						)}
					</div>
				</nav>
				<div className="owl-longevity-reader" ref={readerRef}>
					{!state.doc && state.status === "loading" && (
						<div className="owl-guide-state">
							<p>{t("longevity.loading")}</p>
						</div>
					)}
					{!state.doc && state.status === "error" && (
						<div className="owl-guide-state">
							<p className="err">{t("longevity.fetchFailed")}</p>
							<p>
								<button type="button" className="owl-guide-linkbtn" onClick={sync}>
									{t("longevity.retry")}
								</button>
							</p>
						</div>
					)}
					{state.doc && (
						<article className="owl-longevity-doc">
							<header className="owl-longevity-doc-head">
								<h2>{state.doc.title}</h2>
								<div className="meta">
									<a
										href={LONGEVITY_SOURCE_URL}
										onClick={(event) => {
											event.preventDefault();
											onOpenUrl(LONGEVITY_SOURCE_URL);
										}}
									>
										{t("longevity.viewSource")} ↗
									</a>
								</div>
							</header>
							{/* markdown-it html:false，正文只含上游生成的标签；点击代理见 onContentClick。 */}
							<div
								className="owl-upguide-content owl-longevity-content"
								onClick={onContentClick}
								dangerouslySetInnerHTML={{ __html: rendered.html }}
							/>
						</article>
					)}
				</div>
			</div>
			<footer className="owl-guide-foot">
				<span>{t("longevity.attribution")}</span>
				<span className="right">
					<a
						href={LONGEVITY_LICENSE_URL}
						onClick={(event) => {
							event.preventDefault();
							onOpenUrl(LONGEVITY_LICENSE_URL);
						}}
					>
						{t("longevity.license")} ↗
					</a>
					<a
						href={LONGEVITY_REPO_URL}
						onClick={(event) => {
							event.preventDefault();
							onOpenUrl(LONGEVITY_REPO_URL);
						}}
					>
						{t("longevity.openOnGithub")} ↗
					</a>
				</span>
			</footer>
		</div>
	);
}
