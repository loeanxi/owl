import type { ChatEntry, ToolCard } from "./transcript.ts";

export type ArtifactKind = "document" | "sheet" | "presentation" | "image" | "code" | "file";

export interface FileArtifact {
	/** Workspace-relative POSIX path, suitable for the sidebar file API. */
	path: string;
	title: string;
	kind: ArtifactKind;
	action: "written" | "edited" | "opened";
	toolId: string;
}

export interface ArtifactOptions {
	scope?: "turn" | "session";
	/** Source changes are normally reviewed in the development workbench. */
	includeCode?: boolean;
}

interface AbsolutePath {
	root: string;
	segments: string[];
	windows: boolean;
}

function pathSegments(path: string): string[] | undefined {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
		} else segments.push(segment);
	}
	return segments;
}

function absolutePath(path: string): AbsolutePath | undefined {
	const drive = path.match(/^([a-z]):\//i);
	if (drive) {
		const segments = pathSegments(path.slice(3));
		return segments ? { root: drive[1].toLowerCase(), segments, windows: true } : undefined;
	}
	if (path.startsWith("//")) {
		const unc = path.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);
		if (!unc || unc[1] === "?" || unc[1] === ".") return undefined;
		const segments = pathSegments(path.slice(unc[0].length));
		return segments ? { root: `//${unc[1]}/${unc[2]}`.toLowerCase(), segments, windows: true } : undefined;
	}
	if (!path.startsWith("/")) return undefined;
	const segments = pathSegments(path.slice(1));
	return segments ? { root: "/", segments, windows: false } : undefined;
}

/**
 * Resolve a tool path lexically before sending it to the sidebar. The server also
 * checks real paths, so symlinks cannot make a preview escape the workspace.
 * Home-relative and drive-relative paths are omitted: the UI cannot resolve them.
 */
