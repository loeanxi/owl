import { basename, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { splitBom } from "../../utils/text.ts";
import type { PendingNestedToolCalls } from "../nested-tool-calls.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { applyEditsToNormalizedContent, normalizeToLF } from "./edit-diff.ts";
import { pathCorrectionNote, resolveReadPath } from "./path-utils.ts";
import { formatSize, truncateHead } from "./truncate.ts";

/**
 * `write` may overwrite an existing file only after the whole current content
 * was seen. `edit` is not gated: its oldText must match the current file, which
 * already keeps it from changing text the model never saw.
 *
 * A full `read` in the current user turn counts until a `write` of that file; a
 * successful `edit` carries it forward by applying the same replacements. The
 * session's own complete write counts while it, with later own edits applied,
 * still equals the file. Shell output (`cat`) that contains the whole current
 * file counts in any turn. A read from an earlier user turn counts only while
 * its text still matches the bytes on disk, so a `继续` does not force a
 * re-read of an unchanged file, but an external change does. A read dropped by
 * compaction is gone. Creating a new file with `write` is not gated.
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

interface PlacedRead extends TurnRead {
	/** 1-based file line where a `read` result (or gate snapshot) starts; undefined for other evidence. */
	startLine?: number;
}

interface IndexedRead extends PlacedRead {
	/** Position of the evidence in the projected messages; pending nested reads use messages.length. */
	index: number;
	/**
	 * Evidence that is not a `read` result. `shell`: output of a command naming the file.
	 * `write`: content of this session's own complete write, usable only while it equals the file.
	 */
	source?: "shell" | "write";
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
	const current = currentBytes ? currentFileText(currentBytes) : undefined;
	if (current !== undefined && readsCoverFile(reads, current)) return;
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

/**
 * Reads of the current turn, plus earlier-turn reads whose text still matches the file on disk.
 * Shell output that contains the whole current file counts as a full read in any turn; other
 * shell output only in the current turn. Own-write content counts only while it equals the file.
 */
function usableReads(
	messages: readonly AgentMessage[],
	absolutePath: string,
	cwd: string,
	pendingNestedCalls: readonly PendingNestedToolCalls[],
	currentBytes: Buffer | undefined,
): PlacedRead[] {
	const turnStart = lastUserIndex(messages) + 1;
	const current = currentBytes ? currentFileText(currentBytes) : undefined;
	return collectReads(messages, 0, absolutePath, cwd, pendingNestedCalls).flatMap((read): PlacedRead[] => {
		if (read.source === "write") {
			return current !== undefined && normalizeToLF(read.text) === current
				? [{ text: current, fullFile: true }]
				: [];
		}
		if (read.source === "shell") {
			const whole =
				current !== undefined && current.trim() !== "" && normalizeToLF(read.text).includes(current.trimEnd());
			if (whole) return [{ text: current, fullFile: true }];
			return read.index >= turnStart ? [{ text: read.text, fullFile: false }] : [];
		}
		// Another session can change a file within this same user turn. Whenever the
		// writer has current bytes, verify them instead of treating recent reads as fresh.
		if (current !== undefined ? readMatchesContent(read, current) : read.index >= turnStart) {
			return [{ text: read.text, fullFile: read.fullFile, startLine: read.startLine }];
		}
		return [];
	});
}

/**
 * Partial reads taken with offsets (e.g. lines 1-100, then offset=101 to the end) together count
 * as a full read when each one still equals the current file at its own lines and every line is covered.
 */
function readsCoverFile(reads: readonly PlacedRead[], current: string): boolean {
	const lines = current.split("\n");
	const covered = new Array<boolean>(lines.length).fill(false);
	for (const read of reads) {
		if (read.startLine === undefined || OVERSIZED_LINE_NOTICE.test(read.text)) continue;
		// A segment of a CRLF file ends in the bare "\r" of its last line.
		let body = normalizeToLF(read.text.replace(READ_NOTICE_SUFFIX, "").replace(/\r$/, ""));
		if (read.startLine === 1) body = splitBom(body).text;
		const start = read.startLine - 1;
		const bodyLines = body.split("\n");
		if (start + bodyLines.length > lines.length) continue;
		if (lines.slice(start, start + bodyLines.length).join("\n") !== body) continue;
		covered.fill(true, start, start + bodyLines.length);
	}
	return covered.every(Boolean);
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
	return collectReads(messages, lastUserIndex(messages) + 1, absolutePath, cwd, pendingNestedCalls)
		.filter((read) => read.source !== "write")
		.map(({ text, fullFile }) => ({ text, fullFile }));
}

/**
 * Read evidence for the file from messages[start..]. A later successful write of it replaces the
 * evidence with the written content; a later successful edit rewrites it with the same replacements.
 */
function collectReads(
	messages: readonly AgentMessage[],
	start: number,
	absolutePath: string,
	cwd: string,
	pendingNestedCalls: readonly PendingNestedToolCalls[],
): IndexedRead[] {
	const wanted = readPathKey(absolutePath, cwd);
	const calls = new Map<string, ToolCallPath>();
	const shellCommands = new Map<string, string>();
	const parentCalls = new Set<string>();
	const completedParents = new Set<string>();
	const reads: IndexedRead[] = [];
	for (let index = start; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				parentCalls.add(block.id);
				if (SHELL_TOOLS.has(block.name) && typeof block.arguments.command === "string") {
					shellCommands.set(block.id, block.arguments.command);
					continue;
				}
				if (block.name !== "read" && block.name !== "edit" && block.name !== "write") continue;
				const path = block.arguments.path;
				if (typeof path !== "string") continue;
				const content = block.arguments.content;
				calls.set(block.id, {
					name: block.name,
					path,
					offset: typeof block.arguments.offset === "number" ? block.arguments.offset : undefined,
					edits: block.name === "edit" ? editPairs(block.arguments) : undefined,
					content: block.name === "write" && typeof content === "string" ? content : undefined,
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
		const command = shellCommands.get(message.toolCallId);
		if (command !== undefined) {
			// A failing exit still printed what the command showed of the file.
			if (Array.isArray(message.content) && commandNamesFile(command, absolutePath)) {
				const text = textOf(message.content);
				if (text) reads.push({ text, fullFile: false, index, source: "shell" });
			}
			continue;
		}
		const call = calls.get(message.toolCallId);
		if (message.isError) {
			const snapshot =
				call && readPathKey(call.path, cwd) === wanted ? gateSnapshotEvidence(call, message) : undefined;
			if (snapshot) reads.push({ ...snapshot, index });
			continue;
		}
		if (!call) continue;
		const actualPath =
			call.name === "read" && message.toolName === "read" ? readResultPath(call.path, message.details) : call.path;
		if (readPathKey(actualPath, cwd) !== wanted) continue;
		if (call.name === "edit" && call.edits) {
			const rebased = reads.flatMap((read) => rebaseRead(read, call.edits!) ?? []);
			reads.length = 0;
			reads.push(...rebased);
			for (const { newText } of call.edits) {
				if (newText) reads.push({ text: newText, fullFile: false, index });
			}
			continue;
		}
		if (call.name === "edit" || call.name === "write") {
			reads.length = 0;
			if (call.name === "write" && message.toolName === "write" && call.content !== undefined) {
				reads.push({ text: call.content, fullFile: true, index, source: "write" });
			}
			continue;
		}
		if (call.name !== "read" || message.toolName !== "read" || !Array.isArray(message.content)) continue;
		const evidence = readResultEvidence(message.content, call.offset, message.details);
		if (!evidence.text.startsWith("[Directory listing:")) {
			reads.push({ ...evidence, index, startLine: Math.max(1, call.offset ?? 1) });
		}
	}
	for (const pending of pendingNestedCalls) {
		// The parent must still be present after compaction and within the scanned messages.
		if (!parentCalls.has(pending.parentToolCallId) || completedParents.has(pending.parentToolCallId)) continue;
		applyNestedReads(pending.calls, wanted, cwd, reads, messages.length);
	}
	return reads;
}

/** A gate refusal of edit/write that carried the current file content. */
function gateSnapshotEvidence(call: ToolCallPath, message: AgentMessage): PlacedRead | undefined {
	if (call.name !== "edit" && call.name !== "write") return undefined;
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return undefined;
	const text = textOf(message.content);
	const at = text.indexOf(`\n\n${GATE_SNAPSHOT_MARKER}\n`);
	if (at < 0) return undefined;
	const snapshot = text.slice(at + GATE_SNAPSHOT_MARKER.length + 3);
	return { ...readResultEvidence([{ type: "text", text: snapshot }], undefined), startLine: 1 };
}

function readPathCorrection(details: unknown): { requestedPath: string; resolvedPath: string } | undefined {
	if (!details || typeof details !== "object" || !("pathCorrection" in details)) return undefined;
	const value = details.pathCorrection;
	if (!value || typeof value !== "object" || !("requestedPath" in value) || !("resolvedPath" in value))
		return undefined;
	return typeof value.requestedPath === "string" && typeof value.resolvedPath === "string"
		? { requestedPath: value.requestedPath, resolvedPath: value.resolvedPath }
		: undefined;
}

/** Only tool-produced metadata can change the read identity; file contents cannot redirect evidence. */
export function readResultPath(requestedPath: string, details: unknown): string {
	return readPathCorrection(details)?.resolvedPath ?? requestedPath;
}

export function readResultEvidence(
	content: readonly { type: string; text?: string }[],
	offset: unknown,
	details?: unknown,
): TurnRead {
	let text = textOf(content);
	const correction = readPathCorrection(details);
	if (correction) {
		const prefix = `${pathCorrectionNote(correction.requestedPath, correction.resolvedPath)}\n`;
		if (text.startsWith(prefix)) text = text.slice(prefix.length);
	}
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
	/** Replacements of an edit call; undefined when the arguments cannot be read back. */
	edits?: EditPair[];
	/** Content of a write call. */
	content?: string;
}

interface EditPair {
	oldText: string;
	newText: string;
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** The replacements an edit call made, in any argument shape the edit tool accepts. */
function editPairs(args: Record<string, unknown>): EditPair[] | undefined {
	let edits: unknown = args.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			return undefined;
		}
	}
	const items: unknown[] = Array.isArray(edits) ? [...edits] : edits === undefined ? [] : [edits];
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		items.push({ oldText: args.oldText, newText: args.newText });
	}
	if (items.length === 0) return undefined;
	const pairs: EditPair[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null) return undefined;
		const { oldText, newText } = item as Record<string, unknown>;
		if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
		pairs.push({ oldText, newText });
	}
	return pairs;
}

/**
 * The read as it looks after the edit. A partial read that does not contain an edited region
 * stays as it was; a whole-file read that misses one was already stale and is dropped.
 */
function rebaseRead(read: IndexedRead, edits: readonly EditPair[]): IndexedRead | undefined {
	const text = normalizeToLF(read.text);
	const applied = applyEdits(text, edits);
	if (applied !== undefined) return { ...read, text: applied };
	if (read.fullFile) return undefined;
	let partial = text;
	for (const edit of edits) partial = applyEdits(partial, [edit]) ?? partial;
	return { ...read, text: partial };
}

function applyEdits(text: string, edits: readonly EditPair[]): string | undefined {
	try {
		return applyEditsToNormalizedContent(text, [...edits], "read").newContent;
	} catch {
		return undefined;
	}
}

function commandNamesFile(command: string, absolutePath: string): boolean {
	const name = basename(absolutePath);
	if (!name) return false;
	return process.platform === "win32" ? command.toLowerCase().includes(name.toLowerCase()) : command.includes(name);
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
