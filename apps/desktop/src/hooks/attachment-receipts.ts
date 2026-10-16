import type { ChatEntry, ToolCard } from "./transcript.ts";
import { workspaceArtifactPath } from "./artifacts.ts";
import { absoluteAttachmentPath } from "./attachment-preflight.ts";

export type AttachmentReadStatus = "referenced" | "reading" | "returned" | "partial" | "failed" | "unknown";
export type AttachmentReadNote = "queued" | "cancelled" | "missingOutput" | "directory" | "imageOmitted" | "imageUnavailable" | "empty" | "rangeUnknown" | "tooLong";
export interface AttachmentReadEvidence {
	toolId: string;
	ownerIndex?: number;
	toolName: string;
	status: AttachmentReadStatus;
	note?: AttachmentReadNote;
	range?: { start: number; end?: number; limit?: number; total?: number };
	error?: string;
}
export interface AttachmentReceipt {
	path: string;
	status: AttachmentReadStatus;
	evidence: AttachmentReadEvidence[];
}

/** Lexical matching only; file existence, content versions and symlinks are not inferred. */
export function attachmentPathKey(input: string, cwd?: string): string | undefined {
	if (!input || /[\x00-\x1f\x7f]/.test(input) || /^~(?:[\\/]|$)/.test(input)) return undefined;
	const local = cwd ? workspaceArtifactPath(input, cwd) : undefined;
	const value = absoluteAttachmentPath(local ?? input, cwd ?? "");
	if (!value) return undefined;
	return /^[a-z]:\//i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

function readEvidence(tool: ToolCard, args: Record<string, unknown>): AttachmentReadEvidence {
	const evidence: AttachmentReadEvidence = { toolId: tool.id, toolName: tool.name, status: "unknown" };
	const start = Number.isInteger(args.offset) && Number(args.offset) >= 1 ? Number(args.offset) : 1;
	const limit = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
	if (tool.name === "read" && (args.offset !== undefined || limit !== undefined)) evidence.range = { start, ...(limit ? { limit } : {}) };
	if (tool.status === "pending") return { ...evidence, status: "referenced", note: "queued" };
	if (tool.status === "running") return { ...evidence, status: "reading" };
	if (tool.status === "error") return { ...evidence, status: "failed", error: tool.output?.text.slice(0, 800) };
	if (tool.status === "cancelled") return { ...evidence, note: "cancelled" };
	if (!tool.output) return { ...evidence, note: "missingOutput" };
	const text = tool.output.text;
	if (/^\[Directory listing:/.test(text)) return { ...evidence, note: "directory" };
	if (text.includes("[Current model does not support images. The image will be omitted from this request.]")) return { ...evidence, note: "imageOmitted" };
	if (tool.output.images?.length) return { ...evidence, status: "returned" };
	if (/^Read image file \[/.test(text) || ["view_image", "read_image", "open_image"].includes(tool.name)) return { ...evidence, note: "imageUnavailable" };
	if (tool.name !== "read") return { ...evidence, note: "rangeUnknown" };
	const shown = text.match(/\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^\]]+ limit\))?\. Use offset=\d+ to continue\.\]$/);
	if (shown) return { ...evidence, status: "partial", range: { start: Number(shown[1]), end: Number(shown[2]), total: Number(shown[3]), ...(limit ? { limit } : {}) } };
	const remaining = text.match(/\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/);
	if (remaining) { const end = Number(remaining[2]) - 1; return { ...evidence, status: "partial", range: { start, end, total: end + Number(remaining[1]), ...(limit ? { limit } : {}) } }; }
	if (/^\[Line \d+ is [^\n]+, exceeds [^\n]+ limit\. Use bash:/.test(text)) return { ...evidence, note: "tooLong" };
	if (text.includes("chars truncated") || text.includes("[truncated]")) return { ...evidence, status: "partial", note: "rangeUnknown" };
	const bodyLines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
	const range = bodyLines > 0 ? { start, end: start + bodyLines - 1, ...(limit ? { limit } : {}) } : evidence.range;
	return { ...evidence, status: start > 1 || limit !== undefined ? "partial" : "returned", range, ...(text === "" ? { note: "empty" as const } : {}) };
}

/** Match only explicit tool calls after this non-queued user message and before the next. */
export function collectAttachmentReceipts(entries: readonly ChatEntry[], cwd?: string): Map<number, AttachmentReceipt[]> {
	const result = new Map<number, AttachmentReceipt[]>();
	let current: AttachmentReceipt[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.kind === "user") {
			if (entry.queued) { result.set(index, (entry.attachedPaths ?? []).map((path) => ({ path, status: "referenced", evidence: [] }))); continue; }
			current = (entry.attachedPaths ?? []).map((path) => ({ path, status: "referenced", evidence: [] }));
			result.set(index, current);
			continue;
		}
		if (entry.kind !== "assistant" || current.length === 0) continue;
		for (const tool of entry.tools) {
			if (!["read", "read_file", "view_image", "read_image", "open_image"].includes(tool.name)) continue;
			let args: Record<string, unknown>;
			try { const value: unknown = JSON.parse(tool.args); if (!value || typeof value !== "object" || Array.isArray(value)) continue; args = value as Record<string, unknown>; } catch { continue; }
			const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
			const key = path ? attachmentPathKey(path, cwd) : undefined;
			if (!key) continue;
			for (const receipt of current) if (attachmentPathKey(receipt.path, cwd) === key) {
				const evidence = { ...readEvidence(tool, args), ownerIndex: index };
				receipt.evidence.push(evidence); receipt.status = evidence.status;
			}
		}
	}
	return result;
}
