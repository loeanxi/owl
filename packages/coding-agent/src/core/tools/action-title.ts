/**
 * 工具动作标题：让模型自己写一句「做了什么」。
 *
 * Claude Desktop 的工具行标题（"Searched admin frontend structure"、
 * "Checked auth filter path coverage"）是**模型写的**，不是前端派生的 ——
 * Claude Code 让模型在发起工具调用时一并写下一句动作短语。
 *
 * owl 走官方 Anthropic API，tool_use 没有可携带标题的字段，所以这里用等效做法：
 * 给工具 schema 加一个可选的 `title` 参数，并在系统提示词里请模型用一句话
 * 说明这次调用做了什么。工具把它回传到结果的 details，前端据此渲染标题；
 * 模型没写时，前端按动词表合成一个兜底标题。
 *
 * 提示词措辞照搬 Claude Code 的原文（claude-code CLI 的 bundle 里逐字可查）：
 * 「Write a short summary label describing what these tool calls accomplished.
 * It appears as a single-line row in a mobile app and truncates around 30
 * characters, so think git-commit-subject, not sentence. Keep the verb in past
 * tense and the most distinctive noun. Drop articles, connectors, and long
 * location context first.」—— 过去时 + 最有辨识度的名词，是 Claude 标题的语法底色。
 */

import { Type } from "typebox";

/**
 * 供工具 schema 复用的可选 `title` 参数。
 *
 * 说明写得具体些，模型才会写出「动词 + 对象」这种可用作标题的短语，
 * 而不是把参数复述一遍。
 */
export const actionTitleParameter = Type.Optional(
	Type.String({
		description:
			"Short label for this call, shown as the call's heading in the UI. It is a single line that truncates " +
			"around 30 characters, so think git-commit-subject, not sentence: keep the verb in past tense and the " +
			"most distinctive noun, and drop articles, connectors, and long location context first " +
			"(for example 'Searched in auth/', 'Fixed NPE in UserService', 'Read config.json').",
	}),
);

/**
 * 统一放进系统提示词的指引。
 *
 * 放在每个核心工具的 promptGuidelines 里（按工具名分组进提示词）。
 * 措辞对齐 Claude Code 的「Write a short summary label …」原文，
 * 改写为单行 —— 提示词里的每条 guideline 都是一个 `- ` 列表项。
 */
export const actionTitleGuideline =
	"When calling this tool, also set `title` to a short label describing what this call accomplished: " +
	"it is shown as a single-line heading and truncates around 30 characters, so think git-commit-subject, not sentence. " +
	"Keep the verb in past tense and the most distinctive noun, and drop articles, connectors, and long location " +
	"context first (e.g. 'Searched in auth/', 'Fixed NPE in UserService', 'Created signup endpoint', " +
	"'Read config.json', 'Ran failing tests').";

/** 工具结果里回传标题的 details 片段。 */
export interface ActionTitleDetails {
	/** 模型写的动作短语。 */
	title?: string;
}

/**
 * 从工具入参里取出模型写的标题。
 *
 * 入参是 unknown（不同 provider 的形状不同），这里只取字符串且非空的。
 */
export function actionTitleOf(input: unknown): string | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const value = (input as { title?: unknown }).title;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