export function workspaceArtifactPath(input: string, cwd: string, options: { encoded?: boolean } = {}): string | undefined {
	let path = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (!path || /[\x00-\x1f\x7f]/.test(path) || /^~(?:[\\/]|$)/.test(path)) return undefined;
	if (path.startsWith("file://")) {
		try {
			const url = new URL(path);
			if (url.search || url.hash || url.username || url.password) return undefined;
			path = decodeURIComponent(url.pathname);
			if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
			else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
		} catch {
			return undefined;
		}
	} else if (options.encoded) {
		try {
			path = decodeURIComponent(path);
		} catch {
			return undefined;
		}
	}
	path = path.replace(/\\/g, "/");
	const base = absolutePath(cwd.replace(/\\/g, "/"));
	if (!base || path.endsWith("/") || /[\x00-\x1f\x7f]/.test(path)) return undefined;
	if (base.windows) {
		if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
		// Match the Windows tool resolver's Git Bash/MSYS/WSL drive support.
		const shellDrive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (shellDrive) path = `${shellDrive[1]}:/${shellDrive[2] ?? ""}`;
	}
	const target = absolutePath(path);
	let segments: string[] | undefined;
	if (target) {
		if (target.root !== base.root || target.windows !== base.windows) return undefined;
		const comparable = (value: string): string => base.windows ? value.toLowerCase() : value;
		if (!base.segments.every((segment, index) => comparable(segment) === comparable(target.segments[index] ?? ""))) {
			return undefined;
		}
		segments = target.segments.slice(base.segments.length);
	} else {
		if (path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
		segments = pathSegments(path);
	}
	if (!segments || segments.length === 0 || (base.windows && segments.some((segment) => segment.includes(":")))) {
		return undefined;
	}
	return segments.join("/");
}

const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "txt", "pdf", "doc", "docx", "odt", "rtf", "tex", "html", "htm"]);
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods"]);
const PRESENTATION_EXTENSIONS = new Set(["ppt", "pptx", "odp"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const CODE_EXTENSIONS = new Set([
	"js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "yaml", "yml", "toml", "xml",
	"css", "scss", "sass", "less", "vue", "svelte", "py", "go", "rs", "java", "kt", "kts", "c", "cpp", "cc",
	"h", "hpp", "cs", "swift", "rb", "php", "sql", "sh", "bash", "zsh", "bat", "cmd", "ps1", "ini", "conf",
]);

export function artifactKindForPath(path: string): ArtifactKind {
	const name = path.split("/").at(-1) ?? path;
	const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
	if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
	if (SHEET_EXTENSIONS.has(extension)) return "sheet";
	if (PRESENTATION_EXTENSIONS.has(extension)) return "presentation";
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	if (CODE_EXTENSIONS.has(extension) || name.startsWith(".") || /^(dockerfile|makefile)$/i.test(name)) return "code";
	return "file";
}

function artifactOf(tool: ToolCard, cwd: string): FileArtifact | undefined {
	if (tool.status !== "ok" || !["write", "edit", "sidebar_open"].includes(tool.name)) return undefined;
	let args: unknown;
	try {
		args = JSON.parse(tool.args);
	} catch {
		return undefined;
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const input = (args as Record<string, unknown>).path;
	if (typeof input !== "string") return undefined;
	const path = workspaceArtifactPath(input, cwd);
	if (!path) return undefined;
	if (tool.name === "sidebar_open") {
		// This tool returns ordinary text even on failure; require its exact success shape.
		const opened = tool.output?.text.match(/^已在侧边栏打开 ([^\r\n]+)。$/)?.[1];
		const reportedPath = opened === undefined ? undefined : workspaceArtifactPath(opened, cwd);
		const windows = absolutePath(cwd.replace(/\\/g, "/"))?.windows;
		if (!reportedPath || (windows ? reportedPath.toLowerCase() !== path.toLowerCase() : reportedPath !== path)) return undefined;
	}
	return {
		path,
		title: path.split("/").at(-1)!,
		kind: artifactKindForPath(path),
		action: tool.name === "write" ? "written" : tool.name === "edit" ? "edited" : "opened",
		toolId: tool.id,
	};
}

/** Successful file tools are evidence; assistant prose and shell output are not. */
export function collectArtifacts(entries: readonly ChatEntry[], cwd: string, options: ArtifactOptions = {}): FileArtifact[] {
	const start = options.scope === "session" ? 0 : Math.max(0, entries.findLastIndex((entry) => entry.kind === "user"));
	const windows = absolutePath(cwd.replace(/\\/g, "/"))?.windows;
	const artifacts = new Map<string, FileArtifact>();
	for (const entry of entries.slice(start)) {
		if (entry.kind !== "assistant") continue;
		for (const tool of entry.tools) {
			if (tool.status !== "ok") continue;
			const produced: FileArtifact[] = [];
			for (const output of tool.output?.artifacts ?? []) {
				const path = workspaceArtifactPath(output.path, cwd);
				if (!path) continue;
				produced.push({ path, title: path.split("/").at(-1)!, kind: artifactKindForPath(path), action: output.action, toolId: tool.id });
			}
			const ordinary = artifactOf(tool, cwd);
			if (ordinary) produced.push(ordinary);
			for (const artifact of produced) {
				if (!options.includeCode && artifact.kind === "code") continue;
				const key = windows ? artifact.path.toLowerCase() : artifact.path;
				artifacts.delete(key);
				artifacts.set(key, artifact);
			}
		}
	}
	return [...artifacts.values()].reverse();
}

/** Completed turns stay immediately before the next user entry; the latest turn has its own footer. */
export function collectHistoricalArtifacts(entries: readonly ChatEntry[], cwd: string, options: ArtifactOptions = {}): Map<number, FileArtifact[]> {
	const turns = new Map<number, FileArtifact[]>();
	let start = 0;
	entries.forEach((entry, index) => {
		if (entry.kind !== "user") return;
		const artifacts = collectArtifacts(entries.slice(start, index), cwd, options);
		if (artifacts.length > 0) turns.set(index, artifacts);
		start = index;
	});
	return turns;
}
