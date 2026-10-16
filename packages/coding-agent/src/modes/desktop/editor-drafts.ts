/** Durable per-profile drafts. Tombstones protect create/delete races across windows. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFileSync, withFileLockSync } from "../../utils/atomic-file.ts";
import {
	canonicalEditorWorkspace,
	editorPathKey,
	editorRevisionMatchesContent,
	validEditorText,
} from "./editor-files.ts";
import type {
	EditorDraft,
	EditorDraftGetResult,
	EditorDraftListResult,
	EditorDraftPutRequest,
	EditorDraftPutResult,
	EditorDraftRemoveResult,
} from "./protocol.ts";

interface DraftSlot {
	version: 1;
	cwd: string;
	path: string;
	revision: string;
	draft: EditorDraft | null;
	lastOperation?: { id: string; hash: string };
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export class EditorDraftStore {
	private readonly profileRoot: string;
	private readonly directory: string;
	private readonly assertProfile: () => void;

	constructor(agentDir: string, assertProfile: () => void) {
		this.profileRoot = canonicalEditorWorkspace(agentDir);
		this.directory = join(this.profileRoot, "editor-drafts");
		this.assertProfile = assertProfile;
	}

	private assertStoragePath(target: string): void {
		this.assertProfile();
		const child = relative(this.profileRoot, resolve(target));
		if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
			throw new Error("草稿存储路径越出账号目录");
		let cursor = this.profileRoot;
		for (const segment of ["", ...child.split(sep)]) {
			if (segment) cursor = join(cursor, segment);
			try {
				const info = lstatSync(cursor);
				if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))
					throw new Error("草稿存储含链接，已拒绝跨账号读取或写入");
				const actual = realpathSync(cursor);
				const within = relative(this.profileRoot, actual);
				if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
					throw new Error("草稿存储路径越出账号目录");
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") break;
				throw error;
			}
		}
	}

	private identity(cwd: string, path: string): { cwd: string; path: string; file: string } {
		if (
			!path ||
			isAbsolute(path) ||
			/^[a-zA-Z]:/.test(path) ||
			path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
		)
			throw new Error("草稿路径必须是工作区相对文件路径");
		const workspace = canonicalEditorWorkspace(cwd);
		const normalized = relative(workspace, resolve(workspace, path)).split(sep).join("/");
		return {
			cwd: workspace,
			path: normalized,
			file: join(
				this.directory,
				hash(editorPathKey(workspace)),
				`${hash(process.platform === "win32" ? normalized.toLowerCase() : normalized)}.json`,
			),
		};
	}

	private read(file: string): DraftSlot | undefined {
		this.assertStoragePath(file);
		if (!existsSync(file)) return undefined;
		const body = readFileSync(file, "utf8");
		this.assertStoragePath(file);
		const slot = JSON.parse(body) as DraftSlot;
		if (
			slot.version !== 1 ||
			typeof slot.revision !== "string" ||
			typeof slot.cwd !== "string" ||
			typeof slot.path !== "string" ||
			(slot.draft !== null &&
				(!slot.draft ||
					!validEditorText(slot.draft.content) ||
					!editorRevisionMatchesContent(slot.draft.baseRevision, slot.draft.baseContent) ||
					slot.draft.draftRevision !== slot.revision))
		) {
			throw new Error(`草稿记录无法核对，已保留原文件：${file}`);
		}
		return slot;
	}

	get(cwd: string, path: string): EditorDraftGetResult {
		this.assertProfile();
		const identity = this.identity(cwd, path);
		const slot = this.read(identity.file);
		this.assertProfile();
		return { draft: slot?.draft ? structuredClone(slot.draft) : null, draftRevision: slot?.revision ?? null };
	}

	put(request: Omit<EditorDraftPutRequest, "type" | "id" | "expectedProfile">): EditorDraftPutResult {
		this.assertProfile();
		if (!validEditorText(request.content) || !editorRevisionMatchesContent(request.baseRevision, request.baseContent))
			throw new Error("草稿必须包含完整 UTF-8 正文及与读取版本匹配的完整基线");
		if (request.expectedDraftRevision !== null && typeof request.expectedDraftRevision !== "string")
			throw new Error("草稿写入缺少已读取的草稿版本");
		if (!/^[a-zA-Z0-9_-]{1,200}$/.test(request.operationId)) throw new Error("无效的草稿写入标识");
		const identity = this.identity(request.cwd, request.path);
		this.assertStoragePath(identity.file);
		this.assertStoragePath(`${identity.file}.lock`);
		const payloadHash = hash(
			JSON.stringify([request.content, request.baseRevision, request.baseContent, request.editorId]),
		);
		return withFileLockSync(identity.file, () => {
			this.assertProfile();
			const slot = this.read(identity.file);
			const current = { draft: slot?.draft ?? null, draftRevision: slot?.revision ?? null };
			if (slot?.lastOperation?.id === request.operationId) {
				if (slot.draft && slot.lastOperation.hash === payloadHash)
					return { status: "saved", draft: structuredClone(slot.draft), draftRevision: slot.revision };
				return { status: "conflict", ...current, reason: "这次写入已处理或草稿已移除，请核对最新草稿" };
			}
			if (request.expectedDraftRevision !== current.draftRevision)
				return { status: "conflict", ...current, reason: "另一个窗口已更新或移除草稿，未覆盖其内容" };
			if (request.baseRevision === null && !slot?.draft && existsSync(resolve(identity.cwd, identity.path)))
				throw new Error("该路径已有文件，必须先读取完整可编辑基线；未保存截断预览");
			const revision = randomUUID();
			const draft: EditorDraft = {
				cwd: identity.cwd,
				path: identity.path,
				content: request.content,
				baseRevision: request.baseRevision,
				baseContent: request.baseContent,
				updatedAt: Date.now(),
				draftRevision: revision,
				operationId: request.operationId,
				...(request.editorId ? { editorId: request.editorId } : {}),
			};
			this.assertProfile();
			this.assertStoragePath(identity.file);
			atomicWriteFileSync(
				identity.file,
				JSON.stringify({
					version: 1,
					cwd: identity.cwd,
					path: identity.path,
					revision,
					draft,
					lastOperation: { id: request.operationId, hash: payloadHash },
				} satisfies DraftSlot),
				{ mode: 0o600 },
			);
			return { status: "saved", draft, draftRevision: revision };
		});
	}

	remove(cwd: string, path: string, expectedDraftRevision: string): EditorDraftRemoveResult {
		this.assertProfile();
		if (!expectedDraftRevision || typeof expectedDraftRevision !== "string")
			throw new Error("移除草稿必须携带精确草稿版本");
		const identity = this.identity(cwd, path);
		this.assertStoragePath(identity.file);
		this.assertStoragePath(`${identity.file}.lock`);
		return withFileLockSync(identity.file, () => {
			this.assertProfile();
			const slot = this.read(identity.file);
			if (!slot || slot.revision !== expectedDraftRevision)
				return {
					status: "conflict",
					draft: slot?.draft ?? null,
					draftRevision: slot?.revision ?? null,
					reason: "草稿已变化，未移除其他窗口的新内容",
				};
			const revision = randomUUID();
			this.assertStoragePath(identity.file);
			atomicWriteFileSync(identity.file, JSON.stringify({ ...slot, revision, draft: null } satisfies DraftSlot), {
				mode: 0o600,
			});
			return { status: "removed", draft: null, draftRevision: revision };
		});
	}

	list(cwd?: string): EditorDraftListResult {
		this.assertProfile();
		this.assertStoragePath(this.directory);
		const result: EditorDraftListResult = { drafts: [] };
		if (!existsSync(this.directory)) return result;
		const scope = cwd === undefined ? undefined : editorPathKey(canonicalEditorWorkspace(cwd));
		for (const workspace of readdirSync(this.directory, { withFileTypes: true })) {
			this.assertStoragePath(join(this.directory, workspace.name));
			if (!workspace.isDirectory()) continue;
			for (const name of readdirSync(join(this.directory, workspace.name))) {
				if (!name.endsWith(".json")) continue;
				const slot = this.read(join(this.directory, workspace.name, name));
				if (!slot?.draft || (scope !== undefined && editorPathKey(slot.cwd) !== scope)) continue;
				const draft = slot.draft;
				result.drafts.push({
					cwd: draft.cwd,
					path: draft.path,
					updatedAt: draft.updatedAt,
					draftRevision: draft.draftRevision,
					baseRevision: draft.baseRevision,
					size: Buffer.byteLength(draft.content, "utf8"),
					...(draft.editorId ? { editorId: draft.editorId } : {}),
				});
			}
		}
		this.assertProfile();
		result.drafts.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
		return result;
	}
}
