/** Read-only account-local search through visible text on the entire active conversation branch. */
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { buildSessionProjection, type FileEntry, type SessionEntry } from "../../core/session-manager.ts";
import { readArchiveMeta } from "./archive-meta.ts";
import type {
	SessionSearchHit,
	SessionSearchMessage,
	SessionSearchMessageRequest,
	SessionSearchMessageResult,
	SessionSearchRequest,
	SessionSearchResult,
} from "./protocol.ts";

const MAX_CACHED_DOCUMENTS = 512;
const CONCURRENT_READS = 4;
const EXCERPT_LENGTH = 200;

interface SearchMessage {
	entryId: string;
	role: "user" | "assistant";
	text: string;
	message: SessionSearchMessage;
}

interface SearchDocument {
	sessionId: string;
	cwd: string;
	title: string;
	scope: "chat" | "research";
	modified: string;
	messages: SearchMessage[];
}

interface CachedDocument {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	pending: Promise<SearchDocument | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function isInside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function normalizedCwd(cwd: string): string {
	const path = resolve(cwd);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

async function readDocument(path: string, modified: string): Promise<SearchDocument | null> {
	const entries: FileEntry[] = [];
	const ids = new Set<string>();
	let header: Record<string, unknown> | undefined;
	let scope: "chat" | "research" = "chat";
	let title = "";
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(value)) continue;
			if (!header) {
				if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string") return null;
				header = value;
				entries.push(value as unknown as FileEntry);
				continue;
			}
			if (
				typeof value.id !== "string" ||
				!value.id ||
				ids.has(value.id) ||
				(value.parentId !== null && (typeof value.parentId !== "string" || !ids.has(value.parentId)))
			) {
				// Broken trees cannot safely yield a location in the visible branch.
				return null;
			}
			ids.add(value.id);
			const base = {
				id: value.id,
				parentId: value.parentId as string | null,
				timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
			};
			let entry: SessionEntry = { ...base, type: "custom", customType: "search-state" };
			if (value.type === "message" && isRecord(value.message) && typeof value.message.role === "string") {
				entry = { ...value, ...base } as unknown as SessionEntry;
			} else if (value.type === "context_edit") {
				if (
					typeof value.targetId === "string" &&
					(value.replacement === null ||
						(isRecord(value.replacement) &&
							(typeof value.replacement.content === "string" || Array.isArray(value.replacement.content))))
				) {
					entry = { ...value, ...base } as unknown as SessionEntry;
				}
			} else if (value.type === "session_info") {
				title = typeof value.name === "string" ? value.name.trim() : "";
			} else if (value.type === "custom" && value.customType === "owl-research-mode") {
				scope = "research";
			}
			entries.push(entry);
		}
	} finally {
		lines.close();
		input.destroy();
	}
	if (!header) return null;
	const messages: SearchMessage[] = [];
	// Compaction entries remain state-only nodes here, so the canonical branch walk
	// and context edits also cover older text that is no longer sent to the model.
	for (const projected of buildSessionProjection(entries.slice(1) as SessionEntry[]).entries) {
		for (const message of projected.messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = textContent(message.content);
			if (text) {
				const timestamp =
					typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
						? message.timestamp
						: Date.parse(projected.sourceEntry.timestamp) || 0;
				messages.push({
					entryId: projected.sourceEntry.id,
					role: message.role,
					text,
					message: {
						role: message.role,
						content:
							message.role === "user" && typeof message.content === "string" ? text : [{ type: "text", text }],
						timestamp,
					},
				});
			}
		}
	}
	return {
		sessionId: header.id as string,
		cwd: header.cwd as string,
		title: (title || messages.find((message) => message.role === "user")?.text || "")
			.replace(/\s+/g, " ")
			.slice(0, 160),
		scope,
		modified,
		messages,
	};
}

