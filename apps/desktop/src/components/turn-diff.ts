/**
 * 本轮改动摘要：给 Claude 式回答流提供 diff 统计与行内 code 三色染色。
 *
 * 数据来自 diff-approval 插件的落库记录（`diffApproval.list` + `diffApproval.diff`）。
 *
 * Claude Desktop 的行内 code 芯片用的是 git 语义的三色（取自它的 design token）：
 *   --cds-text-git-added     浅色 #1e9e3c / 深色 #32d74b   新增
 *   --cds-text-git-removed   浅色 #cd2054 / 深色 #ff2c56   删除
 *   --cds-text-git-modified  浅色 #98801f / 深色 #ffd014   修改
 *
 * 所以判定不是「这个文件被改过」（那是路径语义），而是「这段代码是新增的、
 * 被删掉的，还是落在被改过的文件里但不是具体某一行」。
 */

import { useEffect, useState } from "react";
import type { DiffApprovalFileSummary } from "../bridge/protocol.ts";
import type { BridgeClient } from "../bridge/client.ts";

/** 行内 code 芯片的三种染色语义。 */
export type ChipTint = "added" | "removed" | "modified";

export type TurnDiffSummary = {
	/** 本轮新增行数。 */
	added: number;
	/** 本轮删除行数。 */
	removed: number;
	/** 本轮被改动的文件（工作区相对路径）。 */
	paths: string[];
	/** 本轮被删除的行（去空白后的文本，小写）。 */
	removedLines: Set<string>;
	/** 本轮被新增的行（去空白后的文本，小写）。 */
	addedLines: Set<string>;
};

const EMPTY_SUMMARY: TurnDiffSummary = {
	added: 0,
	removed: 0,
	paths: [],
	removedLines: new Set(),
	addedLines: new Set(),
};

/** 把 diff-approval 的文件清单收成一份汇总。 */
export function summarizeTurnDiff(files: readonly DiffApprovalFileSummary[]): TurnDiffSummary {
	let added = 0;
	let removed = 0;
	const paths: string[] = [];
	for (const file of files) {
		if (file.status !== "pending") continue;
		added += file.added ?? 0;
		removed += file.removed ?? 0;
		paths.push(file.displayPath || file.path);
	}
	return { ...EMPTY_SUMMARY, added, removed, paths };
}

/**
 * 从 unified diff 里抽出被增删的行。
 *
 * 只取内容行（`+`/`-` 开头），去掉 hunk 头（`@@`）与文件头（`---`/`+++`）。
 * 行内容按 normalizeForMatch 归一（去引号、去多余空白、小写）后入表，
 * 判定时两端都比对，避免引号与缩进差异造成漏判。
 */
export function parseChangedLines(diff: string): { added: Set<string>; removed: Set<string> } {
	const added = new Set<string>();
	const removed = new Set<string>();
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++") || raw.startsWith("---")) continue;
		if (raw.startsWith("@@")) continue;
		if (raw.startsWith("+")) {
			const text = normalizeForMatch(raw.slice(1));
			if (text !== "") added.add(text);
			continue;
		}
		if (raw.startsWith("-")) {
			const text = normalizeForMatch(raw.slice(1));
			if (text !== "") removed.add(text);
		}
	}
	return { added, removed };
}

/**
 * 判断某个行内 code 片段指向本轮被改动的文件。
 *
 * 路径语义：命中就是「落在被改过的文件里」。
 */
export function isChangedInTurn(code: string, paths: readonly string[]): boolean {
	if (paths.length === 0 || code === "") return false;
	const needle = code.toLowerCase();
	return paths.some((path) => {
		const lower = path.toLowerCase();
		return lower === needle || lower.endsWith(`/${needle}`) || lower.endsWith(needle);
	});
}

/**
 * 比较用的归一化：去掉引号与空白。
 *
 * 源码里是 `v="20260926-4"`，正文里模型常写成 `v=20260926-4` —— 差一对引号，
 * 不归一化就匹配不上。
 */
