/**
 * 编辑器 diff 装饰的数据面：把 diffApproval 的单文件 unified diff 文本算成
 * 「新文件坐标系」的标记——新增行的行号，以及每个删除块的锚点（新文件中
 * 紧跟其后的那一行；文件末尾后的删除块锚点为总行数 + 1）。行号全部 1 基，
 * 消费方（EditorTab 的 CodeMirror StateField）负责越界钳制。
 * 纯函数，不依赖 CodeMirror，单测覆盖各种 hunk 形状。
 */
import { parseUnifiedDiff } from "./diff.ts";

export interface EditorDiffDelGroup {
	/** 删除块锚点：新文件中渲染在其之前的那一行（1 基；EOF 后 = 行数 + 1）。 */
	atLine: number;
	lines: string[];
}

export interface EditorDiffHunk {
	/** 新增行的新文件行号（1 基，升序）。 */
	addLines: number[];
	/** 本 hunk 内的删除块（按出现顺序）。 */
	dels: EditorDiffDelGroup[];
}

export interface EditorDiffMarks {
	hunks: EditorDiffHunk[];
	/** 第一个改动块的新文件起始行（1 基），自动滚动用；无变化时 undefined。 */
	firstLine: number | undefined;
}

const HUNK_START = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function editorDiffMarks(diffText: string): EditorDiffMarks {
	const file = parseUnifiedDiff(diffText)[0];
	if (file === undefined) return { hunks: [], firstLine: undefined };
	const hunks: EditorDiffHunk[] = [];
	for (const hunk of file.hunks) {
		const addLines: number[] = [];
		const dels: EditorDiffDelGroup[] = [];
		// newNo 游标：hunk 头的 +start - 1 起步，纯删除 hunk（无 ctx/add 行）时
		// 锚点就是 hunk 的 +start（新文件中删除发生处的下一行）。
		const start = Number(HUNK_START.exec(hunk.header)?.[1] ?? 1);
		let lastNewNo = start - 1;
		let pending: string[] | undefined;
		for (const line of hunk.lines) {
			if (line.type === "del") {
				(pending ??= []).push(line.text);
				continue;
			}
			if (pending !== undefined) {
				dels.push({ atLine: line.newNo ?? lastNewNo + 1, lines: pending });
				pending = undefined;
			}
			if (line.type === "add") {
				addLines.push(line.newNo ?? 0);
				lastNewNo = line.newNo ?? lastNewNo + 1;
			} else if (line.type === "ctx") {
				lastNewNo = line.newNo ?? lastNewNo + 1;
			}
		}
		if (pending !== undefined) dels.push({ atLine: lastNewNo + 1, lines: pending });
		if (addLines.length > 0 || dels.length > 0) hunks.push({ addLines, dels });
	}
	const first = hunks[0];
	return { hunks, firstLine: first?.addLines[0] ?? first?.dels[0]?.atLine };
}
