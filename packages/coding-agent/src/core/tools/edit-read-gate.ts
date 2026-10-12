import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { splitBom } from "../../utils/text.ts";
import type { PendingNestedToolCalls } from "../nested-tool-calls.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { fuzzyFindText, normalizeToLF } from "./edit-diff.ts";
import { resolveReadPath } from "./path-utils.ts";
import { formatSize, truncateHead } from "./truncate.ts";

/**
 * An existing file may be changed only from a `read` that still shows its
 * current content. A read in the current user turn counts as long as no later
 * `edit` or `write` of that file happened. A read from an earlier user turn
 * counts only while its text still matches the bytes on disk, so a `继续`
 * does not force a re-read of an unchanged file, but an external change does.
 * A read dropped by compaction is gone. A complete successful write can
 * separately supply a known version, verified against current bytes. A failed
 * write does not change the file, so it does not erase the last verified
 * version. Creating a new file with `write` is not gated.
 *
 * A refusal carries the current file content after GATE_SNAPSHOT_MARKER. That
 * snapshot counts as a read, so the retry succeeds without a separate `read`.
 */
const PARTIAL_READ = /\[Showing lines \d+-\d+ of \d+|\[\d+ more lines in file\.|\[Line \d+ is [^\]]*exceeds /;
const READ_NOTICE_SUFFIX = /\n\n\[(?:Showing lines \d+-\d+ of \d+[^\]\n]*|\d+ more lines in file\.[^\]\n]*)\]$/;
const OVERSIZED_LINE_NOTICE = /^\[Line \d+ is [^\]]*exceeds /;
export const GATE_SNAPSHOT_MARKER =
	"[Current file content follows. It counts as your read of this file: retry the call against it, do not call read again.]";

export interface TurnRead {
	text: string;
	/** Started at the beginning and the tool did not report unread remainder. */
	fullFile: boolean;
}

interface IndexedRead extends TurnRead {
	/** Position of the evidence in the projected messages; pending nested reads use messages.length. */
	index: number;
}

export function assertEditTargetRead(
	sessionManager: Pick<ReadonlySessionManager, "buildSessionProjection">,
	absolutePath: string,
	cwd: string,
	displayPath: string,
	oldTexts: readonly string[],
	pendingNestedCalls: readonly PendingNestedToolCalls[] = [],
	currentBytes?: Buffer,
): void {
	const messages = sessionManager.buildSessionProjection().messages;
	const reads = usableReads(messages, absolutePath, cwd, pendingNestedCalls, currentBytes);
	const written = verifiedFullWriteThisTurn(messages, absolutePath, cwd, currentBytes, pendingNestedCalls);
	if (written !== undefined) reads.push({ text: written, fullFile: true });
	if (reads.length === 0) {
		throw new Error(
			withSnapshot(
				`Refusing to edit ${displayPath}: no read of its current content is in context (never read, removed by compaction, or changed since the last read).`,
				currentBytes,
			),
		);
	}
	for (const oldText of oldTexts) {
		if (oldText.length === 0) continue;
		if (reads.some((read) => fuzzyFindText(read.text, oldText).found)) continue;
		throw new Error(
			withSnapshot(
				`Refusing to edit ${displayPath}: ${quote(oldText)} was not in a read of its current content.`,
				currentBytes,
			),
		);
	}
}

export function assertFullFileRead(
	sessionManager: Pick<ReadonlySessionManager, "buildSessionProjection">,
	absolutePath: string,
	cwd: string,
	displayPath: string,
	pendingNestedCalls: readonly PendingNestedToolCalls[] = [],
	currentBytes?: Buffer,
): void {
	const messages = sessionManager.buildSessionProjection().messages;
	if (verifiedFullWriteThisTurn(messages, absolutePath, cwd, currentBytes, pendingNestedCalls) !== undefined) return;
	const reads = usableReads(messages, absolutePath, cwd, pendingNestedCalls, currentBytes);
	if (reads.some((read) => read.fullFile)) return;
	if (reads.length === 0) {
		throw new Error(
			withSnapshot(
				`Refusing to overwrite ${displayPath}: no read of its current content is in context (never read, removed by compaction, or changed since the last read).`,
				currentBytes,
			),
		);
	}
	throw new Error(
		withSnapshot(
			`Refusing to overwrite ${displayPath}: no read of the whole current file is in context. Call read from the start without a remaining-lines cutoff, then write.`,
			currentBytes,
		),
	);
}

/** Reads of the current turn, plus earlier-turn reads whose text still matches the file on disk. */
function usableReads(
	messages: readonly AgentMessage[],
	absolutePath: string,
	cwd: string,
	pendingNestedCalls: readonly PendingNestedToolCalls[],
	currentBytes: Buffer | undefined,
): TurnRead[] {
	const turnStart = lastUserIndex(messages) + 1;
	const current = currentBytes ? currentFileText(currentBytes) : undefined;
	return collectReads(messages, 0, absolutePath, cwd, pendingNestedCalls)
		.filter((read) => read.index >= turnStart || (current !== undefined && readMatchesContent(read, current)))
		.map(({ text, fullFile }) => ({ text, fullFile }));
}

