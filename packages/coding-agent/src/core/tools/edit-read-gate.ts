import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NestedToolCalls } from "@earendil-works/pi-ai";
import type { PendingNestedToolCalls } from "../nested-tool-calls.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { fuzzyFindText } from "./edit-diff.ts";
import { resolveReadPath } from "./path-utils.ts";

/**
 * An existing file may be changed only from a `read` that is still in the
 * current user turn. A read dropped by compaction is gone. A successful
 * `edit` or `write` of that file makes earlier reads stale. A complete successful
 * write can separately supply a known version, verified against current bytes.
 * Creating a new file with `write` is not gated.
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
	pendingNestedCalls: readonly PendingNestedToolCalls[] = [],
	currentBytes?: Buffer,
): void {
	const messages = sessionManager.buildSessionProjection().messages;
	const reads = currentTurnReads(messages, absolutePath, cwd, pendingNestedCalls);
	const written = verifiedFullWriteThisTurn(messages, absolutePath, cwd, currentBytes, pendingNestedCalls);
	if (written !== undefined) reads.push({ text: written, fullFile: true });
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
	pendingNestedCalls: readonly PendingNestedToolCalls[] = [],
	currentBytes?: Buffer,
): void {
	const messages = sessionManager.buildSessionProjection().messages;
	if (verifiedFullWriteThisTurn(messages, absolutePath, cwd, currentBytes, pendingNestedCalls) !== undefined) return;
	const reads = currentTurnReads(messages, absolutePath, cwd, pendingNestedCalls);
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

/** Known complete write content is not read evidence, and is usable only while its exact bytes remain current. */
function verifiedFullWriteThisTurn(
	messages: readonly AgentMessage[],
	absolutePath: string,
	cwd: string,
	currentBytes: Buffer | undefined,
	pendingNestedCalls: readonly PendingNestedToolCalls[],
): string | undefined {
	if (!currentBytes || !messages.some((message) => message.role === "user")) return undefined;
	const wanted = readPathKey(absolutePath, cwd);
	const calls = new Map<string, { name: string; path: string; content?: string }>();
	const parents = new Set<string>();
	const completed = new Set<string>();
	let written: string | undefined;
	const invalidates = (nested: NestedToolCalls): boolean =>
		nested.fileAccessComplete === false ||
		nested.calls.some((call) => {
			if (call.status !== "ok" || (call.name !== "edit" && call.name !== "write")) return false;
			const path = call.fileMutationPath ?? call.arguments?.path;
			return typeof path !== "string" || readPathKey(path, cwd) === wanted;
		});
	for (const message of messagesAfterLastUser(messages)) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				parents.add(block.id);
				if (block.name !== "edit" && block.name !== "write") continue;
				if (typeof block.arguments.path !== "string") continue;
				calls.set(block.id, {
					name: block.name,
					path: block.arguments.path,
					content: typeof block.arguments.content === "string" ? block.arguments.content : undefined,
				});
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		completed.add(message.toolCallId);
		if (parents.has(message.toolCallId) && message.nestedCalls && invalidates(message.nestedCalls))
			written = undefined;
		const call = calls.get(message.toolCallId);
		if (!call || readPathKey(call.path, cwd) !== wanted) continue;
		written = !message.isError && message.toolName === "write" && call.name === "write" ? call.content : undefined;
	}
	for (const pending of pendingNestedCalls) {
		if (
			parents.has(pending.parentToolCallId) &&
			!completed.has(pending.parentToolCallId) &&
			invalidates(pending.calls)
		) {
			written = undefined;
		}
	}
	if (written === undefined || written.includes("\0")) return undefined;
	const expected = Buffer.from(written, "utf8");
	if (expected.toString("utf8") !== written || !expected.equals(currentBytes)) return undefined;
	return written;
}

export function fileWasReadThisTurn(messages: readonly AgentMessage[], absolutePath: string, cwd: string): boolean {
	return currentTurnReads(messages, absolutePath, cwd).length > 0;
}

export function currentTurnReads(
	messages: readonly AgentMessage[],
	absolutePath: string,
	cwd: string,
	pendingNestedCalls: readonly PendingNestedToolCalls[] = [],
): TurnRead[] {
	const wanted = readPathKey(absolutePath, cwd);
	const turn = messagesAfterLastUser(messages);
	const calls = new Map<string, ToolCallPath>();
	const parentCalls = new Set<string>();
	const completedParents = new Set<string>();
	const reads: TurnRead[] = [];
	for (const message of turn) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				parentCalls.add(block.id);
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
		if (message.role !== "toolResult") continue;
		completedParents.add(message.toolCallId);
		// A parent can fail after completing a read or file change. Those nested effects still count.
		if (parentCalls.has(message.toolCallId) && message.nestedCalls) {
			applyNestedReads(message.nestedCalls, wanted, cwd, reads);
		}
		if (message.isError) continue;
		const call = calls.get(message.toolCallId);
		if (!call || readPathKey(call.path, cwd) !== wanted) continue;
		if (call.name === "edit" || call.name === "write") {
			reads.length = 0;
			continue;
		}
		if (call.name !== "read" || message.toolName !== "read" || !Array.isArray(message.content)) continue;
		reads.push(readResultEvidence(message.content, call.offset));
	}
	for (const pending of pendingNestedCalls) {
		// The parent must still be present after compaction and within this user turn.
		if (!parentCalls.has(pending.parentToolCallId) || completedParents.has(pending.parentToolCallId)) continue;
		applyNestedReads(pending.calls, wanted, cwd, reads);
	}
	return reads;
}

export function readResultEvidence(content: readonly { type: string; text?: string }[], offset: unknown): TurnRead {
	const text = textOf(content);
	const hasImage = content.some((block) => block.type === "image");
	return {
		text,
		fullFile: !hasImage && (typeof offset !== "number" || offset <= 1) && !PARTIAL_READ.test(text),
	};
}

function applyNestedReads(nested: NestedToolCalls, wanted: string, cwd: string, reads: TurnRead[]): void {
	const completed = nested.calls
		.filter((call) => call.status === "ok")
		.sort((left, right) => (left.completionOrder ?? 0) - (right.completionOrder ?? 0));
	for (const call of completed) {
		if (call.name === "edit" || call.name === "write") {
			const path = call.fileMutationPath ?? call.arguments?.path;
			if (typeof path === "string" && readPathKey(path, cwd) === wanted) reads.length = 0;
		} else if (call.name === "read" && call.readResult) {
			if (readPathKey(call.readResult.path, cwd) !== wanted) continue;
			reads.push({ text: call.readResult.text, fullFile: call.readResult.fullFile });
		}
	}
	// An unrecorded successful file access may have changed this file. Require a new visible read.
	if (nested.fileAccessComplete === false) reads.length = 0;
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

export function readPathKey(filePath: string, cwd: string): string {
	const resolved = resolve(resolveReadPath(filePath, cwd));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function quote(oldText: string): string {
	const oneLine = oldText.replace(/\s+/g, " ").trim();
	const shown = oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
	return `"${shown}"`;
}
