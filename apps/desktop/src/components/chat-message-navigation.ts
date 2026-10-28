/** A search hit belongs to one persisted message, never to a guessed turn index. */
export interface MessageSearchTarget {
	sessionId: string;
	entryId: string;
	query: string;
	requestId: number;
}

const SEARCH_HIGHLIGHT = "owl-message-search";
const NON_MESSAGE_TEXT =
	"button, textarea, script, style, [aria-hidden='true'], [data-answer-toolbar], [data-message-action-ui]";

/** Match text nodes literally; markup, link destinations and React's DOM stay intact. */
export function messageMatchRanges(element: HTMLElement, query: string): Range[] {
	if (!query.trim()) return [];
	const ranges: Range[] = [];
	const nodes: Array<{ node: Node; start: number; end: number }> = [];
	let content = "";
	let previousBlock: Element | null = null;
	const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if (node.parentElement?.closest(NON_MESSAGE_TEXT)) continue;
		const text = node.textContent ?? "";
		if (!text) continue;
		const block = node.parentElement?.closest("p, li, pre, blockquote, div, h1, h2, h3, h4, h5, h6, tr") ?? null;
		if (nodes.length && block !== previousBlock) content += "\n";
		previousBlock = block;
		nodes.push({ node, start: content.length, end: content.length + text.length });
		content += text;
	}
	const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
	for (const match of content.matchAll(literal)) {
		const start = match.index;
		const end = start + match[0].length;
		const first = nodes.find((item) => item.start <= start && item.end > start);
		const last = nodes.find((item) => item.start < end && item.end >= end);
		if (!first || !last) continue;
		const range = element.ownerDocument.createRange();
		range.setStart(first.node, start - first.start);
		range.setEnd(last.node, end - last.start);
		ranges.push(range);
	}
	return ranges;
}

/** CSS custom highlights work inside code and links without wrapping or replacing nodes. */
export function highlightMessageMatches(element: HTMLElement, query: string): () => void {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return () => undefined;
	const highlight = new Highlight(...messageMatchRanges(element, query));
	CSS.highlights.set(SEARCH_HIGHLIGHT, highlight);
	return () => {
		if (CSS.highlights.get(SEARCH_HIGHLIGHT) === highlight) CSS.highlights.delete(SEARCH_HIGHLIGHT);
	};
}

/** Avoid interpolating arbitrary entry IDs into CSS selectors. */
export function messageElement(container: HTMLElement, entryId: string, query: string): HTMLElement | undefined {
	const candidates = [...container.querySelectorAll<HTMLElement>("[data-entry-id]")].filter(
		(element) => element.dataset.entryId === entryId,
	);
	return (
		candidates.find((element) => {
			const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
			let content = "";
			let node: Node | null;
			while ((node = walker.nextNode())) {
				if (!node.parentElement?.closest(NON_MESSAGE_TEXT)) content += node.textContent ?? "";
			}
			return content.toLowerCase().includes(query.toLowerCase());
		}) ?? candidates[0]
	);
}

export function messageScrollTop(container: HTMLElement, message: HTMLElement): number {
	const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
	return Math.max(
		0,
		Math.min(
			maxTop,
			message.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16,
		),
	);
}
