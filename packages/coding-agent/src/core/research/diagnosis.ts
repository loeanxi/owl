import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionManager } from "../session-manager.ts";

export const RESEARCH_DIAGNOSIS_ENTRY = "owl-research-diagnosis";
const MAX_PREVIEW_LENGTH = 1200;
const MAX_EVIDENCE_ITEMS = 24;

export type ResearchDiagnosisStatus =
	| "upstream_refusal"
	| "textual_refusal_candidate"
	| "local_approval_denied"
	| "safety_guard_block"
	| "unsupported_capability"
	| "missing_dependency"
	| "provider_error"
	| "tool_error"
	| "cancelled"
	| "unverified";

export interface ResearchDiagnosisEvidence {
	source: "provider" | "tool" | "agent";
	text: string;
	toolName?: string;
	toolCallId?: string;
	rawStopReason?: string;
}

export interface ResearchDiagnosis {
	id: string;
	version: 1;
	createdAt: string;
	ownerSessionId: string;
	status: ResearchDiagnosisStatus;
	summary: string;
	evidence: ResearchDiagnosisEvidence[];
}

const statusValues = [
	"upstream_refusal",
	"textual_refusal_candidate",
	"local_approval_denied",
	"safety_guard_block",
	"unsupported_capability",
	"missing_dependency",
	"provider_error",
	"tool_error",
	"cancelled",
	"unverified",
] as const;
const recordSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
		version: Type.Literal(1),
		createdAt: Type.String({ minLength: 1, maxLength: 30 }),
		ownerSessionId: Type.String({ minLength: 1, maxLength: 256 }),
		status: Type.Union(statusValues.map((status) => Type.Literal(status))),
		summary: Type.String({ minLength: 1, maxLength: 600 }),
		evidence: Type.Array(
			Type.Object(
				{
					source: Type.Union([Type.Literal("provider"), Type.Literal("tool"), Type.Literal("agent")]),
					text: Type.String({ minLength: 1, maxLength: MAX_PREVIEW_LENGTH }),
					toolName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
					toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
					rawStopReason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: MAX_EVIDENCE_ITEMS },
		),
	},
	{ additionalProperties: false },
);

const summaries: Record<ResearchDiagnosisStatus, string> = {
	upstream_refusal: "上游响应提供了明确拒绝或内容过滤标记。该标记不能证明本轮任务被误拒绝，需结合实际目标与材料核对。",
	textual_refusal_candidate:
		"模型回复呈现拒绝措辞，但上游未提供明确拒绝标记；这是文本候选，尚不能确认内容审核或误拒绝。",
	local_approval_denied: "工具调用被本地审批或计划模式阻止；不是上游模型内容审核。",
	safety_guard_block: "研究工具的输入、路径或证据边界阻止了本次操作；不是上游模型内容审核。",
	unsupported_capability: "实际工具记录显示未支持的能力或未注册工具；不是上游模型内容审核。",
	missing_dependency:
		"实际工具记录显示依赖缺失或配置无效；是否影响当前目标需核对所选分析路径，不能据此判为上游模型内容审核。",
	provider_error: "上游响应失败，但未提供明确拒绝标记；不能据此判为内容审核。",
	tool_error: "工具执行失败，当前记录不足以进一步确认原因；不能据此判为上游模型内容审核。",
	cancelled: "本轮模型或工具执行已取消，任务结果未验证。",
	unverified: "本轮响应流程已结束；未独立验证研究目标已完成，不能仅按响应完成状态宣称任务成功。",
};
const priorities: Record<ResearchDiagnosisStatus, number> = {
	upstream_refusal: 100,
	cancelled: 90,
	local_approval_denied: 80,
	safety_guard_block: 70,
	provider_error: 60,
	tool_error: 55,
	missing_dependency: 50,
	unsupported_capability: 40,
	textual_refusal_candidate: 30,
	unverified: 0,
};

