import type { BridgeClient } from "../bridge/client.ts";
import { fileUrlOf } from "../sidebar/api.ts";
import { resolveArtifactActionPath } from "../components/artifact-actions.ts";
import { attachmentPreflightText } from "../components/attachment-preflight-copy.ts";

export interface AttachmentIssue { path: string; reason: string }
export interface AttachmentProbeTarget { cwd: string; path: string; fileUrl: string; withinWorkspace: boolean }

const invalid = /[\x00-\x1f\x7f]/;
const driveAbsolute = /^[a-z]:[\\/]/i;
const uncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;
const absolute = (value: string): boolean => driveAbsolute.test(value) || uncAbsolute.test(value) || value.startsWith("/");

function normalizeUnc(value: string): string {
	const [host, share, ...tail] = value.replace(/\\/g, "/").split("/").filter(Boolean);
	const parts: string[] = [];
	for (const part of tail) {
		if (part === "..") parts.pop();
		else if (part !== ".") parts.push(part);
	}
	return `//${host}/${share}${parts.length ? `/${parts.join("/")}` : ""}`;
}

/** Resolve only supplied file references, retaining their source-directory meaning across projects. */
export function absoluteAttachmentPath(input: string, cwd: string): string | undefined {
	if (!input.trim() || invalid.test(input) || invalid.test(cwd) || /^~(?:[\\/]|$)/.test(input)) return undefined;
	let url: URL;
	try {
		if (/^file:/i.test(input)) {
			url = new URL(input);
			if (url.search || url.hash || url.username || url.password || /%(?:2f|5c)/i.test(url.pathname)) return undefined;
		} else {
			if (/^[a-z][a-z\d+.-]*:/i.test(input) && !driveAbsolute.test(input)) return undefined;
			if (/^\\(?!\\)/.test(input)) return undefined;
			if (/^(?:\\\\|\/\/)/.test(input) && !uncAbsolute.test(input)) return undefined;
			if (uncAbsolute.test(input)) url = new URL(`file:${encodeURI(normalizeUnc(input)).replace(/#/g, "%23").replace(/\?/g, "%3F")}`);
			else if (driveAbsolute.test(input)) url = new URL(fileUrlOf("", input));
			else if (input.startsWith("/")) {
				const drive = /^([a-z]:)[\\/]/i.exec(cwd)?.[1];
				url = drive ? new URL(fileUrlOf("", `${drive}${input}`)) : new URL(`file://${encodeURI(input).replace(/#/g, "%23").replace(/\?/g, "%3F")}`);
			} else {
				if (!absolute(cwd)) return undefined;
				if (/^(?:\\\\|\/\/)/.test(cwd)) {
					if (!uncAbsolute.test(cwd)) return undefined;
					url = new URL(`file:${encodeURI(normalizeUnc(`${cwd}/${input}`)).replace(/#/g, "%23").replace(/\?/g, "%3F")}`);
				} else url = new URL(fileUrlOf(cwd, input));
			}
		}
		const path = decodeURIComponent(url.pathname);
		if (invalid.test(path)) return undefined;
		if (url.hostname && url.hostname !== "localhost") {
			if (path.split("/").filter(Boolean).length === 0) return undefined;
			return `//${url.hostname}${path}`.replace(/\/+$/, "");
		}
		if (/^\/[a-z]:\//i.test(path)) {
			const resolved = path.slice(1);
			return /^[a-z]:\/$/i.test(resolved) ? resolved : resolved.replace(/\/+$/, "");
		}
		return path.replace(/\/+$/, "") || "/";
	} catch { return undefined; }
}

/** Keep the workspace fence intact; explicitly attached external paths are checked within their own parent. */
export function attachmentProbeTarget(input: string, cwd: string): AttachmentProbeTarget | undefined {
	const path = absoluteAttachmentPath(input, cwd);
	if (!path) return undefined;
	const local = resolveArtifactActionPath(path, cwd);
	if (local) return { cwd, path: local.relative, fileUrl: fileUrlOf(cwd, local.relative), withinWorkspace: true };
	const split = path.lastIndexOf("/");
	let parent = path.slice(0, split) || "/";
	let name = path.slice(split + 1);
	if (/^[a-z]:\/$/i.test(path) || /^\/\/[^/]+\/[^/]+$/.test(path)) { parent = path; name = "."; }
	else if (/^[a-z]:$/i.test(parent)) parent += "/";
	if (!name) name = ".";
	return { cwd: parent, path: name, fileUrl: fileUrlOf(parent, name), withinWorkspace: false };
}

/** A metadata check proves accessibility at this instant; it never means the model read the content. */
export async function checkAttachmentPaths(client: Pick<BridgeClient, "request">, cwd: string, paths: readonly string[]): Promise<AttachmentIssue[]> {
	const unique = [...new Set(paths)];
	const issues: AttachmentIssue[] = [];
	for (let start = 0; start < unique.length; start += 8) {
		const batch = await Promise.all(unique.slice(start, start + 8).map(async (path): Promise<AttachmentIssue | undefined> => {
			const target = attachmentProbeTarget(path, cwd);
			if (!target) return { path, reason: attachmentPreflightText("invalid") };
			try {
				const response = await client.request<{ isFile: boolean; isDirectory: boolean }>({ type: "fs.stat", cwd: target.cwd, path: target.path });
				if (!response?.ok) {
					const error = response?.error ?? "";
					const reason = /ENOENT|not found|no such file|找不到/i.test(error) ? attachmentPreflightText("missing") : /EACCES|EPERM|permission denied|拒绝访问/i.test(error) ? attachmentPreflightText("denied") : error || attachmentPreflightText("unconfirmed");
					return { path, reason };
				}
				if (!response.result?.isFile && !response.result?.isDirectory) return { path, reason: attachmentPreflightText("notFile") };
				return undefined;
			} catch (error) { return { path, reason: error instanceof Error ? error.message : String(error) }; }
		}));
		issues.push(...batch.filter((issue): issue is AttachmentIssue => issue !== undefined));
	}
	return issues;
}
