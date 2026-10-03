import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { isWorkspaceViewerUrl } from "./workspace-viewer-url.ts";

export interface WorkspaceViewerInfo {
	id: string;
	title: string;
	extensions: readonly string[];
}

export interface WorkspaceViewerOpenRequest {
	cwd: string;
	/** Workspace-relative file path. */
	path: string;
	signal?: AbortSignal;
}

export interface WorkspaceViewerOpenResult {
	url: string;
	title?: string;
}

export interface WorkspaceViewerDefinition extends WorkspaceViewerInfo {
	open(request: WorkspaceViewerOpenRequest): Promise<WorkspaceViewerOpenResult>;
}

const viewers = new Map<string, WorkspaceViewerDefinition>();
const listeners = new Set<(viewers: WorkspaceViewerInfo[]) => void>();

/** Serializable discovery metadata; callbacks stay in the bridge process. */
export function listWorkspaceViewers(): WorkspaceViewerInfo[] {
	return [...viewers.values()].map(({ id, title, extensions }) => ({ id, title, extensions: [...extensions] }));
}

export function getWorkspaceViewer(id: string): WorkspaceViewerDefinition | undefined {
	return viewers.get(id);
}

export function subscribeWorkspaceViewers(listener: (viewers: WorkspaceViewerInfo[]) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Register a plugin-owned viewer. An old disposer cannot unregister its replacement. */
export function registerWorkspaceViewer(definition: WorkspaceViewerDefinition): () => void {
	if (
		!/^[a-z][a-z0-9._-]*$/.test(definition.id) ||
		!definition.title.trim() ||
		typeof definition.open !== "function"
	) {
		throw new Error("Invalid workspace viewer definition");
	}
	if (
		definition.extensions.length === 0 ||
		definition.extensions.some((extension) => !/^[a-z0-9][a-z0-9_-]*$/i.test(extension))
	) {
		throw new Error("Workspace viewers require plain file extensions without dots");
	}
	const registered: WorkspaceViewerDefinition = Object.freeze({
		...definition,
		extensions: Object.freeze([...new Set(definition.extensions.map((extension) => extension.toLowerCase()))]),
	});
	viewers.set(registered.id, registered);
	for (const listener of listeners) listener(listWorkspaceViewers());
	return () => {
		if (viewers.get(registered.id) !== registered) return;
		viewers.delete(registered.id);
		for (const listener of listeners) listener(listWorkspaceViewers());
	};
}

/** Resolve and fence the file before handing it to any plugin. */
export async function openWorkspaceViewer(
	id: string,
	request: WorkspaceViewerOpenRequest,
): Promise<WorkspaceViewerOpenResult> {
	const viewer = viewers.get(id);
	if (!viewer) throw new Error(`Workspace viewer is unavailable: ${id}`);
	request.signal?.throwIfAborted();
	if (
		!isAbsolute(request.cwd) ||
		!request.path ||
		/[\x00-\x1f\x7f]/.test(request.path) ||
		isAbsolute(request.path) ||
		/^[a-z]:/i.test(request.path) ||
		request.path.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("Viewer paths must be relative files inside the workspace");
	}
	if (!viewer.extensions.includes(extname(request.path).slice(1).toLowerCase())) {
		throw new Error(`Workspace viewer does not support this file: ${request.path}`);
	}
	const cwd = await realpath(request.cwd);
	const file = await realpath(resolve(cwd, request.path));
	const path = relative(cwd, file);
	if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
		throw new Error("Viewer file is outside the workspace");
	}
	if (!(await stat(file)).isFile()) throw new Error("Viewer target must be a file");
	request.signal?.throwIfAborted();
	const result = await viewer.open({ ...request, cwd, path: path.split(sep).join("/") });
	request.signal?.throwIfAborted();
	if (!isWorkspaceViewerUrl(result.url)) throw new Error("Workspace viewer returned an invalid local HTTP URL");
	if (viewers.get(id) !== viewer) throw new Error(`Workspace viewer was unloaded: ${id}`);
	return result;
}
