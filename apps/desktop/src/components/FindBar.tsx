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

/**
 * 页面内查找条（视图菜单「查找…」/ Ctrl+F）。
 * 用 Chromium 内建 window.find()：WebView2 原生支持选中高亮与滚动定位，
 * 不必自建高亮层；找不到时给一行提示。
 */
export function FindBar({ onClose }: { onClose: () => void }): React.JSX.Element {
	const t = useT();
	const [query, setQuery] = useState("");
	const [missed, setMissed] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
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

	const findNext = (backwards: boolean): void => {
		if (!query) return;
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
				onChange={(event) => {
					setQuery(event.target.value);
					setMissed(false);
				}}
			/>
			{missed && <span className="text-[11px] whitespace-nowrap text-red-400" role="status">{t("find.notFound")}</span>}
			<button type="button" className="owl-chrome-button" title={t("find.prev")} aria-label={t("find.prev")} onClick={() => findNext(true)}>↑</button>
			<button type="button" className="owl-chrome-button" title={t("find.next")} aria-label={t("find.next")} onClick={() => findNext(false)}>↓</button>
			<button type="button" className="owl-chrome-button" title={t("app.closeAria")} aria-label={t("app.closeAria")} onClick={onClose}>✕</button>
		</div>
	);
}
