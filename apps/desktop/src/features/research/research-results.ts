import type { ResearchResult } from "../../bridge/protocol.ts";

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read the publish tool's evidence payload, never infer results from assistant prose. */
export function researchResultOf(value: unknown): ResearchResult | undefined {
	const result = objectOf(value);
	if (!result || typeof result.id !== "string" || !result.id || typeof result.createdAt !== "string" ||
		typeof result.title !== "string" || typeof result.summary !== "string" ||
		!["crawl", "web", "model", "osint"].includes(String(result.mode)) ||
		!["sample", "partial", "complete"].includes(String(result.status)) ||
		!Array.isArray(result.columns) || !Array.isArray(result.rows) || !Array.isArray(result.sources) || !Array.isArray(result.findings)) return undefined;
	const keys = new Set<string>();
	for (const item of result.columns) {
		const column = objectOf(item);
		if (!column || typeof column.key !== "string" || !column.key || typeof column.label !== "string" || keys.has(column.key)) return undefined;
		keys.add(column.key);
	}
	for (const item of result.rows) {
		const row = objectOf(item);
		if (!row || Object.values(row).some((cell) => cell !== null && typeof cell !== "string" && typeof cell !== "boolean" && (typeof cell !== "number" || !Number.isFinite(cell)))) return undefined;
	}
	const sources = new Set<string>();
	for (const item of result.sources) {
		const source = objectOf(item);
		if (!source || typeof source.id !== "string" || !source.id || sources.has(source.id) || typeof source.title !== "string" ||
			(source.url !== undefined && typeof source.url !== "string") || (source.note !== undefined && typeof source.note !== "string")) return undefined;
		sources.add(source.id);
	}
	for (const item of result.findings) {
		const finding = objectOf(item);
		if (!finding || !["fact", "inference", "unverified"].includes(String(finding.kind)) || typeof finding.text !== "string" ||
			!Array.isArray(finding.sourceIds) || finding.sourceIds.some((id) => typeof id !== "string" || !sources.has(id))) return undefined;
	}
	return result as unknown as ResearchResult;
}

export function publishedResults(messages: unknown[]): ResearchResult[] {
	const results: ResearchResult[] = [];
	for (const item of messages) {
		const message = objectOf(item);
		if (message?.role !== "toolResult" || message.toolName !== "research_publish" || message.isError === true) continue;
		const result = researchResultOf(objectOf(message.details)?.researchResult);
		if (result) results.push(result);
	}
	return mergeResearchResults([], results);
}

export function researchResultsFromEvent(payload: unknown): ResearchResult[] {
	const event = objectOf(payload);
	if (!event) return [];
	if (event.type === "agent_end" && Array.isArray(event.messages)) return publishedResults(event.messages);
	if (event.type === "message_end") return publishedResults([event.message]);
	if (event.type !== "tool_execution_end" || event.toolName !== "research_publish" || event.isError === true) return [];
	const result = researchResultOf(objectOf(objectOf(event.result)?.details)?.researchResult);
	return result ? [result] : [];
}

export function mergeResearchResults(current: ResearchResult[], next: ResearchResult[]): ResearchResult[] {
	if (!next.length) return current;
	const values = new Map(current.map((result) => [result.id, result]));
	for (const result of next) values.set(result.id, result);
	return [...values.values()];
}

export function safeSourceUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Escape spreadsheet formulas as well as CSV quotes, including leading whitespace. */
export function researchCsv(result: ResearchResult): string {
	const escape = (cell: unknown): string => {
		let text = cell === null || cell === undefined ? "" : String(cell);
		if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
		return `"${text.replace(/"/g, '""')}"`;
	};
	return "\uFEFF" + [result.columns.map((column) => escape(column.label)).join(","), ...result.rows.map((row) => result.columns.map((column) => escape(row[column.key])).join(","))].join("\r\n");
}
