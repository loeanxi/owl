import type { ServerEventMessage } from "../bridge/protocol.ts";

export type ToolCard = { id: string; name: string; args: string; status: "running" | "done" };

export type ChatEntry =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; thinking: string; tools: ToolCard[]; error?: string }
	| { kind: "toolResult"; toolName: string; ok: boolean; brief: string };

type AnyEvent = Record<string, any>; // wire events are forward-compat; render defensively

function lastAssistant(entries: ChatEntry[]): (ChatEntry & { kind: "assistant" }) | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "assistant") return entry;
		if (entry.kind === "user") return undefined;
	}
	return undefined;
}

/** Apply one bridge event to the transcript. Returns a new array (immutably). */
export function applyEvent(entries: ChatEntry[], message: ServerEventMessage): ChatEntry[] {
	const event = message.event as AnyEvent;
	switch (event.type) {
		case "message_start": {
			return [...entries, { kind: "assistant", text: "", thinking: "", tools: [] }];
		}
		case "message_update": {
			const ae = event.assistantMessageEvent as AnyEvent | undefined;
			if (!ae) return entries;
			const current = lastAssistant(entries);
			if (!current) return entries;
			const index = entries.indexOf(current);
			switch (ae.type) {
				case "text_delta":
					current.text += ae.delta ?? "";
					break;
				case "thinking_delta":
					current.thinking += ae.delta ?? "";
					break;
				case "toolcall_start": {
					const toolCall = ae.partial?.content?.[ae.contentIndex];
					current.tools.push({
						id: ae.toolCall?.id ?? `tool-${ae.contentIndex}`,
						name: ae.toolCall?.toolName ?? toolCall?.name ?? "tool",
						args: "",
						status: "running",
					});
					break;
				}
				case "toolcall_end": {
					const card = current.tools.find((tool) => tool.id === ae.toolCall?.id);
					if (card) {
						card.args = JSON.stringify(ae.toolCall?.arguments ?? {}, null, 2);
					}
					break;
				}
				default:
					break;
			}
			return [...entries.slice(0, index), { ...current }, ...entries.slice(index + 1)];
		}
		case "message_end": {
			const message = event.message as AnyEvent | undefined;
			if (!message || message.role !== "assistant") return entries;
			const current = lastAssistant(entries);
			if (!current) return entries;
			const index = entries.indexOf(current);
			const text = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "text")
				.map((part: AnyEvent) => part.text)
				.join("\n");
			return [
				...entries.slice(0, index),
				{ ...current, text: text || current.text },
				...entries.slice(index + 1),
			];
		}
		case "agent_end": {
			// Authoritative rebuild: messages include tool results the stream didn't show.
			const messages = (event.messages ?? []) as AnyEvent[];
			return rebuild(messages);
		}
		default:
			return entries;
	}
}

/** Rebuild the transcript from a full AgentMessage[] snapshot. */
export function rebuild(messages: AnyEvent[]): ChatEntry[] {
	const entries: ChatEntry[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			entries.push({ kind: "user", text: textOf(message.content) });
		} else if (message.role === "assistant") {
			const tools: ToolCard[] = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "toolCall")
				.map((part: AnyEvent) => ({
					id: part.id,
					name: part.name,
					args: JSON.stringify(part.arguments ?? {}, null, 2),
					status: "done",
				}));
			entries.push({
				kind: "assistant",
				text: textOf(message.content),
				thinking: (message.content ?? [])
					.filter((part: AnyEvent) => part.type === "thinking")
					.map((part: AnyEvent) => part.thinking ?? "")
					.join("\n"),
				tools,
				error: message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage : undefined,
			});
		} else if (message.role === "toolResult") {
			const output = JSON.stringify(message.output ?? message.content ?? "");
			entries.push({
				kind: "toolResult",
				toolName: message.toolName ?? "tool",
				ok: !message.isError,
				brief: output.length > 400 ? `${output.slice(0, 400)}…` : output,
			});
		}
	}
	return entries;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: AnyEvent) => part.type === "text")
		.map((part: AnyEvent) => part.text ?? "")
		.join("\n");
}
