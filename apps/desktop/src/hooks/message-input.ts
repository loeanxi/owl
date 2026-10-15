import type { ComposerImage } from "../components/Composer.tsx";
import { userSourceText } from "./skill-invocation.ts";
import type { ChatEntry } from "./transcript.ts";
import { parseUserMessage } from "./user-message.ts";

export type MessageInput = { text: string; images?: ComposerImage[]; attachedPaths?: string[] };

/** Preserve the entire original input when editing, regenerating or returning it to the composer. */
export function messageInputOf(entry: Extract<ChatEntry, { kind: "user" }>, text = entry.text): MessageInput {
	const parsed = parseUserMessage(text);
	const attachedPaths = [...new Set([...(entry.attachedPaths ?? []), ...parsed.attachedPaths])];
	return {
		text: userSourceText(parsed.body),
		...(entry.images?.length ? { images: entry.images.map((image) => ({ type: "image" as const, ...image })) } : {}),
		...(attachedPaths.length ? { attachedPaths } : {}),
	};
}
