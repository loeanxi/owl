/**
 * manager 原版静态站 —— 首页 / 管理台 / 成员端原样伺服。
 * 文件来自 manager `src/main/resources/static`，路径与 Java 一致：
 * `/` → home.html，`/admin` → index.html，`/member` → member/index.html。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/** 从本文件向上找 apps/pool-server/public（src 与 dist 都能命中）。 */
export function resolvePublicRoot(): string | null {
	const explicit = process.env.OWL_POOL_PUBLIC;
	if (explicit !== undefined && existsSync(join(explicit, "home.html"))) {
		return explicit;
	}
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, "public");
		if (existsSync(join(candidate, "home.html"))) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return null;
}

/** 命中静态资源则写响应并返回 true。API / 健康检查不接管。 */
export function tryServeManagerSite(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return false;
	}
	if (pathname.startsWith("/api/") || pathname.startsWith("/v1/") || pathname === "/healthz") {
		return false;
	}
	const root = resolvePublicRoot();
	if (root === null) {
		return false;
	}
	const mapped = mapEntry(pathname);
	let relative = mapped;
	try {
		relative = decodeURIComponent(mapped);
	} catch {
		return false;
	}
	const filePath = normalize(join(root, relative.replace(/^[/\\]+/, "")));
	if (filePath !== root && !filePath.startsWith(root + sep)) {
		return false;
	}
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		return false;
	}
	const ext = extname(filePath).toLowerCase();
	response.writeHead(200, {
		"Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
		"Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
		"X-Content-Type-Options": "nosniff",
	});
	if (request.method === "HEAD") {
		response.end();
		return true;
	}
	const stream = createReadStream(filePath);
	stream.on("error", () => {
		if (!response.headersSent) {
			response.writeHead(500);
		}
		response.end();
	});
	stream.pipe(response);
	return true;
}

/** 与 HomePageController / MemberPageController 相同的入口转发。 */
function mapEntry(pathname: string): string {
	if (pathname === "/") {
		return "/home.html";
	}
	if (pathname === "/admin" || pathname === "/admin/") {
		return "/index.html";
	}
	if (pathname === "/member" || pathname === "/member/") {
		return "/member/index.html";
	}
	return pathname;
}
