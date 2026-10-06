import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { fuzzyFindText } from "./edit-diff.ts";
import { resolveReadPath } from "./path-utils.ts";

/**
 * An existing file may be changed only from a `read` that is still in the
 * current user turn. A read dropped by compaction is gone. A successful
 * `edit` or `write` of that file makes earlier reads stale. Creating a new
 * file with `write` is not gated.
 */
const PARTIAL_READ = /\[Showing lines \d+-\d+ of \d+|\[\d+ more lines in file\.|\[Line \d+ is [^\]]*exceeds /;

export interface TurnRead {
	text: string;
	/** Started at the beginning and the tool did not report unread remainder. */
	fullFile: boolean;
}

export function assertEditSeenThisTurn(
	sessionManager: Pick<ReadonlySessionManager, "buildSessionProjection">,
	absolutePath: string,
	cwd: string,
	displayPath: string,
	oldTexts: readonly string[],
): void {
	const reads = currentTurnReads(sessionManager.buildSessionProjection().messages, absolutePath, cwd);
	if (reads.length === 0) {
		throw new Error(
			`Refusing to edit ${displayPath}: it has not been read in this turn. Call the read tool on this path first. A read from an earlier turn, one removed by compaction, or one from before an edit or write of this file, does not count.`,
		);
	}
	for (const oldText of oldTexts) {
		if (oldText.length === 0) continue;
		if (reads.some((read) => fuzzyFindText(read.text, oldText).found)) continue;
		throw new Error(
			`Refusing to edit ${displayPath}: ${quote(oldText)} was not in a read of this file from this turn. Read the region that contains it, then edit.`,
		);
	}
}

export function assertFullFileReadThisTurn(
	sessionManager: Pick<ReadonlySessionManager, "buildSessionProjection">,
	absolutePath: string,
	cwd: string,
	displayPath: string,
): void {
	const reads = currentTurnReads(sessionManager.buildSessionProjection().messages, absolutePath, cwd);
	if (reads.some((read) => read.fullFile)) return;
	if (reads.length === 0) {
		throw new Error(
			`Refusing to overwrite ${displayPath}: it has not been read in this turn. Call the read tool on this path first. A read from an earlier turn, one removed by compaction, or one from before an edit or write of this file, does not count.`,
		);
	}
	throw new Error(
		`Refusing to overwrite ${displayPath}: this turn did not read the whole file. Call read from the start without a remaining-lines cutoff, then write.`,
	);
}

export function fileWasReadThisTurn(messages: readonly AgentMessage[], absolutePath: string, cwd: string): boolean {
	return currentTurnReads(messages, absolutePath, cwd).length > 0;
}

export function currentTurnReads(messages: readonly AgentMessage[], absolutePath: string, cwd: string): TurnRead[] {
	const wanted = fileKey(resolveReadPath(absolutePath, cwd));
	const turn = messagesAfterLastUser(messages);
	const calls = new Map<string, ToolCallPath>();
	const reads: TurnRead[] = [];
	for (const message of turn) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (block.name !== "read" && block.name !== "edit" && block.name !== "write") continue;
				const path = block.arguments.path;
				if (typeof path !== "string") continue;
				calls.set(block.id, {
					name: block.name,
					path,
					offset: typeof block.arguments.offset === "number" ? block.arguments.offset : undefined,
				});
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError) continue;
		const call = calls.get(message.toolCallId);
		if (!call || fileKey(resolveReadPath(call.path, cwd)) !== wanted) continue;
		if (call.name === "edit" || call.name === "write") {
			reads.length = 0;
			continue;
		}
		if (call.name !== "read" || message.toolName !== "read" || !Array.isArray(message.content)) continue;
		const text = textOf(message.content);
		const hasImage = message.content.some((block) => block.type === "image");
		reads.push({
			text,
			fullFile: !hasImage && (call.offset === undefined || call.offset <= 1) && !PARTIAL_READ.test(text),
		});
	}
	return reads;
}

interface ToolCallPath {
	name: string;
	path: string;
	offset?: number;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function messagesAfterLastUser(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return messages.slice(i + 1);
	}
	return messages;
}

function fileKey(filePath: string): string {
	const resolved = resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function quote(oldText: string): string {
	const oneLine = oldText.replace(/\s+/g, " ").trim();
	const shown = oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
	return `"${shown}"`;
}
