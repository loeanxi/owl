import type { ChatEntry } from "../hooks/transcript.ts";

export function conversationTitleOf(entries: readonly ChatEntry[], fallback: string): string {
	const first = entries.find((entry) => entry.kind === "user");
	if (!first) return fallback;
	const line = first.text.split("\n").find((part) => part.trim() !== "") ?? "";
	return line.length > 42 ? `${line.slice(0, 42)}…` : line || fallback;
}
