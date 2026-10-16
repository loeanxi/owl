import { useLayoutEffect, useRef } from "react";
import { getUiLanguage } from "../i18n/index.ts";
import { replyReadingText, useReplyReadingText } from "./reply-reading-copy.ts";
import "./reply-reading.css";

function showExpansion(block: HTMLElement, expanded: boolean): void {
	const table = block.hasAttribute("data-answer-table");
	block.dataset.answerExpanded = String(expanded);
	const button = block.querySelector<HTMLButtonElement>(`[data-answer-action="${table ? "expand-table" : "expand-code"}"]`);
	button?.setAttribute("aria-expanded", String(expanded));
	if (button) button.textContent = replyReadingText(table ? expanded ? "collapseTable" : "expandTable" : expanded ? "collapseCode" : "expandCode");
}

/** Enhances only renderer-owned code/table controls; prose, links and code payloads stay intact. */
export function MarkdownAnswer({ html }: { html: string }): React.JSX.Element {
	const text = useReplyReadingText();
	const language = getUiLanguage();
	const root = useRef<HTMLDivElement>(null);
	const latestHtml = useRef(html);
	latestHtml.current = html;
	const expanded = useRef(new Set<string>());
	const blockKeys = useRef(new WeakMap<HTMLElement, string>());
	const copyRequests = useRef(new WeakMap<HTMLButtonElement, symbol>());

	useLayoutEffect(() => {
		const answer = root.current;
		if (!answer) return;
		const blocks = [...answer.querySelectorAll<HTMLElement>("[data-answer-code], [data-answer-table]")];
		const occurrences = new Map<string, number>();
		const liveKeys = new Set<string>();
		blockKeys.current = new WeakMap();
		for (const block of blocks) {
			const payload = block.hasAttribute("data-answer-code") ? block.querySelector("pre > code")?.textContent ?? "" : block.querySelector("table")?.innerHTML ?? "";
			const signature = JSON.stringify([block.hasAttribute("data-answer-code") ? "code" : "table", block.dataset.answerLanguage ?? "", payload]);
			const occurrence = occurrences.get(signature) ?? 0;
			occurrences.set(signature, occurrence + 1);
			const key = JSON.stringify([signature, occurrence]);
			blockKeys.current.set(block, key);
			liveKeys.add(key);
		}
		expanded.current = new Set([...expanded.current].filter((key) => liveKeys.has(key)));

		const measure = (): void => {
			for (const block of blocks) {
				if (!answer.contains(block)) continue;
				const key = blockKeys.current.get(block)!;
				if (block.hasAttribute("data-answer-code")) {
					const pre = block.querySelector("pre");
					const canExpand = Boolean(pre && pre.scrollHeight > 361);
					if (pre) {
						const overflow = pre.scrollHeight > pre.clientHeight + 1 || pre.scrollWidth > pre.clientWidth + 1;
						if (overflow) {
							pre.tabIndex = 0;
							pre.setAttribute("role", "region");
							pre.setAttribute("aria-label", `${text("code")}${block.dataset.answerLanguage ? ` · ${block.dataset.answerLanguage}` : ""}`);
						} else {
							pre.removeAttribute("tabindex");
							pre.removeAttribute("role");
							pre.removeAttribute("aria-label");
						}
					}
					const expandButton = block.querySelector<HTMLButtonElement>('[data-answer-action="expand-code"]');
					if (expandButton) expandButton.hidden = !canExpand;
					const copyButton = block.querySelector<HTMLButtonElement>('[data-answer-action="copy-code"]');
					if (copyButton) copyButton.textContent = text("copy");
					const label = block.querySelector<HTMLElement>(".owl-answer-code-language");
					if (label && !block.dataset.answerLanguage) label.textContent = text("code");
					const status = block.querySelector<HTMLElement>("[data-answer-copy-status]");
					if (status?.dataset.copyState === "copied") status.textContent = text("copied");
					if (status?.dataset.copyState === "error") status.textContent = text("copyFailed");
					if (!canExpand) expanded.current.delete(key);
				} else {
					const viewport = block.querySelector<HTMLElement>("[data-answer-table-scroll]");
					if (!viewport) continue;
					const canExpand = viewport.scrollHeight > 441;
					const expandButton = block.querySelector<HTMLButtonElement>('[data-answer-action="expand-table"]');
					if (expandButton) expandButton.hidden = !canExpand;
					const horizontal = viewport.scrollWidth > viewport.clientWidth + 1;
					const left = horizontal && viewport.scrollLeft > 1;
					const right = horizontal && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
					const hint = block.querySelector<HTMLElement>("[data-answer-table-hint]");
					if (hint) {
						hint.hidden = !horizontal;
						hint.textContent = text(left && right ? "tableScroll" : left ? "tableScrollLeft" : "tableScrollRight");
					}
					viewport.dataset.answerOverflow = left && right ? "both" : left ? "left" : right ? "right" : "none";
					viewport.tabIndex = 0;
					viewport.setAttribute("aria-label", text("tableLabel"));
					const toolbar = block.querySelector<HTMLElement>(".owl-answer-table-toolbar");
					if (toolbar) toolbar.hidden = !horizontal && !canExpand;
					if (!canExpand) expanded.current.delete(key);
				}
				showExpansion(block, expanded.current.has(key));
			}
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(answer);
		const viewports = [...answer.querySelectorAll<HTMLElement>("[data-answer-table-scroll]")];
		for (const viewport of answer.querySelectorAll<HTMLElement>("pre, [data-answer-table-scroll]")) observer.observe(viewport);
		for (const viewport of viewports) viewport.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			for (const viewport of viewports) viewport.removeEventListener("scroll", measure);
		};
	}, [html, language, text]);

	return <div
		ref={root}
		className="owl-answer owl-answer-reading"
		dangerouslySetInnerHTML={{ __html: html }}
		onClick={async (event) => {
			if (!(event.target instanceof Element)) return;
			const button = event.target.closest<HTMLButtonElement>("button[data-answer-action]");
			const answer = root.current;
			if (!button || button.hidden || !answer?.contains(button)) return;
			const block = button.closest<HTMLElement>("[data-answer-code], [data-answer-table]");
			if (!block || !answer.contains(block)) return;
			const action = button.dataset.answerAction;
			if (action !== "copy-code" && action !== "expand-code" && action !== "expand-table") return;
			event.preventDefault();
			event.stopPropagation();
			if (action !== "copy-code") {
				const key = blockKeys.current.get(block);
				if (!key) return;
				const next = !expanded.current.has(key);
				if (next) expanded.current.add(key); else expanded.current.delete(key);
				showExpansion(block, next);
				return;
			}
			const code = block.querySelector("pre > code");
			if (!code || button.getAttribute("aria-busy") === "true") return;
			const payload = code.textContent ?? "";
			const originalHtml = html;
			const request = Symbol();
			copyRequests.current.set(button, request);
			button.setAttribute("aria-busy", "true");
			const status = block.querySelector<HTMLElement>("[data-answer-copy-status]");
			if (status) { status.textContent = ""; delete status.dataset.copyState; }
			let result: "copied" | "error" = "copied";
			try {
				if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
				await navigator.clipboard.writeText(payload);
			} catch { result = "error"; }
			if (latestHtml.current !== originalHtml || root.current !== answer || !answer.contains(block) || !block.contains(button) || block.querySelector("pre > code") !== code || code.textContent !== payload || copyRequests.current.get(button) !== request) return;
			button.removeAttribute("aria-busy");
			if (status) {
				status.dataset.copyState = result;
				status.textContent = text(result === "copied" ? "copied" : "copyFailed");
			}
		}}
	/>;
}
