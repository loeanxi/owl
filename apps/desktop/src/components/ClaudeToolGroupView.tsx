/**
 * Claude 风格的工具组（TurnStatus 组）。
 *
 * 形态（对着 Claude Desktop 实机截图 + bundle 还原，c734 的 `lx`/`At`/`kt`）：
 *
 *   Searched code ⌄                ← 组头：默认只这一行，整组收起
 *   （点开后才出现整组一个圆角盒）
 *   ┌──────────────────────────────────┐
 *   │ Searched loean-{mark|word} ⌄     │ ← 盒内一行：灰字短语 + 对象 + 箭头
 *   │ 6-  <title>loean · 账号池网关</title> │ ← 行展开后：原始输出
 *   └──────────────────────────────────┘
 *
 * 折叠模型（`openTurnStatusGroups` store，见 claude-turn-status-open.ts）：
 *  - 默认收起 —— 跑动中的组也一样，活动由组头的 shimmer live 标签表达；
 *  - 单开手风琴 —— 点开一个组，同 scope 里上一个打开的组自动收起。
 *
 * 组头 = 标签 + 状态词 + 箭头：
 *  - 收口后标签是批次总结（"Searched code"，模型写的 batchLabel 优先）；
 *  - 跑动中标签是最后一个在跑工具的进行时短语，带 shimmer（Claude 的 RJ）；
 *  - 状态词只在 failed/stopped 时出现（"Failed" 红 / "Stopped" 灰），
 *    done 与 running 没有词（`Vj()` 的 null 分支）。
 */

import { useState, useSyncExternalStore } from "react";
import { highlightCodeHtml } from "../../../../packages/coding-agent/src/utils/syntax-highlight.ts";
import type { ToolCard } from "../hooks/transcript.ts";
import { claudeGroupTitle, claudeRowObject } from "./claude-answer-spec.ts";
import { claudeLinkPreviews } from "./claude-link-previews.ts";
import { claudeCellStateOf, claudeGroupState, claudeLiveLabel, claudeStateWord } from "./claude-state-words.ts";
import { claudeToolLabelFor } from "./claude-tool-labels.ts";
import { claudeGroupOpen, claudeGroupToggle, subscribeClaudeGroups } from "./claude-turn-status-open.ts";
import { IconChevron } from "./icons.tsx";

/**
 * 展开输出的高亮语言（Claude 的 display_content：代码类内容按语言渲染）。
 *
 * bash/PowerShell 的输出按 shell 高亮；文件类工具按扩展名推断；
 * 其余（grep 行号文本、任意命令输出）不高亮 —— 和 Claude 的 text 面板一致。
 * highlightCodeHtml 自带长度上限，超长返回 undefined 落回纯文本。
 */
function outputLanguageOf(card: ToolCard): string {
	if (card.name === "bash" || card.name === "powershell") return "bash";
	try {
		const parsed: unknown = JSON.parse(card.args);
		const path =
			parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
				? ((parsed as Record<string, unknown>).path ?? (parsed as Record<string, unknown>).file_path)
				: undefined;
		if (typeof path !== "string") return "";
		const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
		const languages: Record<string, string> = {
			ts: "typescript",
			tsx: "typescript",
			js: "javascript",
			jsx: "javascript",
			mjs: "javascript",
			cjs: "javascript",
			json: "json",
			css: "css",
			html: "html",
			htm: "html",
			py: "python",
			rs: "rust",
			go: "go",
			java: "java",
			md: "markdown",
			sh: "bash",
			bash: "bash",
			zsh: "bash",
			yml: "yaml",
			yaml: "yaml",
			sql: "sql",
			c: "c",
			h: "c",
			cpp: "cpp",
			hpp: "cpp",
			cs: "csharp",
			rb: "ruby",
			php: "php",
			swift: "swift",
			kt: "kotlin",
		};
		return languages[extension] ?? "";
	} catch {
		return "";
	}
}

/**
 * Edit 行的行内 diff 统计（Claude 的 compact 时间线次级元素）：
 * old_str/new_str 的行数 → `+n` 绿 / `-m` 红，mono 12px，无边框无底色。
 */
function editDiffStat(card: ToolCard): { added: number; removed: number } | undefined {
	if (card.name !== "edit" && card.name !== "multi_edit") return undefined;
	try {
		const parsed: unknown = JSON.parse(card.args);
		const args =
			parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		const countLines = (value: unknown): number =>
			typeof value === "string" && value !== "" ? value.split("\n").length : 0;
		const removed = countLines(args.old_str ?? args.old_string);
		const added = countLines(args.new_str ?? args.new_string);
		if (added === 0 && removed === 0) return undefined;
		return { added, removed };
	} catch {
		return undefined;
	}
}

type ClaudeGroupRowProps = {
	card: ToolCard;
	/** 该行的展开状态由父级持有（整组一个 state，重渲染不丢）。 */
	open: boolean;
	onToggle: () => void;
};

