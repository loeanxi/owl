import { workspaceArtifactPath } from "../hooks/artifacts.ts";
import { fileUrlOf } from "../sidebar/api.ts";

/** Reuse the workspace fence and file URL encoding for Windows, UNC and POSIX paths. */
export function resolveArtifactActionPath(input: string, cwd: string): { relative: string; absolute: string } | undefined {
	if (/[\x00-\x1f\x7f]/.test(cwd)) return undefined;
	const relative = workspaceArtifactPath(input, cwd);
	if (!relative) return undefined;
	try {
		const url = new URL(fileUrlOf(cwd, relative));
		let absolute = decodeURIComponent(url.pathname);
		if (url.hostname && url.hostname !== "localhost") absolute = `//${url.hostname}${absolute}`;
		else if (/^\/[a-z]:\//i.test(absolute)) absolute = absolute.slice(1);
		if (/^[a-z]:\//i.test(absolute) || absolute.startsWith("//")) absolute = absolute.replace(/\//g, "\\");
		return { relative, absolute };
	} catch {
		return undefined;
	}
}
