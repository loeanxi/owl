import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { useT } from "../../i18n/index.ts";
import {
	UP_GUIDE_CHAPTERS,
	UP_GUIDE_PARTS,
	UP_GUIDE_LICENSE_URL,
	UP_GUIDE_REPO_URL,
	fetchUpGuideChapters,
	loadCachedUpGuide,
	resolveUpGuideAsset,
	resolveUpGuideLink,
	resolveUpGuideRepoPath,
	saveCachedUpGuide,
	upGuideChapterUrl,
	type UpGuideChapter,
} from "./up-guide-content.ts";

interface UpGuidePanelProps {
	active: boolean;
	/** 外链统一走宿主（open.external → 系统浏览器）。 */
	onOpenUrl: (url: string) => void;
}

interface LoadState {
	status: "idle" | "loading" | "ready" | "error";
	/** 已就绪章节按阅读序号索引（部分章节抓取失败时允许缺章）。 */
	chapters: Map<number, UpGuideChapter>;
	savedAt?: string;
	done: number;
	total: number;
}

/** 记住读到的位置；下次打开面板直接落在上一章。 */
const UP_GUIDE_LAST_KEY = "owl.upguide.last.v1";

const md = new MarkdownIt({ html: false, linkify: true });

/** 章内相对图片重写成 jsDelivr 绝对地址（上游正文用 ../../assets/ 相对引用）。 */
function renderChapterHtml(chapter: UpGuideChapter, path: string): string {
	return md.render(chapter.body).replace(/<img src="([^"]+)"/g, (raw, src: string) => raw.replace(src, resolveUpGuideAsset(path, src)));
}

