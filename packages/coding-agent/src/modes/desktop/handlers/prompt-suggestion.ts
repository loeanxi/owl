import type { WebSocket } from "ws";
import type { PromptSuggestionService } from "../../../core/prompt-suggestion.ts";
import type { DesktopClientRequest } from "../protocol.ts";

export interface PromptSuggestionHandlerContext {
	service: PromptSuggestionService;
	reply: (ws: WebSocket, id: string, response: { ok: boolean; result?: unknown; error?: string }) => void;
}

export async function handlePromptSuggestionRequest(
	ws: WebSocket,
	request: Extract<DesktopClientRequest, { type: "session.promptSuggestion" | "session.promptSuggestion.cancel" }>,
	context: PromptSuggestionHandlerContext,
): Promise<void> {
	if (request.type === "session.promptSuggestion.cancel") {
		context.service.cancel(ws, request.sessionId, request.generationId);
		context.reply(ws, request.id, { ok: true });
		return;
	}
	const result = await context.service.request(ws, request.sessionId, request.generationId);
	context.reply(ws, request.id, { ok: true, result });
}
