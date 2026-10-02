/**
 * owl seam: stand-in for the retired @earendil-works/pi-tui package, served to
 * extensions through VIRTUAL_MODULES / loader aliases.
 *
 * Extensions written against upstream pi import TUI components at module scope
 * (sometimes in `extends` clauses), so an empty stub object crashes them on
 * load. String helpers are real implementations because extensions also use
 * them outside rendering; components are inert classes that survive
 * construction and `extends` but draw nothing — owl's desktop runtime has no
 * terminal UI to draw to.
 */

// ---- string helpers (real implementations) ---------------------------------

const ANSI_RE = new RegExp(
	[
		"\\x1b\\[[0-9;]*m", // SGR color/attribute sequences
		"\\x1b\\]8;;[^\\x1b]*\\x1b\\\\", // OSC-8 hyperlink open
		"\\x1b\\]8;;\\x1b\\\\", // OSC-8 hyperlink close
		"\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // other OSC sequences
		"\\x1b[=>]", // keypad modes
		"\\r",
	].join("|"),
	"g",
);

export function visibleWidth(text: string): number {
	if (typeof text !== "string") return 0;
	return text.replace(ANSI_RE, "").length;
}

export function truncateToWidth(text: string, width: number, _mode?: unknown): string {
	if (typeof text !== "string" || !Number.isFinite(width) || width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const plain = text.replace(ANSI_RE, "");
	if (width <= 1) return plain.slice(0, Math.max(0, Math.floor(width)));
	return plain.slice(0, Math.floor(width) - 1) + "…";
}

export function wrapTextWithAnsi(text: string, width: number): string {
	if (typeof text !== "string" || !Number.isFinite(width) || width <= 0) return "";
	const plain = text.replace(ANSI_RE, "");
	const lines: string[] = [];
	for (const paragraph of plain.split("\n")) {
		if (paragraph.length <= width) {
			lines.push(paragraph);
			continue;
		}
		let remaining = paragraph;
		while (remaining.length > width) {
			let cut = remaining.lastIndexOf(" ", width);
			if (cut <= 0) cut = width;
			lines.push(remaining.slice(0, cut));
			remaining = remaining.slice(cut).replace(/^ +/, "");
		}
		lines.push(remaining);
	}
	return lines.join("\n");
}

export function fuzzyFilter<T>(items: T[], query: string, getText?: (item: T) => string): T[] {
	if (!query) return items;
	const needle = query.toLowerCase();
	const accessor = getText ?? ((item: unknown) => String(item));
	return items.filter((item) => {
		const haystack = String(accessor(item) ?? "").toLowerCase();
		let cursor = 0;
		for (const char of needle) {
			cursor = haystack.indexOf(char, cursor);
			if (cursor === -1) return false;
			cursor += 1;
		}
		return true;
	});
}

// ---- keys -------------------------------------------------------------------

export const Key: Record<string, string> = new Proxy(
	{},
	{
		get: (_target, prop) => (typeof prop === "string" ? prop.toLowerCase() : ""),
	},
) as Record<string, string>;

export function matchesKey(..._args: unknown[]): boolean {
	return false;
}

export function isKeyRelease(..._args: unknown[]): boolean {
	return false;
}

// ---- components (inert) -----------------------------------------------------

export class Text {
	constructor(..._args: unknown[]) {}
	render(): string {
		return "";
	}
	invalidate(): void {}
}

export class Box extends Text {}

export class Container {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	removeChild(child: unknown): void {
		const index = this.children.indexOf(child);
		if (index !== -1) this.children.splice(index, 1);
	}
	clear(): void {
		this.children.length = 0;
	}
	render(): string {
		return "";
	}
	invalidate(): void {}
}

export class Spacer extends Text {}

export class Markdown extends Text {}

export class Input {
	value = "";
	constructor(..._args: unknown[]) {}
	on(): void {}
	handleInput(): void {}
	render(): string {
		return this.value;
	}
	invalidate(): void {}
}