/** Only bounded diagnostic excerpts are duplicated; complete messages remain in the transcript. */
function preview(text: string): string {
	return text
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[redacted authorization]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted key]")
		.replace(
			/\b(api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|authorization|cookie)["']?\s*([=:])\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)/gi,
			"$1$2[redacted]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.slice(0, MAX_PREVIEW_LENGTH);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toolEvidence(message: ToolResultMessage, text: string): ResearchDiagnosisEvidence {
	return {
		source: "tool",
		text: preview(text) || "工具返回了错误，但未提供诊断文本。",
		toolName: message.toolName.slice(0, 256),
		toolCallId: message.toolCallId.slice(0, 256),
	};
}

function structuredToolIssues(message: ToolResultMessage): Array<{
	status: ResearchDiagnosisStatus;
	evidence: ResearchDiagnosisEvidence;
}> {
	const details = record(message.details);
	const markers: Array<{ label: string; value: Record<string, unknown> | undefined }> = [];
	if (message.toolName === "research_decompile") {
		const inventory = record(details?.decompilerInventory);
		if (inventory) {
			markers.push({ label: "decompilerInventory.bytecode", value: record(inventory.bytecode) });
			markers.push({ label: "decompilerInventory.native", value: record(inventory.native) });
		}
		const report = record(details?.researchDecompile);
		if (report) {
			markers.push({ label: "researchDecompile.native", value: record(report.native) });
			if (Array.isArray(report.bytecode)) {
				for (const value of report.bytecode.slice(0, 16))
					markers.push({ label: "researchDecompile.bytecode", value: record(value) });
			}
		}
	}
	if (message.toolName === "research_rea")
		markers.push({ label: "researchReaInventory", value: record(details?.researchReaInventory) });
	if (message.toolName === "research_executable")
		markers.push({ label: "researchExecutable", value: record(details?.researchExecutable) });
	return markers.flatMap(({ label, value }) => {
		const actual = value?.status;
		const status: ResearchDiagnosisStatus | undefined =
			actual === "unsupported"
				? "unsupported_capability"
				: actual === "toolMissing" || actual === "invalidConfiguration" || actual === "invalidToolchain"
					? "missing_dependency"
					: actual === "cancelled"
						? "cancelled"
						: undefined;
		if (!status) return [];
		const description = typeof value?.message === "string" ? value.message : value?.reason;
		return [
			{
				status,
				evidence: toolEvidence(
					message,
					`${label}.status=${actual}${typeof description === "string" ? `；${description}` : ""}`,
				),
			},
		];
	});
}

function toolErrorStatus(message: ToolResultMessage, text: string): ResearchDiagnosisStatus | undefined {
	if (!message.isError) return undefined;
	if (text === "Denied by user" || /^Plan mode: tool "[^"\n]+" was blocked — only read-only tools /.test(text))
		return "local_approval_denied";
	if (/^Tool [^\n]+ not found\. Available tools:/.test(text)) return "unsupported_capability";
	if (/^(?:Operation aborted|The operation was aborted(?:\.)?|AbortError:)/.test(text)) return "cancelled";
	if (["research_executable", "research_decompile", "research_rea"].includes(message.toolName)) {
		if (
			/^(?:路径超出已授权的输入目录|真实路径超出已授权的输入目录|拒绝读取符号链接路径|拒绝不安全的容器条目路径|输出目录超出工作区|拒绝清理工作区之外的输出目录|拒绝执行应用或工作区内提供的 UPX|拒绝网络、设备、URL 或备用数据流路径|相对输入路径超出工作区|REA 输入路径不能包含符号链接或目录联接|REA 输出目录包含链接或超出工作区|REA 后端不属于当前研究会话|只能读取当前会话已返回的 REA 证据；)/.test(
				text,
			)
		)
			return "safety_guard_block";
		if (
			/^(?:文件格式不在已支持的反编译范围内|原生分析仅接受明确选中的 PE EXE\/DLL|REA JavaScript 输入仅接受源码文件、应用目录或 ASAR；|REA 6\.4\.0 不支持 ASAR 内选择源码；)/.test(
				text,
			)
		)
			return "unsupported_capability";
		if (text === "未发现应用或工作区以外的已安装 UPX 工具") return "missing_dependency";
	}
	return undefined;
}

/** A conservative text hint, never a verified provider refusal or a decision that the task was safe. */
function refusalCandidate(message: AssistantMessage): string | undefined {
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const firstParagraph = text.split(/\n\s*\n/)[0];
	if (
		/^(?:明确了|目标(?:是|已明确)|你要(?:做|实现)的(?:是)?)[：:，,][^。\n]{0,240}。[ \t]*(?:这个|这件事|这项任务)[，,\s]*(?:我)?(?:做不了|帮不了|无法完成|不能做)/.test(
			firstParagraph,
		) ||
		/^(?:这个|这件事|这项任务)[，,\s]*(?:我)?(?:做不了|帮不了|无法完成|不能做)/.test(firstParagraph) ||
		/^不行[，,。\s]+(?:这(?:个|件事|项任务)[，,\s]*)?(?:我)?(?:不能做|做不了|不能帮|帮不了)/.test(firstParagraph) ||
		/^(?:(?:很)?抱歉[，,：:\s]*)?(?:我)?(?:不能|无法|不会|不可以)(?:帮助|帮你|协助|提供|执行|完成|进行|支持|参与)/.test(
			firstParagraph,
		) ||
		/^(?:(?:I(?:'m| am) sorry|Sorry)[,.:\s]*)?I (?:cannot|can't|won't|am unable to) (?:help|assist|provide|perform|execute|fulfil|fulfill)\b/i.test(
			firstParagraph,
		)
	)
		return firstParagraph;
	return undefined;
}

/** No success classification: transport completion and Agent-authored result cards do not verify a task. */
export function diagnoseResearchTurn(messages: readonly AgentMessage[], ownerSessionId: string): ResearchDiagnosis {
	const issues: Array<{ status: ResearchDiagnosisStatus; evidence: ResearchDiagnosisEvidence }> = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			const explicit =
				message.refusal?.source === "provider" ||
				["refusal", "content_filter", "incomplete.content_filter"].includes(message.rawStopReason ?? "");
			const evidence: ResearchDiagnosisEvidence = {
				source: "provider",
				text: preview(
					message.refusal?.text ||
						message.errorMessage ||
						(explicit ? "上游响应携带明确拒绝标记。" : "上游响应错误，未提供错误文本。"),
				),
				...(message.rawStopReason ? { rawStopReason: preview(message.rawStopReason).slice(0, 128) } : {}),
			};
			if (explicit) issues.push({ status: "upstream_refusal", evidence });
			else if (message.stopReason === "aborted") issues.push({ status: "cancelled", evidence });
			else if (message.stopReason === "error") issues.push({ status: "provider_error", evidence });
		} else if (message.role === "toolResult") {
			issues.push(...structuredToolIssues(message));
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			const status = toolErrorStatus(message, text);
			if (status) issues.push({ status, evidence: toolEvidence(message, text) });
			else if (message.isError) issues.push({ status: "tool_error", evidence: toolEvidence(message, text) });
		}
	}
	const lastAssistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
	if (lastAssistant && !issues.some((issue) => issue.status === "upstream_refusal")) {
		const text = refusalCandidate(lastAssistant);
		if (text)
			issues.push({ status: "textual_refusal_candidate", evidence: { source: "agent", text: preview(text) } });
	}
	issues.sort((left, right) => priorities[right.status] - priorities[left.status]);
	const status = issues[0]?.status ?? "unverified";
	return {
		id: globalThis.crypto.randomUUID(),
		version: 1,
		createdAt: new Date().toISOString(),
		ownerSessionId,
		status,
		summary: summaries[status],
		evidence: issues.length
			? issues.slice(0, MAX_EVIDENCE_ITEMS).map((issue) => issue.evidence)
			: [{ source: "agent", text: "未观察到明确拒绝或已识别的失败标记；响应结束不等于研究目标已验证。" }],
	};
}

type DiagnosisSession = Pick<SessionManager, "getEntries" | "getBranch" | "getSessionId">;

/** Pure wire/ledger validation. A supplied owner must match before data is shown. */
export function isResearchDiagnosis(value: unknown, ownerSessionId?: string): value is ResearchDiagnosis {
	if (!Value.Check(recordSchema, value)) return false;
	const diagnosis = value as ResearchDiagnosis;
	const timestamp = Date.parse(diagnosis.createdAt);
	return (
		Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString() === diagnosis.createdAt &&
		diagnosis.ownerSessionId.trim().length > 0 &&
		diagnosis.summary.trim().length > 0 &&
		diagnosis.evidence.every((item) => item.text.trim().length > 0) &&
		(ownerSessionId === undefined || diagnosis.ownerSessionId === ownerSessionId)
	);
}

/** Restore only the current research branch. Invalid/foreign latest data never falls back to older records. */
export function getResearchDiagnosis(sessionManager: DiagnosisSession): ResearchDiagnosis | undefined {
	const scope = sessionManager
		.getEntries()
		.findLast((item) => item.type === "custom" && item.customType === "owl-research-mode");
	if (scope?.type !== "custom") return undefined;
	const scopeData = record(scope.data);
	if (
		!scopeData ||
		typeof scopeData.mode !== "string" ||
		!["auto", "crawl", "web", "binary", "model", "osint"].includes(scopeData.mode)
	)
		throw new Error("研究会话记录中的方向无效，不能恢复诊断");
	const entry = sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === RESEARCH_DIAGNOSIS_ENTRY);
	if (entry?.type !== "custom") return undefined;
	if (!isResearchDiagnosis(entry.data)) throw new Error("研究诊断记录格式无效，不能恢复该记录");
	const diagnosis = entry.data as ResearchDiagnosis;
	if (diagnosis.ownerSessionId !== sessionManager.getSessionId()) throw new Error("研究诊断记录的会话归属无效");
	return JSON.parse(JSON.stringify(diagnosis)) as ResearchDiagnosis;
}

export function saveResearchDiagnosis(
	sessionManager: SessionManager,
	messages: readonly AgentMessage[],
	appendEntry?: (customType: string, data: ResearchDiagnosis) => void,
): ResearchDiagnosis {
	if (
		!sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "owl-research-mode")
	)
		throw new Error("普通会话不能保存研究诊断");
	getResearchDiagnosis(sessionManager);
	const diagnosis = diagnoseResearchTurn(messages, sessionManager.getSessionId());
	if (appendEntry) appendEntry(RESEARCH_DIAGNOSIS_ENTRY, diagnosis);
	else sessionManager.appendCustomEntry(RESEARCH_DIAGNOSIS_ENTRY, diagnosis);
	return diagnosis;
}
