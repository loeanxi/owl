/**
 * 桌面桥单端口静态 UI：node serve.js 时顺带托管 apps/desktop/dist。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UI_CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

export function resolveUiRoot(): string | null {
	const explicit = process.env.OWL_UI_DIR;
	if (explicit && existsSync(join(explicit, "index.html"))) return explicit;
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "apps", "desktop", "dist");
		if (existsSync(join(candidate, "index.html"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function serveUi(uiRoot: string, requestPath: string, response: ServerResponse, headOnly: boolean): void {
	let relative = "/";
	try {
		relative = normalize(decodeURIComponent(requestPath.split("?")[0] ?? "/"));
	} catch {
		// 非法编码按 "/" 处理
	}
	let filePath = join(uiRoot, relative.replace(/^[/\\]+/, ""));
	if (filePath !== uiRoot && !filePath.startsWith(uiRoot + sep)) filePath = join(uiRoot, "index.html");
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		filePath = join(uiRoot, "index.html");
	}
	try {
		const body = readFileSync(filePath);
		const isHtml = extname(filePath).toLowerCase() === ".html";
		response.writeHead(200, {
			"Content-Type": UI_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
			...(isHtml ? { "Cache-Control": "no-cache" } : {}),
		});
		response.end(headOnly ? undefined : body);
	} catch {
		response.writeHead(500).end();
	}
}

/** Only local desktop/browser surfaces may subscribe to private agent and mailbox events. */
export function isTrustedDesktopOrigin(origin: string | undefined, bindingHost?: string): boolean {
	if (origin === undefined) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
		return false;
	if (url.protocol === "tauri:") return url.hostname === "localhost";
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (["localhost", "127.0.0.1", "[::1]", "tauri.localhost"].includes(url.hostname)) return true;
	if (!bindingHost || ["0.0.0.0", "::", "[::]"].includes(bindingHost)) return false;
	return url.hostname === bindingHost.toLowerCase();
}
