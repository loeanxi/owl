/**
 * 输入框里的「文件芯片」：插入后是一颗 contentEditable=false 的徽章，
 * 文本路径不进 user message，只随 attachedPaths 字段过线。
 * 删除时点 ✕ 即可——同时从 Composer 的 attachedPaths 列表里摘掉。
 */
export function AttachedFileChip({
	path,
	basename,
	onRemove,
	removeLabel,
}: {
	path: string;
	basename: string;
	onRemove: () => void;
	removeLabel: string;
}): React.JSX.Element {
	return (
		<span className="owl-mention-chip" contentEditable={false} data-mention-path={path} title={path}>
			<span className="owl-mention-chip__label">{basename}</span>
			<button
				type="button"
				className="owl-mention-chip__x"
				tabIndex={-1}
				aria-label={removeLabel}
				title={removeLabel}
				onMouseDown={(event) => {
					// 防止点 ✕ 时让 contenteditable 失焦、菜单跟着抖
					event.preventDefault();
				}}
				onClick={onRemove}
			>
				✕
			</button>
		</span>
	);
}

/** 从 contenteditable 节点中抽纯文本：跳过 .owl-mention-chip 元素与零宽空白。 */
export function extractPlainText(root: HTMLElement): string {
	const out: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			out.push(node.textContent ?? "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as HTMLElement;
		if (el.classList.contains("owl-mention-chip")) return;
		// <br> 视作换行，块级元素之间补换行（避免文本被压成一坨）
		const isBlock = el.tagName === "BR" || /^(DIV|P|LI|BLOCKQUOTE|H[1-6])$/.test(el.tagName);
		for (const child of Array.from(el.childNodes)) walk(child);
		if (isBlock) out.push("\n");
	};
	for (const child of Array.from(root.childNodes)) walk(child);
	return out.join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}