function normalizeForMatch(text: string): string {
	return text.replace(/["'`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 判断 chip 是否落在某一行的「词」内部。
 *
 * 用词边界而不是长度阈值：`.brand` 只有 6 个字符，但它是 CSS 类名，
 * 出现在 `.<div class="brand">` 里就是一个完整的词；而 `billing` 出现在
 * `const billing = true` 里也是词 —— 区别在于那一行是不是**被删的那一行**，
 * 而不是这个标识符本身有多长。
 */
function containsWord(line: string, needle: string): boolean {
	if (needle === "") return false;
	let from = 0;
	while (from <= line.length - needle.length) {
		const at = line.indexOf(needle, from);
		if (at === -1) return false;
		const before = at === 0 ? "" : line[at - 1]!;
		const after = line[at + needle.length] ?? "";
		const isWordChar = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);
		if (!isWordChar(before) && !isWordChar(after)) return true;
		from = at + 1;
	}
	return false;
}

/**
 * 给一个行内 code 片段定色。
 *
 * - 命中被删掉的行 → removed（红）
 * - 命中被新增的行 → added（绿）
 * - 命中被改过的文件 → modified（黄）
 * - 都不是 → undefined（走普通样式）
 *
 * 匹配要求 chip 落在那一行的词边界内：`.brand` 认，`billing` 若只在一处
 * 出现也认 —— 但若该 chip 在别处也出现，颜色仍以「被删/被增的那一行」为准。
 */
export function classifyChip(code: string, summary: TurnDiffSummary): ChipTint | undefined {
	if (code === "") return undefined;
	const needle = normalizeForMatch(code);
	if (needle === "") return undefined;
	if (summary.removedLines.has(needle)) return "removed";
	if (summary.addedLines.has(needle)) return "added";
	// chip 是某行的片段时也算命中：正文里常写 `v=20260926-4` 这种片段。
	if (summary.removedLines.size > 0) {
		for (const line of summary.removedLines) {
			if (containsWord(line, needle)) return "removed";
		}
	}
	if (summary.addedLines.size > 0) {
		for (const line of summary.addedLines) {
			if (containsWord(line, needle)) return "added";
		}
	}
	if (isChangedInTurn(code, summary.paths)) return "modified";
	return undefined;
}

/**
 * 订阅 diff-approval 的改动推送，维护本轮的 diff 摘要。
 *
 * 没有桥或没有插件时是空摘要 —— 回答流照常渲染，只是不带 diff 统计与染色。
 */
export function useTurnDiff(
	client: BridgeClient | undefined,
	cwd: string | undefined,
	sessionId: string | undefined,
): TurnDiffSummary {
	const [summary, setSummary] = useState<TurnDiffSummary>(EMPTY_SUMMARY);

	useEffect(() => {
		if (!client || !cwd) {
			setSummary(EMPTY_SUMMARY);
			return;
		}
		let cancelled = false;
		const canRequest = typeof client.request === "function";
		const load = (): void => {
			if (!canRequest) return;
			void client
				.request<{ files: DiffApprovalFileSummary[] }>({
					type: "diffApproval.list",
					cwd,
					...(sessionId !== undefined ? { scope: { sessionId } } : {}),
				})
				.then(async (response) => {
					if (cancelled || !response.ok || response.result === undefined) return;
					const files = response.result.files;
					const base = summarizeTurnDiff(files);
					// 拉每个改动文件的 diff，解析出增删的行 —— 芯片的绿/红由此而来。
					const removedLines = new Set<string>();
					const addedLines = new Set<string>();
					const pending = files
						.filter((file) => file.status === "pending")
						.map((file) =>
							client
								.request<{ diff: string; truncated: boolean }>({
									type: "diffApproval.diff",
									cwd,
									entryId: file.id,
								})
								.then((diffResponse) => {
									if (!diffResponse.ok || diffResponse.result === undefined) return;
									const parsed = parseChangedLines(diffResponse.result.diff);
									for (const line of parsed.removed) removedLines.add(line);
									for (const line of parsed.added) addedLines.add(line);
								})
								.catch(() => undefined),
						);
					await Promise.all(pending);
					if (cancelled) return;
					setSummary({ ...base, removedLines, addedLines });
				})
				.catch(() => undefined);
		};
		load();
		// 没有 diff-approval 插件的桥不会推这个事件：没有它就不订阅，
		// 回答流照常渲染，只是不带 diff 统计与染色。
		const off = typeof client.onDiffApprovalChanged === "function"
			? client.onDiffApprovalChanged(() => load())
			: undefined;
		return () => {
			cancelled = true;
			off?.();
		};
	}, [client, cwd, sessionId]);

	return summary;
}
