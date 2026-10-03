import MarkdownIt from "markdown-it";
import type { EvaluationResultView, EvaluationRunView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
// Model answers are text. Remote images must never make a network request in the app.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content || "image");

export function conversationMarkdown(text: string): string {
	return markdown.render(text);
}

export interface EvaluationConversationGroup {
	root: EvaluationResultView;
	attempts: EvaluationResultView[];
}

/** Preserve the server's shuffled root order, retaining every retry and its score identity. */
export function evaluationConversations(results: EvaluationResultView[]): EvaluationConversationGroup[] {
	const byId = new Map(results.map((result) => [result.id, result]));
	const groups = new Map<string, EvaluationConversationGroup>();
	for (const result of results) {
		let root = result;
		const seen = new Set([result.id]);
		while (root.retryOf && byId.has(root.retryOf)) {
			if (seen.has(root.retryOf)) { root = result; break; }
			seen.add(root.retryOf);
			root = byId.get(root.retryOf)!;
		}
		const group = groups.get(root.id) ?? { root, attempts: [] };
		group.attempts.push(result);
		groups.set(root.id, group);
	}
	return [...groups.values()].sort((a, b) => results.indexOf(a.root) - results.indexOf(b.root)).map((group) => ({ ...group, attempts: group.attempts.sort((a, b) => a.attempt - b.attempt) }));
}

export function evaluationHasLiveWork(run: EvaluationRunView): boolean {
	return run.status === "running" || run.results.some((result) => result.followups?.some((item) => item.status === "queued" || item.status === "running"));
}

export interface EvaluationConversationState {
	draft: string;
	scrollTop: number;
	following: boolean;
	thinkingOpen: Record<string, boolean>;
}
