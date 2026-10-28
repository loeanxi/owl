import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { getUiLanguage } from "../i18n/index.ts";
import { ImageViewer, type ImageViewerItem } from "./ImageViewer.tsx";
import { useImageViewerText } from "./image-viewer-copy.ts";
import { replyReadingText, useReplyReadingText } from "./reply-reading-copy.ts";
import "./reply-reading.css";

function showExpansion(block: HTMLElement, expanded: boolean): void {
	const table = block.hasAttribute("data-answer-table");
	block.dataset.answerExpanded = String(expanded);
	const button = block.querySelector<HTMLButtonElement>(
		`[data-answer-action="${table ? "expand-table" : "expand-code"}"]`,
	);
	button?.setAttribute("aria-expanded", String(expanded));
	if (button)
		button.textContent = replyReadingText(
			table ? (expanded ? "collapseTable" : "expandTable") : expanded ? "collapseCode" : "expandCode",
		);
}

/** Adds reading controls and image previews while preserving prose, links and code payloads. */
export function MarkdownAnswer({ html }: { html: string }): React.JSX.Element {
	const text = useReplyReadingText();
	const imageText = useImageViewerText();
	const language = getUiLanguage();
	const root = useRef<HTMLDivElement>(null);
	const markup = useMemo(() => ({ __html: html }), [html]);
	const latestHtml = useRef(html);
	latestHtml.current = html;
	const expanded = useRef(new Set<string>());
	const blockKeys = useRef(new WeakMap<HTMLElement, string>());
	const copyRequests = useRef(new WeakMap<HTMLButtonElement, symbol>());
	const [preview, setPreview] = useState<{ images: ImageViewerItem[]; index: number }>();
	const [outline, setOutline] = useState<{ id: string; heading: HTMLElement; text: string; level: number }[]>();
	const jumpToHeading = (event: React.MouseEvent<HTMLAnchorElement>, heading: HTMLElement): void => {
		event.preventDefault();
		heading.scrollIntoView({ behavior: "smooth", block: "start" });
		// 与改动审查回跳同一套闪烁反馈；连点同一节也能重闪。
		heading.classList.remove("owl-answer-toc-flash");
		void heading.offsetWidth;
		heading.classList.add("owl-answer-toc-flash");
	};

	const openImage = (selected: HTMLImageElement): void => {
		const pictures = [...(root.current?.querySelectorAll<HTMLImageElement>("img[src]") ?? [])].filter(
			(picture) => picture.currentSrc || picture.src,
		);
		const index = pictures.indexOf(selected);
		if (index === -1) return;
		selected.focus({ preventScroll: true });
		setPreview({
			images: pictures.map((picture) => ({
				src: picture.currentSrc || picture.src,
				alt: picture.alt || imageText("title"),
			})),
			index,
		});
	};

	useLayoutEffect(() => {
		const answer = root.current;
		if (!answer) return;
		// 目录：回答成文后收集 h1–h3 补锚点（索引即 id，内容变了重新收集）；不足 3 个不出目录。
		const headings = [...answer.querySelectorAll<HTMLElement>("h1, h2, h3")];
		const nextOutline = headings.map((heading, index) => {
			heading.id = `answer-heading-${index}`;
			return { id: heading.id, heading, text: heading.textContent ?? "", level: Number(heading.tagName.slice(1)) };
		});
		// effect 只随 html/语言重跑（其余依赖是稳定引用），直接换新数组即可，
		// 并保证目录里持有的是本轮 DOM 的节点引用（html 局部变化时旧引用已脱链）。
		setOutline(nextOutline.length >= 3 ? nextOutline : []);
		for (const [index, picture] of [...answer.querySelectorAll<HTMLImageElement>("img[src]")].entries()) {
			if (!picture.currentSrc && !picture.src) continue;
			picture.tabIndex = 0;
			picture.setAttribute("role", "button");
			picture.setAttribute("aria-haspopup", "dialog");
			picture.setAttribute("aria-label", `${imageText("title")} · ${picture.alt || index + 1}`);
		}
		const blocks = [...answer.querySelectorAll<HTMLElement>("[data-answer-code], [data-answer-table]")];
		const occurrences = new Map<string, number>();
		const liveKeys = new Set<string>();
		blockKeys.current = new WeakMap();
		for (const block of blocks) {
			const payload = block.hasAttribute("data-answer-code")
				? (block.querySelector("pre > code")?.textContent ?? "")
				: (block.querySelector("table")?.innerHTML ?? "");
			const signature = JSON.stringify([
				block.hasAttribute("data-answer-code") ? "code" : "table",
				block.dataset.answerLanguage ?? "",
				payload,
			]);
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
							pre.setAttribute(
								"aria-label",
								`${text("code")}${block.dataset.answerLanguage ? ` · ${block.dataset.answerLanguage}` : ""}`,
							);
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
						hint.textContent = text(
							left && right ? "tableScroll" : left ? "tableScrollLeft" : "tableScrollRight",
						);
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
		for (const viewport of answer.querySelectorAll<HTMLElement>("pre, [data-answer-table-scroll]"))
			observer.observe(viewport);
		for (const viewport of viewports) viewport.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			for (const viewport of viewports) viewport.removeEventListener("scroll", measure);
		};
	}, [html, language, text, imageText]);

	return (
		<>
			{outline && outline.length > 0 && (
				<details className="owl-answer-toc">
					<summary>
						{text("tocTitle")}
						<span className="owl-answer-toc-count">{text("tocSection", { n: outline.length })}</span>
					</summary>
					<ol>
						{outline.map((item) => (
							<li key={item.id} data-level={item.level}>
								<a href={`#${item.id}`} onClick={(event) => jumpToHeading(event, item.heading)}>
									{item.text}
								</a>
							</li>
						))}
					</ol>
				</details>
			)}
			<div
				ref={root}
				className="owl-answer owl-answer-reading"
				dangerouslySetInnerHTML={markup}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== " ")) return;
					if (!(event.target instanceof Element)) return;
					const picture = event.target.closest<HTMLImageElement>("img[src]");
					if (!picture || !root.current?.contains(picture)) return;
					event.preventDefault();
					event.stopPropagation();
					openImage(picture);
				}}
				onClick={async (event) => {
					if (!(event.target instanceof Element)) return;
					const answer = root.current;
					const picture = event.target.closest<HTMLImageElement>("img[src]");
					if (picture && answer?.contains(picture)) {
						event.preventDefault();
						event.stopPropagation();
						openImage(picture);
						return;
					}
					const button = event.target.closest<HTMLButtonElement>("button[data-answer-action]");
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
						if (next) expanded.current.add(key);
						else expanded.current.delete(key);
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
					if (status) {
						status.textContent = "";
						delete status.dataset.copyState;
					}
					let result: "copied" | "error" = "copied";
					try {
						if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
						await navigator.clipboard.writeText(payload);
					} catch {
						result = "error";
					}
					if (
						latestHtml.current !== originalHtml ||
						root.current !== answer ||
						!answer.contains(block) ||
						!block.contains(button) ||
						block.querySelector("pre > code") !== code ||
						code.textContent !== payload ||
						copyRequests.current.get(button) !== request
					)
						return;
					button.removeAttribute("aria-busy");
					if (status) {
						status.dataset.copyState = result;
						status.textContent = text(result === "copied" ? "copied" : "copyFailed");
					}
				}}
			/>
			{preview && (
				<ImageViewer
					images={preview.images}
					index={preview.index}
					onIndexChange={(index) => setPreview((current) => (current ? { ...current, index } : current))}
					onClose={() => setPreview(undefined)}
				/>
			)}
		</>
	);
}
