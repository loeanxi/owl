import { DOMParser } from "linkedom";
import type { EvaluationArtifact, EvaluationCheck, EvaluationTask } from "./types.ts";

export interface EvaluationCheckedArtifact {
	artifact: EvaluationArtifact | null;
	checks: EvaluationCheck[];
}

export function extractEvaluationArtifact(task: EvaluationTask, output: string): EvaluationArtifact | null {
	const fences = [...output.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
	let content = output.trim();
	if (task.outputType === "svg") content = output.match(/<svg\b[\s\S]*?<\/svg\s*>/i)?.[0] ?? "";
	else if (task.outputType === "html")
		content = output.match(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>/i)?.[0] ?? "";
	else if (task.outputType === "code")
		content =
			fences.find((m) => /^(?:javascript|js|typescript|ts)\s*$/i.test(m[1]))?.[2] ?? fences[0]?.[2] ?? content;
	else if (task.outputType === "json") content = fences.find((m) => /^json\s*$/i.test(m[1]))?.[2] ?? content;
	if (!content || content.length > 2_000_000) return null;
	return {
		type: task.outputType,
		content: content.trim(),
		previewAllowed: task.outputType === "code" || task.outputType === "json",
	};
}

/** Format and preview policy checks are separate from semantic or behavioral quality. */
export async function checkEvaluationArtifact(
	task: EvaluationTask,
	output: string,
	signal?: AbortSignal,
): Promise<EvaluationCheckedArtifact> {
	signal?.throwIfAborted();
	const artifact = extractEvaluationArtifact(task, output);
	const checks: EvaluationCheck[] = [];
	if (!artifact)
		return {
			artifact: null,
			checks: [
				{
					id: "format",
					label: "输出格式有效",
					status: "failed",
					detail: "没有提取到完整产物，或产物超出大小限制。",
				},
			],
		};
	let formatValid = true;
	if (artifact.type === "json") {
		try {
			JSON.parse(artifact.content);
		} catch {
			formatValid = false;
		}
	} else if (artifact.type === "svg") {
		try {
			const document = new DOMParser().parseFromString(artifact.content, "image/svg+xml");
			formatValid = document.documentElement?.localName === "svg" && !document.querySelector("parsererror");
		} catch {
			formatValid = false;
		}
	} else if (artifact.type === "html")
		formatValid = /<html\b/i.test(artifact.content) && /<\/html\s*>/i.test(artifact.content);
	checks.push({
		id: "format",
		label: "输出格式有效",
		status: formatValid ? "passed" : "failed",
		detail: formatValid ? "已提取完整产物。" : "格式解析失败。",
	});
	if (artifact.type === "svg" || artifact.type === "html") {
		const safe =
			!/<(?:iframe|object|embed|base)\b|<!ENTITY|<!DOCTYPE\s+(?!html\b)|\b(?:src|href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|file:|javascript:|data:)|@import|url\(\s*["']?\s*(?:https?:|\/\/|file:)/i.test(
				artifact.content,
			) && !(artifact.type === "svg" && /<script\b|<foreignObject\b|\son[a-z]+\s*=/i.test(artifact.content));
		artifact.previewAllowed = formatValid && safe;
		checks.push({
			id: "safe",
			label: "独立预览与外部资源检查",
			status: safe ? "passed" : "failed",
			detail: safe
				? "未发现禁止的嵌入、事件脚本或外部资源声明；预览使用独立沙箱。"
				: "包含禁止的嵌入、SVG脚本或外部资源，保留源码并停用预览。",
		});
	}
	for (const spec of task.checks)
		if (!["format", "safe"].includes(spec.kind))
			checks.push({
				id: spec.id,
				label: spec.label,
				status: "unchecked",
				detail: "检查器尚未运行；不会按通过计分。",
			});
	return { artifact, checks };
}
