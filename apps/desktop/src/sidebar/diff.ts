/**
 * Unified diff 解析 + 字符级行内高亮。
 *
 * 移植自 dsh-better-sidebar 的 diff 渲染栈（rows.ts / highlight.ts）的核心
 * 算法：把 `git diff` 输出解析为文件 → hunk → 行三级结构；连续的删/加行对
 * 用 `diff.diffChars` 做字符级配对，渲染时命中高亮（VS Code 同款视觉）。
 * 渲染本身由 React 组件用 Tailwind 完成，这里只出数据。
 */
import { diffChars, diffWordsWithSpace } from "diff";

export type DiffLineType = "ctx" | "add" | "del" | "hunk";

export interface DiffSpan {
	text: string;
	/** 该段在行内属于：0 普通 / 1 强调（新增绿底 / 删除红底）。 */
	mark: 0 | 1;
}

export interface DiffLine {
	type: DiffLineType;
	text: string;
	oldNo?: number;
	newNo?: number;
	/** type=del/add 且与对面行配对时：行内分段（字符级高亮）。 */
	spans?: DiffSpan[];
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface DiffFile {
	/** 展示用路径（b/ 侧优先）。 */
	path: string;
	oldPath?: string;
	isNew: boolean;
	isDeleted: boolean;
	isRename: boolean;
	isBinary: boolean;
	hunks: DiffHunk[];
}

/** 解析一段 unified diff 文本（容忍前导邮件头/统计行，忽略之）。 */
export function parseUnifiedDiff(input: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = input.split("\n");
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (!line.startsWith("diff --git ")) {
			index += 1;
			continue;
		}
		const header = line.slice("diff --git ".length);
		const { oldPath, newPath } = splitGitHeader(header);
		const file: DiffFile = {
			path: newPath ?? oldPath ?? "",
			oldPath: oldPath !== newPath ? oldPath : undefined,
			isNew: false,
			isDeleted: false,
			isRename: false,
			isBinary: false,
			hunks: [],
		};
		index += 1;
		// 元信息行，直到第一个 @@ 或下一个 diff --git
		while (index < lines.length && !lines[index]!.startsWith("diff --git ")) {
			const meta = lines[index]!;
			if (meta.startsWith("@@")) break;
			if (meta.startsWith("new file mode")) file.isNew = true;
			if (meta.startsWith("deleted file mode")) file.isDeleted = true;
			if (meta.startsWith("rename from") || meta.startsWith("rename to")) file.isRename = true;
			if (meta.startsWith("Binary files") || meta.startsWith("GIT binary patch")) file.isBinary = true;
			if (meta.startsWith("--- ")) file.oldPath = cleanPath(meta.slice(4));
			if (meta.startsWith("+++ ")) file.path = cleanPath(meta.slice(4)) ?? file.path;
			index += 1;
		}
		if (file.isBinary) {
			files.push(file);
			continue;
		}
		// hunk 循环
		while (index < lines.length && lines[index]!.startsWith("@@")) {
			const hunkHeader = lines[index]!;
			index += 1;
			const hunk: DiffHunk = { header: hunkHeader, lines: [] };
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunkHeader);
			let oldNo = match ? Number(match[1]) : 1;
			let newNo = match ? Number(match[2]) : 1;
			while (index < lines.length && !lines[index]!.startsWith("@@") && !lines[index]!.startsWith("diff --git ")) {
				const raw = lines[index]!;
				if (raw.startsWith("+")) {
					hunk.lines.push({ type: "add", text: raw.slice(1), newNo: newNo++ });
				} else if (raw.startsWith("-")) {
					hunk.lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++ });
				} else if (raw.startsWith("\\")) {
					// "\ No newline at end of file" —— 忽略
				} else {
					hunk.lines.push({ type: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
				}
				index += 1;
			}
			file.hunks.push(hunk);
		}
		files.push(file);
	}
	return files;
}

/**
 * 行内字符级高亮：把连续的删/加行段逐行配对（数量一致时 1:1，一删一加
 * 亦然），每对用 diffChars 计算行内分段；其余形状（多对多）不高亮，保持
 * 红绿底即可。长对退化为词级（字符级在长行上噪声大）。
 */
export function annotateCharDiff(hunk: DiffHunk): void {
	let index = 0;
	while (index < hunk.lines.length) {
		const line = hunk.lines[index]!;
		if (line.type !== "del") {
			index += 1;
			continue;
		}
		let end = index;
		while (end < hunk.lines.length && hunk.lines[end]!.type === "del") end += 1;
		let addEnd = end;
		while (addEnd < hunk.lines.length && hunk.lines[addEnd]!.type === "add") addEnd += 1;
		const dels = hunk.lines.slice(index, end);
		const adds = hunk.lines.slice(end, addEnd);
		const pairs = Math.min(dels.length, adds.length);
		if (pairs > 0 && pairs <= 8) {
			for (let pair = 0; pair < pairs; pair += 1) {
				annotatePair(dels[pair]!, adds[pair]!);
			}
		}
		index = addEnd > end ? addEnd : end;
	}
}

function annotatePair(del: DiffLine, add: DiffLine): void {
	const total = del.text.length + add.text.length;
	const parts = total > 400 ? diffWordsWithSpace(del.text, add.text) : diffChars(del.text, add.text);
	for (const part of parts) {
		if (part.value === "") continue;
		if (part.removed) pushSpan(del, part.value, 1);
		else if (!part.added) {
			pushSpan(del, part.value, 0);
			pushSpan(add, part.value, 0);
		} else pushSpan(add, part.value, 1);
	}
}

function pushSpan(line: DiffLine, text: string, mark: 0 | 1): void {
	if (text === "") return;
	line.spans = line.spans ?? [];
	line.spans.push({ text, mark });
}

function splitGitHeader(header: string): { oldPath?: string; newPath?: string } {
	// `a/path b/path`（带空格的路径被 git 引号包裹，这里简单拆最后一处 " b/"）
	const match = /^(.*)\s+b\/(.*)$/.exec(header);
	if (match === null) return {};
	return {
		oldPath: match[1]!.startsWith("a/") ? match[1]!.slice(2) : match[1]!,
		newPath: match[2]!,
	};
}

function cleanPath(raw: string): string | undefined {
	const trimmed = raw.trim().replace(/\t.*$/, "");
	if (trimmed === "/dev/null") return undefined;
	return trimmed.startsWith("a/") || trimmed.startsWith("b/") ? trimmed.slice(2) : trimmed;
}