function currentFileText(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return undefined;
	return normalizeToLF(splitBom(bytes.toString("utf8")).text);
}

function readMatchesContent(read: TurnRead, current: string): boolean {
	if (OVERSIZED_LINE_NOTICE.test(read.text)) return false;
	const body = normalizeToLF(splitBom(read.text.replace(READ_NOTICE_SUFFIX, "")).text);
	return read.fullFile ? body === current : body.length > 0 && current.includes(body);
}

/** Appends the current file content so the refusal itself supplies the missing read. */
function withSnapshot(message: string, currentBytes: Buffer | undefined): string {
	const current = currentBytes ? currentFileText(currentBytes) : undefined;
	if (current === undefined) return `${message} Call the read tool on this path first.`;
	const truncation = truncateHead(current);
	if (truncation.firstLineExceedsLimit) return `${message} Call the read tool on this path first.`;
	let snapshot = truncation.content;
	if (truncation.truncated) {
		snapshot += `\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Use read with offset=${truncation.outputLines + 1} to see the rest.]`;
	}
	return `${message}\n\n${GATE_SNAPSHOT_MARKER}\n${snapshot}`;
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
	for (const message of messages) {
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
		if (!call || readPathKey(call.path, cwd) !== wanted || message.isError) continue;
		written = message.toolName === "write" && call.name === "write" ? call.content : undefined;
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
	return collectReads(messages, lastUserIndex(messages) + 1, absolutePath, cwd, pendingNestedCalls).map(
		({ text, fullFile }) => ({ text, fullFile }),
	);
}

/** Read evidence for the file from messages[start..], cleared by each later successful edit or write of it. */
function collectReads(
	messages: readonly AgentMessage[],
	start: number,
	absolutePath: string,
	cwd: string,
	pendingNestedCalls: readonly PendingNestedToolCalls[],
): IndexedRead[] {
	const wanted = readPathKey(absolutePath, cwd);
	const calls = new Map<string, ToolCallPath>();
	const parentCalls = new Set<string>();
	const completedParents = new Set<string>();
	const reads: IndexedRead[] = [];
	for (let index = start; index < messages.length; index++) {
		const message = messages[index]!;
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
			applyNestedReads(message.nestedCalls, wanted, cwd, reads, index);
		}
		const call = calls.get(message.toolCallId);
		if (message.isError) {
			const snapshot =
				call && readPathKey(call.path, cwd) === wanted ? gateSnapshotEvidence(call, message) : undefined;
			if (snapshot) reads.push({ ...snapshot, index });
			continue;
		}
		if (!call || readPathKey(call.path, cwd) !== wanted) continue;
		if (call.name === "edit" || call.name === "write") {
			reads.length = 0;
			continue;
		}
		if (call.name !== "read" || message.toolName !== "read" || !Array.isArray(message.content)) continue;
		const evidence = readResultEvidence(message.content, call.offset);
		if (!evidence.text.startsWith("[Directory listing:")) reads.push({ ...evidence, index });
	}
	for (const pending of pendingNestedCalls) {
		// The parent must still be present after compaction and within the scanned messages.
		if (!parentCalls.has(pending.parentToolCallId) || completedParents.has(pending.parentToolCallId)) continue;
		applyNestedReads(pending.calls, wanted, cwd, reads, messages.length);
	}
	return reads;
}

/** A gate refusal of edit/write that carried the current file content. */
function gateSnapshotEvidence(call: ToolCallPath, message: AgentMessage): TurnRead | undefined {
	if (call.name !== "edit" && call.name !== "write") return undefined;
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return undefined;
	const text = textOf(message.content);
	const at = text.indexOf(`\n\n${GATE_SNAPSHOT_MARKER}\n`);
	if (at < 0) return undefined;
	return readResultEvidence([{ type: "text", text: text.slice(at + GATE_SNAPSHOT_MARKER.length + 3) }], undefined);
}

export function readResultEvidence(content: readonly { type: string; text?: string }[], offset: unknown): TurnRead {
	const text = textOf(content);
	const hasImage = content.some((block) => block.type === "image");
	return {
		text,
		fullFile:
			!hasImage &&
			!text.startsWith("[Directory listing:") &&
			(typeof offset !== "number" || offset <= 1) &&
			!PARTIAL_READ.test(text),
	};
}

function applyNestedReads(
	nested: NestedToolCalls,
	wanted: string,
	cwd: string,
	reads: IndexedRead[],
	index: number,
): void {
	const completed = nested.calls
		.filter((call) => call.status === "ok")
		.sort((left, right) => (left.completionOrder ?? 0) - (right.completionOrder ?? 0));
	for (const call of completed) {
		if (call.name === "edit" || call.name === "write") {
			const path = call.fileMutationPath ?? call.arguments?.path;
			if (typeof path === "string" && readPathKey(path, cwd) === wanted) reads.length = 0;
		} else if (call.name === "read" && call.readResult) {
			if (readPathKey(call.readResult.path, cwd) !== wanted) continue;
			if (call.readResult.text.startsWith("[Directory listing:")) continue;
			reads.push({ text: call.readResult.text, fullFile: call.readResult.fullFile, index });
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

function lastUserIndex(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
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
