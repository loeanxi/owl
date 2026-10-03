/**
 * render_ui 工具（owl 版）：模型侧的第二条 GenUI 出口——把一份 GenUI spec
 * 渲染为会话工具行里的交互卡片（```owl-ui 围栏渲染在回答正文内，本工具
 * 渲染在工具行）。修复后的 spec 放进结果的 details.genuiSpec，桌面端
 * ChatStream 按工具名分流到 GenuiBlock 渲染。
 *
 * 深度校验、确定性修复与资源限额都在 guard（client/guard.ts）——参数 schema
 * 刻意保持宽松，不拦截 guard 能修复的树。specOf 的防御性解包沿用 dsh 版：
 * 模型/桥层偶尔会把 spec 双重编码成字符串，能解则解，解不开再报错。
 * @module owl-genui/plugin/tool
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@owl/owl-coding-agent";
import { isRenderableProcess, processGenuiSpec, type GenuiProcessResult } from "../../client/guard.ts";
import type { GenuiSpec } from "../../client/spec.ts";
import { collectInlineContentWarnings } from "./inline-content-diagnostic.ts";

/** 参数 schema：宽松的 spec 槽位，guard 是唯一的修复权威。 */
const RenderUiParams = Type.Object({
	spec: Type.Object(
		{},
		{
			additionalProperties: true,
			description: [
				"Render structured UI for the user (tool-row card). USE THIS whenever the answer contains ≥3 parallel points, a comparison, numbers/metrics, a step sequence, a flow, or a status/report — do NOT write those as markdown bullets or a markdown table.",
				"Same white-listed vocabulary as the ```owl-ui fence (see the GenUI system-prompt section). Pick the fence when the UI belongs in the message body; pick this tool when the deliverable is a self-contained card.",
				"Deep-validated and repaired by the renderer. Pass the spec as a JSON OBJECT — never as a serialized JSON string.",
			].join(" "),
		},
	),
});

/** 解包嵌套的 { spec: ... } 包装层：只到没有 spec 键的那层为止。 */
function unwrapSpec(value: unknown, shape: string): unknown {
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if ("spec" in record) {
			const s = record.spec;
			if (typeof s === "string") return parseSpecJson(s, `${shape}/spec-string`);
			return unwrapSpec(s, `${shape}/spec`);
		}
	}
	return value;
}

/** 尝试解码序列化的 spec；坏 JSON 无法恢复（字节已丢失），返回 undefined。 */
function parseSpecJson(raw: string, shape: string): unknown {
	try {
		return unwrapSpec(JSON.parse(raw), shape);
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		const pos = /position (\d+)/.exec(detail)?.[1] ?? "?";
		console.error(
			`[owl-genui] spec wrapped as ${shape} but its JSON is broken (${raw.length} bytes, error at ${pos}); cannot recover`,
		);
		return undefined;
	}
}

/** 防御性读取 spec 参数（重放时也要能跑）。 */
export function specOf(args: unknown): unknown {
	if (typeof args === "string") return parseSpecJson(args, "bare-string");
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	if ("spec" in record) {
		const s = record.spec;
		if (typeof s === "string") return parseSpecJson(s, "spec-string");
		return unwrapSpec(s, "spec");
	}
	if ("arguments" in record) {
		const a = record.arguments;
		if (typeof a === "string") return parseSpecJson(a, "arguments-string");
		if (typeof a === "object" && a !== null) return unwrapSpec(a, "arguments");
	}
	return undefined;
}

/** 把模型可读的校验字段包进稳定的 GenUI 协议信封。 */
function validationProtocol(lines: string[]): string {
	return ["[owl-ui-validation]", ...lines, "reply_language=conversation"].join("\n");
}

/** 把 process 诊断格式化为稳定的模型可读 warning 字段。 */
function formatProcessWarnings(processed: GenuiProcessResult): string[] {
	return processed.warnings.map((warning) => {
		if (warning.kind === "alias" && warning.canonical !== undefined) {
			const separator = warning.path.lastIndexOf(".");
			const canonicalPath = `${separator < 0 ? "" : warning.path.slice(0, separator + 1)}${warning.canonical}`;
			return warning.message.includes("ignored")
				? `warning=alias_ignored path=${warning.path} canonical=${canonicalPath}`
				: `warning=alias_normalized path=${warning.path} canonical=${canonicalPath}`;
		}
		return `warning=process detail=${JSON.stringify(warning.message)}`;
	});
}

/** 将行内字段的块级 Markdown 诊断写入稳定的验证协议。 */
function formatInlineContentWarningsLines(spec: GenuiSpec): string[] {
	return collectInlineContentWarnings(spec).map(
		(warning) => `warning=block_markdown path=${warning.path} kind=${warning.kind} replacement=${warning.replacement}`,
	);
}

/** 组装 render_ui 工具定义（由扩展入口 registerTool 注册）。 */
export function createRenderUiTool(): ToolDefinition<typeof RenderUiParams> {
	return {
		name: "render_ui",
		label: "渲染 UI 卡片",
		description:
			"Render an interactive UI card in the conversation tool row by passing a GenUI spec (a white-listed component tree; the same vocabulary as the ```owl-ui fence, see the system prompt). "
			+ "Use it when the user asks for a structured panel, dashboard, or form that belongs in the tool row rather than inline in the reply. "
			+ "The card is interactive client-side (tabs, buttons, inputs, switches); components carrying an \"action\" field send [owl-ui-action] back to you when the user interacts, and you should re-render the updated UI.",
		promptSnippet: "render_ui: 用 GenUI spec 在工具行渲染一张交互式 UI 卡片",
		parameters: RenderUiParams,
		// 桥层/模型偶尔把 spec 双重编码成字符串：验证前先解包回对象。
		prepareArguments: (args) => {
			const spec = specOf(args);
			return { spec: typeof spec === "object" && spec !== null ? spec : {} };
		},
		execute: async (_toolCallId, rawParams) => {
			const processed = processGenuiSpec(specOf(rawParams));
			if (!isRenderableProcess(processed) || processed.spec === null) {
				return {
					content: [
						{
							type: "text",
							text: ["[owl-ui-render]", "status=invalid", "error=invalid_spec", "required=items", "next=fix_and_retry", "reply_language=conversation"].join("\n"),
						},
					],
					details: { genuiSpec: null },
				};
			}
			const spec = processed.spec;
			const warnings = [...formatProcessWarnings(processed), ...formatInlineContentWarningsLines(spec)];
			return {
				content: [
					{
						type: "text",
						text: [
							"[owl-ui-render]",
							"status=rendered",
							...(spec.title === undefined ? [] : [`title=${JSON.stringify(spec.title)}`]),
							`rendered=${processed.renderedCount}`,
							"action_feedback=[owl-ui-action]",
							...warnings,
							"reply_language=conversation",
						].join("\n"),
					},
				],
				details: { genuiSpec: spec },
			};
		},
	};
}
