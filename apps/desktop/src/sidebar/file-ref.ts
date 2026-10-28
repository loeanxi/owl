/**
 * 侧栏 → 模型的文件引用：统一成 `路径:行号`。
 *
 * 侧边栏把「用户在哪个文件的哪一行提了意见」交给模型时用这个格式：模型能直接
 * 拿去解析出路径与行号（需要用户看时可用同样的锚点指回去），用户在对话里看到
 * 的也是可点击的路径芯片（行内 code 芯片按 `路径:行号` 识别）。
 */

/** 一个文件引用：workspace 相对路径 + 可选行号（可含行段）。 */
export interface FileRef {
	/** workspace 相对 POSIX 路径。 */
	path: string;
	/** 1 起的行号。 */
	line?: number;
	/** 1 起的结束行（与 line 一起给出表示一段）。 */
	endLine?: number;
}

/** 引用 → 文本：`路径:行号`，行段是 `路径:起-止`。 */
export function formatFileRef(ref: FileRef): string {
	if (ref.line === undefined) return ref.path;
	if (ref.endLine !== undefined && ref.endLine !== ref.line) return `${ref.path}:${ref.line}-${ref.endLine}`;
	return `${ref.path}:${ref.line}`;
}

/** 文本 → 引用：认 `路径:行号` / `路径:起-止`，也认裸路径；认不出返回 undefined。 */
export function parseFileRef(text: string): FileRef | undefined {
	const trimmed = text
		.trim()
		.replace(/^`+|`+$/g, "")
		.trim();
	if (trimmed === "") return undefined;
	const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(trimmed);
	const path = match?.[1]?.trim() ?? "";
	if (path === "") return undefined;
	const line = match?.[2] === undefined ? undefined : Number(match[2]);
	const endLine = match?.[3] === undefined ? undefined : Number(match[3]);
	return {
		path,
		...(line !== undefined && Number.isFinite(line) ? { line } : {}),
		...(endLine !== undefined && Number.isFinite(endLine) ? { endLine } : {}),
	};
}
