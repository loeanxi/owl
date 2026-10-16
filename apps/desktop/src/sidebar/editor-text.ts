/** CodeMirror positions are LF-normalized. Apply edits to the original bytes without changing untouched EOLs or BOM. */
export function editorDisplayText(raw: string): string { return raw.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n"); }

export function applyEditorTextChanges(raw: string, changes: readonly { from: number; to: number; insert: string }[]): string {
	const rawIndex = (position: number): number => {
		let index = raw.startsWith("\uFEFF") ? 1 : 0;
		for (let offset = 0; offset < position && index < raw.length; offset++) index += raw[index] === "\r" && raw[index + 1] === "\n" ? 2 : 1;
		return index;
	};
	let next = raw;
	for (const change of [...changes].sort((a, b) => b.from - a.from)) {
		const from = rawIndex(change.from); const to = rawIndex(change.to);
		const endings = [...raw.slice(0, from).matchAll(/\r\n|\n|\r/g)];
		const ending = endings.at(-1)?.[0] ?? raw.slice(from).match(/\r\n|\n|\r/)?.[0] ?? "\n";
		next = next.slice(0, from) + change.insert.replace(/\r\n|\r|\n/g, ending) + next.slice(to);
	}
	return next;
}
