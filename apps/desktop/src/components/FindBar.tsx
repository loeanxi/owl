import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";

type WindowWithFind = Window & {
	find?: (
		text: string,
		caseSensitive?: boolean,
		backwards?: boolean,
		wrapAround?: boolean,
		wholeWord?: boolean,
		searchInFrames?: boolean,
		showDialog?: boolean,
	) => boolean;
};

const FIND_HIGHLIGHT = "owl-find";
const FIND_HIGHLIGHT_CURRENT = "owl-find-current";
const SEARCH_DEBOUNCE_MS = 150;
/** 查找扫全文，但脚本、样式、输入框与纯装饰内容不参与。 */
const FIND_SKIPPED_TEXT = "script, style, textarea, [aria-hidden='true']";

/** 内核支持 CSS Custom Highlight API（Chromium 105+）时自绘高亮并计数；否则回退 window.find()。 */
function countedFindAvailable(): boolean {
	return typeof CSS !== "undefined" && Boolean(CSS.highlights) && typeof Highlight !== "undefined";
}

function clearFindHighlights(): void {
	if (typeof CSS === "undefined" || !CSS.highlights) return;
	CSS.highlights.delete(FIND_HIGHLIGHT_CURRENT);
	CSS.highlights.delete(FIND_HIGHLIGHT);
}

/** 扫描全文文本节点收集匹配（大小写不敏感、可跨行内元素）；未渲染内容（收起的 details 等）不参与。 */
function collectMatches(query: string): Range[] {
	const needle = query.toLowerCase();
	if (!needle) return [];
	const ranges: Range[] = [];
	const nodes: Array<{ node: Node; start: number; end: number }> = [];
	let content = "";
	const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.parentElement?.closest(FIND_SKIPPED_TEXT)) continue;
		const text = node.textContent ?? "";
		if (!text) continue;
		const parent = node.parentElement;
		if (parent && typeof parent.checkVisibility === "function" && !parent.checkVisibility()) continue;
		nodes.push({ node, start: content.length, end: content.length + text.length });
		content += text;
	}
	const haystack = content.toLowerCase();
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		const start = index;
		const end = start + needle.length;
		const first = nodes.find((item) => item.start <= start && item.end > start);
		const last = nodes.find((item) => item.start < end && item.end >= end);
		if (first && last) {
			const range = document.createRange();
			range.setStart(first.node, start - first.start);
			range.setEnd(last.node, end - last.start);
			ranges.push(range);
		}
		index = haystack.indexOf(needle, index + needle.length);
	}
	return ranges;
}

/**
 * 页面内查找条（视图菜单「查找…」/ Ctrl+F）。
 * 支持高亮 API 的内核上自绘全部匹配并显示「当前/总数」，↑↓ 循环跳转；高亮不改动 DOM。
 * 旧内核回退 Chromium 内建 window.find()（选中高亮与滚动定位原生提供，但没有计数）。
 */
export function FindBar({ onClose }: { onClose: () => void }): React.JSX.Element {
	const t = useT();
	const [query, setQuery] = useState("");
	const [missed, setMissed] = useState(false);
	const [count, setCount] = useState<{ current: number; total: number } | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const rangesRef = useRef<Range[]>([]);
	const currentIndexRef = useRef(0);
	const queryRef = useRef("");
	queryRef.current = query;

	const paintMatches = (current: number): void => {
		if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
		const ranges = rangesRef.current;
		if (!ranges.length) {
			clearFindHighlights();
			return;
		}
		const currentRange = ranges[current];
		CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges.filter((range) => range !== currentRange)));
		CSS.highlights.set(FIND_HIGHLIGHT_CURRENT, new Highlight(currentRange));
	};

	const revealMatch = (current: number): void => {
		rangesRef.current[current]?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "instant" });
	};

	const runSearch = (start: number): void => {
		const text = queryRef.current;
		if (!text) return;
		if (countedFindAvailable()) {
			const ranges = collectMatches(text);
			rangesRef.current = ranges;
			currentIndexRef.current = ranges.length ? Math.min(start, ranges.length - 1) : 0;
			paintMatches(currentIndexRef.current);
			setCount(ranges.length ? { current: currentIndexRef.current + 1, total: ranges.length } : null);
			setMissed(!ranges.length);
			if (ranges.length) revealMatch(currentIndexRef.current);
			return;
		}
		const found = (window as WindowWithFind).find?.(text, false, false, true, false, false, false) ?? false;
		setMissed(!found);
	};

	// 打开前的焦点（Ctrl+F 通常来自聊天区/输入框）：关闭时归还，↑ 召回等焦点行为才可预期。
	const previousFocusRef = useRef<Element | null>(null);
	useEffect(() => {
		previousFocusRef.current = document.activeElement;
		inputRef.current?.focus({ preventScroll: true });
		inputRef.current?.select();
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 逐键防抖扫描；查询清空或组件卸载时摘掉高亮，避免残留到下一次打开。
	useEffect(() => {
		if (!query) {
			rangesRef.current = [];
			currentIndexRef.current = 0;
			clearFindHighlights();
			setCount(null);
			setMissed(false);
			return;
		}
		// 防抖扫描后直接定位首个匹配（首跳）：输入即看到目标，不必再按一次 Enter。
		const timer = window.setTimeout(() => { runSearch(0); revealMatch(currentIndexRef.current); }, SEARCH_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [query]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => () => {
		clearFindHighlights();
		const previous = previousFocusRef.current;
		if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
	}, []);

	const findNext = (backwards: boolean): void => {
		if (!query) return;
		if (countedFindAvailable()) {
			const total = rangesRef.current.length;
			if (!total) {
				setMissed(true);
				return;
			}
			currentIndexRef.current = (currentIndexRef.current + (backwards ? -1 : 1) + total) % total;
			paintMatches(currentIndexRef.current);
			setCount({ current: currentIndexRef.current + 1, total });
			revealMatch(currentIndexRef.current);
			return;
		}
		const found = (window as WindowWithFind).find?.(query, false, backwards, true, false, false, false) ?? false;
		setMissed(!found);
	};

	return (
		<div
			className="fixed top-11 right-4 z-50 flex items-center gap-1.5 rounded-lg border border-owl-border bg-owl-panel px-2 py-1.5 shadow-xl shadow-black/40"
			role="search"
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					findNext(event.shiftKey);
				}
			}}
		>
			<input
				ref={inputRef}
				type="text"
				value={query}
				placeholder={t("find.placeholder")}
				aria-label={t("view.find")}
				className="w-52 rounded-md border border-owl-border bg-owl-sidebar px-2 py-1 text-xs text-owl-text outline-none placeholder:text-owl-muted focus:border-owl-accent"
				onInput={(event) => {
					setQuery(event.currentTarget.value);
					setMissed(false);
				}}
			/>
			{count && <span className="owl-find-count">{t("find.matches", count)}</span>}
			{missed && <span className="text-[11px] whitespace-nowrap text-owl-danger" role="status">{t("find.notFound")}</span>}
			<button type="button" className="owl-chrome-button" title={t("find.prev")} aria-label={t("find.prev")} onClick={() => findNext(true)}>↑</button>
			<button type="button" className="owl-chrome-button" title={t("find.next")} aria-label={t("find.next")} onClick={() => findNext(false)}>↓</button>
			<button type="button" className="owl-chrome-button" title={t("app.closeAria")} aria-label={t("app.closeAria")} onClick={onClose}>✕</button>
		</div>
	);
}