/** 「人生进阶指南」阅读面板：部-章目录 + 长文正文（markdown-it 渲染），章节缓存进 localStorage。 */
export function UpGuidePanel({ active, onOpenUrl }: UpGuidePanelProps): React.JSX.Element {
	const t = useT();
	const [state, setState] = useState<LoadState>({ status: "idle", chapters: new Map(), done: 0, total: UP_GUIDE_CHAPTERS.length });
	const [currentNo, setCurrentNo] = useState<number>(() => {
		const saved = Number(localStorage.getItem(UP_GUIDE_LAST_KEY));
		return UP_GUIDE_CHAPTERS.some((chapter) => chapter.no === saved) ? saved : 1;
	});
	const [tocQuery, setTocQuery] = useState("");
	const readerRef = useRef<HTMLDivElement>(null);

	const sync = (): void => {
		setState((current) => ({ ...current, status: "loading", done: 0, total: UP_GUIDE_CHAPTERS.length }));
		void fetchUpGuideChapters((done, total) => setState((current) => ({ ...current, done, total })))
			.then((result) => {
				if (result.chapters.length === 0) {
					setState((current) => ({ ...current, status: "error" }));
					return;
				}
				const savedAt = saveCachedUpGuide(result.chapters);
				const chapters = new Map(result.chapters.map((chapter) => [chapter.no, chapter]));
				setState({ status: "ready", chapters, savedAt, done: result.chapters.length, total: UP_GUIDE_CHAPTERS.length });
			})
			.catch(() => setState((current) => ({ ...current, status: "error" })));
	};

	useEffect(() => {
		if (!active || state.status !== "idle") return;
		const cached = loadCachedUpGuide();
		if (cached.chapters.length > 0) {
			const chapters = new Map(cached.chapters.map((chapter) => [chapter.no, chapter]));
			setState({ status: "ready", chapters, savedAt: cached.savedAt, done: cached.chapters.length, total: UP_GUIDE_CHAPTERS.length });
			return;
		}
		sync();
		// 只在该 tab 首次激活时触发加载；state.status 变化后不再重入。
	}, [active]);

	// 记住阅读位置；切章后回到顶部。
	useEffect(() => {
		try {
			localStorage.setItem(UP_GUIDE_LAST_KEY, String(currentNo));
		} catch {
			// 忽略。
		}
		readerRef.current?.scrollTo(0, 0);
	}, [currentNo]);

	const currentMeta = useMemo(() => UP_GUIDE_CHAPTERS.find((chapter) => chapter.no === currentNo)!, [currentNo]);
	const current = state.chapters.get(currentNo);
	const html = useMemo(() => (current ? renderChapterHtml(current, currentMeta.path) : ""), [current, currentMeta.path]);

	const needle = tocQuery.trim().toLowerCase();
	const tocGroups = useMemo(() => {
		const match = (title: string): boolean => !needle || title.toLowerCase().includes(needle);
		return UP_GUIDE_PARTS.map((part, index) => ({
			part,
			items: UP_GUIDE_CHAPTERS.filter((chapter) => chapter.part === index && match(chapter.title)),
		})).filter((group) => group.items.length > 0);
	}, [needle]);

	const openChapter = (no: number): void => {
		if (no >= 1 && no <= UP_GUIDE_CHAPTERS.length) setCurrentNo(no);
	};

	/** 正文点击代理：站内章节链接原地跳转，外链交宿主，其余回落 GitHub 原文页。 */
	const onContentClick = (event: React.MouseEvent<HTMLDivElement>): void => {
		const anchor = (event.target as HTMLElement).closest("a");
		if (!anchor) return;
		const href = anchor.getAttribute("href") ?? "";
		if (!href || href.startsWith("#")) return;
		event.preventDefault();
		const target = resolveUpGuideLink(currentMeta.path, href);
		if (target) {
			setCurrentNo(target.no);
			return;
		}
		if (/^https?:\/\//.test(href)) {
			onOpenUrl(href);
			return;
		}
		const repoPath = resolveUpGuideRepoPath(currentMeta.path, href);
		if (repoPath) onOpenUrl(`${UP_GUIDE_REPO_URL}/blob/main/${repoPath}`);
	};

	return (
		<div className="owl-upguide">
			<div className="owl-upguide-main">
				<nav className="owl-upguide-toc" aria-label={t("upguide.toc")}>
					<label className="owl-upguide-tocfilter">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
						<input
							value={tocQuery}
							onChange={(event) => setTocQuery(event.target.value)}
							placeholder={t("upguide.tocFilter")}
							aria-label={t("upguide.tocFilter")}
						/>
						{tocQuery && <button type="button" aria-label="×" onClick={() => setTocQuery("")}>×</button>}
					</label>
					<div className="owl-upguide-toclist">
						{tocGroups.map(({ part, items }) => (
							<div key={part.title} className="owl-upguide-part">
								<div className="owl-upguide-part-name">{part.title}</div>
								{items.map((chapter) => (
									<button
										key={chapter.no}
										type="button"
										className={`owl-upguide-ch${!needle && currentNo === chapter.no ? " on" : ""}`}
										onClick={() => { setCurrentNo(chapter.no); setTocQuery(""); }}
									>
										<span className="no">{String(chapter.no).padStart(2, "0")}</span>
										<span>{chapter.title}</span>
									</button>
								))}
							</div>
						))}
						{tocGroups.length === 0 && <div className="owl-upguide-tocempty">{t("upguide.noChapter")}</div>}
					</div>
					<div className="owl-upguide-tocfoot" data-status={state.status}>
						<span>
							{state.status === "loading" ? t("upguide.loading", { done: state.done, total: state.total })
								: state.status === "error" ? t("upguide.fetchFailed")
								: state.savedAt ? t("upguide.cachedAt", { date: state.savedAt })
								: ""}
						</span>
						{(state.status === "ready" || state.status === "error") && (
							<button type="button" onClick={sync}>{t("upguide.resync")}</button>
						)}
					</div>
				</nav>
				<div className="owl-upguide-reader" ref={readerRef}>
					{state.status === "loading" && (
						<div className="owl-guide-state">
							<p>{t("upguide.loading", { done: state.done, total: state.total })}</p>
							<div className="bar"><i style={{ width: `${Math.round((state.done / Math.max(1, state.total)) * 100)}%` }} /></div>
						</div>
					)}
					{state.status === "error" && (
						<div className="owl-guide-state">
							<p className="err">{t("upguide.fetchFailed")}</p>
							<p><button type="button" className="owl-guide-linkbtn" onClick={sync}>{t("upguide.retry")}</button></p>
						</div>
					)}
					{state.status === "ready" && !current && (
						<div className="owl-guide-state">
							<p>{t("upguide.chapterMissing")}</p>
							<p><button type="button" className="owl-guide-linkbtn" onClick={sync}>{t("upguide.retry")}</button></p>
						</div>
					)}
					{current && (
						<article className="owl-upguide-doc">
							<header className="owl-upguide-doc-head">
								<span className="owl-upguide-doc-part">{UP_GUIDE_PARTS[currentMeta.part]?.title}</span>
								<h2>{current.title}</h2>
								<div className="meta">
									{current.updated && <span>{t("upguide.updated", { date: current.updated })}</span>}
									<a href={upGuideChapterUrl(currentMeta.path)} onClick={(event) => { event.preventDefault(); onOpenUrl(upGuideChapterUrl(currentMeta.path)); }}>{t("upguide.viewChapter")} ↗</a>
								</div>
							</header>
							{/* markdown-it html:false，正文只含上游生成的标签；点击代理见 onContentClick。 */}
							<div className="owl-upguide-content" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: html }} />
							<footer className="owl-upguide-pager">
								<button type="button" disabled={currentNo <= 1} onClick={() => openChapter(currentNo - 1)}>← {t("upguide.prev")}</button>
								<button type="button" disabled={currentNo >= UP_GUIDE_CHAPTERS.length} onClick={() => openChapter(currentNo + 1)}>{t("upguide.next")} →</button>
							</footer>
						</article>
					)}
				</div>
			</div>
			<footer className="owl-guide-foot">
				<span>
					{t("upguide.attribution")}
					{state.savedAt && ` · ${t("guide.mayLagUpstream", { date: state.savedAt })}`}
				</span>
				<span className="right">
					<a href={UP_GUIDE_LICENSE_URL} onClick={(event) => { event.preventDefault(); onOpenUrl(UP_GUIDE_LICENSE_URL); }}>{t("upguide.license")} ↗</a>
					<a href={UP_GUIDE_REPO_URL} onClick={(event) => { event.preventDefault(); onOpenUrl(UP_GUIDE_REPO_URL); }}>{t("upguide.openOnGithub")} ↗</a>
				</span>
			</footer>
		</div>
	);
}