function ClaudeGroupRow({ card, open, onToggle }: ClaudeGroupRowProps): React.JSX.Element {
	// 行的标签有两种语域：模型自己写的标题（过去时 + 对象）优先，
	// 没有就退回 Claude 的兜底表（现在/完成时、泛指）。
	const label = claudeToolLabelFor(card);
	const output = card.output;
	const hasOutput = output !== undefined && output.text.trim() !== "";
	// 兜底标签不带对象；对象（路径 / 模式 / 命令）跟在标签后面作为 meta
	// （Claude 的 Step 行：label 后跟一段次级色对象，悬停/展开转主色）。
	// 模型写的标题和文件类标签已经含对象，不再补 meta。
	const meta = claudeRowObject(card);
	const tooltip = [label.text, label.detail].filter((part) => part !== undefined).join(" ");
	// 失败/中断靠行尾状态词表达（Claude 的 outcome word），标签不上色、不加图标。
	const word = claudeStateWord(claudeCellStateOf(card));
	// Edit 行行尾的 +n −m 统计（Claude 的 compact 次级元素：mono 12px，绿/红）。
	const diff = editDiffStat(card);
	return (
		<div className="owl-claude-group-row" data-open={open || undefined} data-status={card.status}>
			<button
				type="button"
				className="owl-claude-group-row-head"
				aria-expanded={open}
				onClick={onToggle}
				title={tooltip}
			>
				<span className="owl-claude-group-row-label" data-meta={meta !== undefined || undefined}>
					{label.text}
				</span>
				{meta !== undefined && <span className="owl-claude-group-row-meta">{meta}</span>}
				{diff !== undefined && (
					<span className="owl-claude-group-row-diff">
						{diff.added > 0 && <span className="owl-claude-diff-added">+{diff.added}</span>}
						{diff.removed > 0 && <span className="owl-claude-diff-removed">-{diff.removed}</span>}
					</span>
				)}
				{word && (
					<span className="owl-claude-state-word" data-tone={word.tone}>
						{word.word}
					</span>
				)}
				<IconChevron className="owl-claude-group-row-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{open &&
				hasOutput &&
				(() => {
					// web_search 的 Sources 段渲染成链接预览卡（Claude 的 rich_content 形态）。
					const previews = claudeLinkPreviews(card);
					if (previews.length > 0) {
						return (
							<div className="owl-claude-link-previews">
								{previews.map((preview) => (
									<a
										key={preview.url}
										className="owl-claude-link-preview"
										href={preview.url}
										target="_blank"
										rel="noreferrer"
									>
										<span className="owl-claude-link-preview-tile" aria-hidden="true">
											{preview.domain[0]?.toUpperCase() ?? "?"}
										</span>
										<span className="owl-claude-link-preview-body">
											<span className="owl-claude-link-preview-title">{preview.title}</span>
											<span className="owl-claude-link-preview-domain">{preview.domain}</span>
										</span>
									</a>
								))}
							</div>
						);
					}
					const language = outputLanguageOf(card);
					const highlighted = language === "" ? undefined : highlightCodeHtml(output.text, language);
					return (
						<pre className="owl-claude-group-output" data-highlighted={highlighted !== undefined || undefined}>
							{highlighted !== undefined ? (
								<code dangerouslySetInnerHTML={{ __html: highlighted }} />
							) : (
								output.text
							)}
						</pre>
					);
				})()}
		</div>
	);
}

export function ClaudeToolGroupView({
	cards,
	scope,
	groupKey,
}: {
	cards: ToolCard[];
	scope: string;
	groupKey: string;
}): React.JSX.Element {
	const openRow = useSyncExternalStore(subscribeClaudeGroups, () => claudeGroupOpen(scope, groupKey));
	const toggleRow = () => claudeGroupToggle(scope, groupKey, !openRow);
	// 跑动中组头换 live 标签（最后一个在跑工具的进行时短语）；收口后落回批次总结。
	const running = claudeGroupState(cards) === "running";
	const live = running ? claudeLiveLabel(cards) : undefined;
	const [openRowId, setOpenRowId] = useState<string | undefined>(undefined);
	const title = claudeGroupTitle(cards);
	const word = claudeStateWord(claudeGroupState(cards));
	return (
		<div className="owl-claude-group" data-open={openRow || undefined}>
			<button type="button" className="owl-claude-group-head" aria-expanded={openRow} onClick={toggleRow}>
				{live !== undefined ? (
					<span className="owl-claude-group-title" data-live="on">
						{live}
					</span>
				) : (
					<span className="owl-claude-group-title">{title}</span>
				)}
				{word && (
					<span className="owl-claude-state-word" data-tone={word.tone}>
						{word.word}
					</span>
				)}
				<IconChevron className="owl-claude-group-chevron h-3 w-3 shrink-0 transition-transform" />
			</button>
			{openRow && (
				<div className="owl-claude-group-box">
					{cards.map((card) => (
						<ClaudeGroupRow
							key={card.id}
							card={card}
							open={openRowId === card.id}
							onToggle={() => setOpenRowId((current) => (current === card.id ? undefined : card.id))}
						/>
					))}
				</div>
			)}
		</div>
	);
}