/** One service per bridge/account. No runtime is mounted and history files are never repaired or migrated. */
export class DesktopSessionSearch {
	private readonly agentDir: string;
	private readonly cache = new Map<string, CachedDocument>();

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	async search(request: Omit<SessionSearchRequest, "type" | "id">): Promise<SessionSearchResult> {
		if (typeof request.query !== "string" || request.query.length > 1000) throw new Error("搜索关键词无效或过长");
		if (request.cwd !== undefined && (typeof request.cwd !== "string" || !request.cwd.trim())) {
			throw new Error("搜索项目路径不能为空");
		}
		if (request.scope !== undefined && request.scope !== "chat" && request.scope !== "research") {
			throw new Error("无效的会话目录类型");
		}
		if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") {
			throw new Error("无效的归档搜索选项");
		}
		if (
			request.limit !== undefined &&
			(!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200)
		) {
			throw new Error("搜索结果数量必须在 1 到 200 之间");
		}
		const query = request.query.trim();
		if (!query) return { hits: [], hasMore: false };
		// Escape the entire query: errors, paths and punctuation are literal text.
		const needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
		const limit = request.limit ?? 50;
		const documents = await this.documents();
		const archived = readArchiveMeta(this.agentDir).sessions ?? {};
		const cwd = request.cwd === undefined ? undefined : normalizedCwd(request.cwd);
		const hits: SessionSearchHit[] = [];
		documents.sort((a, b) => b.modified.localeCompare(a.modified) || a.sessionId.localeCompare(b.sessionId));
		for (const document of documents) {
			if (cwd !== undefined && normalizedCwd(document.cwd) !== cwd) continue;
			if (request.scope !== undefined && document.scope !== request.scope) continue;
			const isArchived = Object.hasOwn(archived, document.sessionId);
			if (isArchived && !request.includeArchived) continue;
			for (const message of document.messages) {
				needle.lastIndex = 0;
				const match = needle.exec(message.text);
				if (!match) continue;
				if (hits.length === limit) return { hits, hasMore: true };
				const start = Math.max(0, match.index - 70);
				const end = Math.min(message.text.length, Math.max(start + EXCERPT_LENGTH, match.index + match[0].length));
				const excerpt = `${start > 0 ? "…" : ""}${message.text.slice(start, end)}${end < message.text.length ? "…" : ""}`;
				const matchRanges: { start: number; end: number }[] = [];
				needle.lastIndex = 0;
				for (let found = needle.exec(excerpt); found; found = needle.exec(excerpt)) {
					matchRanges.push({ start: found.index, end: found.index + found[0].length });
				}
				hits.push({
					sessionId: document.sessionId,
					cwd: document.cwd,
					title: document.title,
					scope: document.scope,
					archived: isArchived,
					modified: document.modified,
					entryId: message.entryId,
					role: message.role,
					excerpt,
					matchRanges,
				});
			}
		}
		return { hits, hasMore: false };
	}

	async readMessage(
		request: Pick<SessionSearchMessageRequest, "sessionId" | "entryId">,
	): Promise<SessionSearchMessageResult> {
		if (
			typeof request.sessionId !== "string" ||
			!request.sessionId ||
			typeof request.entryId !== "string" ||
			!request.entryId
		) {
			throw new Error("会话或消息标识无效");
		}
		// Re-scan/stat the account inventory for every read. A hit may have become
		// stale because its session was deleted, rewound, or edited after search.
		const documents = await this.documents();
		const document = documents.find((candidate) => candidate.sessionId === request.sessionId);
		const entry = document?.messages.find((candidate) => candidate.entryId === request.entryId);
		if (!entry) throw new Error("该消息已不存在于当前会话分支");
		return { entryId: entry.entryId, message: structuredClone(entry.message) };
	}

	private async documents(): Promise<SearchDocument[]> {
		const history = join(this.agentDir, "Owl-history");
		let root: string;
		let files: string[];
		try {
			root = await realpath(history);
			const directories = await readdir(history, { withFileTypes: true });
			files = directories
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => join(history, entry.name));
			for (const directory of directories) {
				if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
				const path = join(history, directory.name);
				try {
					if (!isInside(root, await realpath(path))) continue;
					for (const file of await readdir(path, { withFileTypes: true })) {
						if (file.isFile() && !file.isSymbolicLink() && file.name.endsWith(".jsonl"))
							files.push(join(path, file.name));
					}
				} catch {
					// A removed/unreadable project must not hide the rest of history.
				}
			}
		} catch {
			this.cache.clear();
			return [];
		}
		const live = new Set(files);
		for (const path of this.cache.keys()) if (!live.has(path)) this.cache.delete(path);
		const documents: SearchDocument[] = [];
		let next = 0;
		await Promise.all(
			Array.from({ length: CONCURRENT_READS }, async () => {
				while (next < files.length) {
					const path = files[next++]!;
					try {
						if (!isInside(root, await realpath(path))) continue;
						const info = await stat(path);
						let cached = this.cache.get(path);
						if (
							!cached ||
							cached.mtimeMs !== info.mtimeMs ||
							cached.ctimeMs !== info.ctimeMs ||
							cached.size !== info.size
						) {
							cached = {
								mtimeMs: info.mtimeMs,
								ctimeMs: info.ctimeMs,
								size: info.size,
								pending: readDocument(path, info.mtime.toISOString()).catch(() => null),
							};
							this.cache.set(path, cached);
						}
						const document = await cached.pending;
						if (document) documents.push(document);
					} catch {
						this.cache.delete(path);
					}
				}
			}),
		);
		while (this.cache.size > MAX_CACHED_DOCUMENTS) this.cache.delete(this.cache.keys().next().value!);
		return documents;
	}
}
