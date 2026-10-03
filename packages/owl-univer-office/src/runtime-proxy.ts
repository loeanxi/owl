import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { assertInside, fileKey, OfficeRuntimeError } from "./runtime-paths.ts";

interface Session { file: string; cwd: string; expires: number; cookie: string; }
export interface ViewerProxyOptions {
	viewerRoot: string;
	license?: string;
	gatewayOrigin: () => Promise<string>;
	validate: (file: string, cwd: string, worktreeId?: string) => Promise<void>;
}

/** Only replace complete vendor license literals; leave all SDK license validation intact. */
export function injectViewerLicense(source: string, license: string): string {
	return source.replace(/(["'])(\d{10,}-\d+-[A-Za-z0-9+/=]+-[A-Za-z0-9+/=]+-\d{8,})\1/g,
		() => JSON.stringify(license));
}

export function gatewayScope(path: string): { key: string; worktreeId?: string } | undefined {
	const match = /^\/uf\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(path);
	if (!match?.[1] || path.includes("\\") || /%2f|%5c|%2e/i.test(path)) return undefined;
	const rest = path.slice(match[0].length);
	if (rest === "optimize" || rest.startsWith("optimize/")) return undefined;
	if (rest.startsWith("worktrees/")) {
		const id = rest.slice("worktrees/".length).split("/")[0];
		if (!id) return undefined;
		try {
			const decoded = decodeURIComponent(id);
			if (!/^[A-Za-z0-9_.-]+$/.test(decoded) || decoded === "." || decoded === "..") return undefined;
			return { key: match[1], worktreeId: decoded };
		} catch { return undefined; }
	}
	return { key: match[1] };
}

function send(res: ServerResponse, status: number): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	res.end(status === 403 ? "Office access denied." : "Office resource unavailable.");
}

export class OfficeViewerProxy {
	private readonly options: ViewerProxyOptions;
	private readonly sessions = new Map<string, Session>();
	private readonly tokens = new Map<string, { session: string; expires: number }>();
	private readonly server: http.Server;
	private readonly sockets = new WebSocketServer({ noServer: true });
	private readonly bridges = new Set<() => void>();
	private readonly requests = new Set<ClientRequest>();
	private starting: Promise<string> | undefined;
	private origin: string | undefined;
	private disposed = false;

	constructor(options: ViewerProxyOptions) {
		this.options = options;
		this.server = http.createServer((req, res) => {
			void this.handle(req, res).catch(() => {
				if (!res.headersSent) send(res, 502); else res.destroy();
			});
		});
		this.server.on("upgrade", (req, socket, head) => {
			void this.upgrade(req, socket, head).catch(() => socket.destroy());
		});
	}

	async open(file: string, cwd: string): Promise<string> {
		if (this.disposed) throw new OfficeRuntimeError("RUNTIME_DISPOSED", "Office viewer is closed.");
		const origin = await this.ensureServer();
		await this.options.validate(file, cwd);
		this.prune();
		const sessionId = randomBytes(24).toString("base64url");
		const cookie = `owl_office_${randomBytes(8).toString("hex")}`;
		this.sessions.set(sessionId, { file, cwd, cookie, expires: Date.now() + 8 * 60 * 60 * 1_000 });
		const token = randomBytes(32).toString("base64url");
		this.tokens.set(token, { session: sessionId, expires: Date.now() + 60_000 });
		return `${origin}/open/${token}`;
	}

	private ensureServer(): Promise<string> {
		if (this.origin) return Promise.resolve(this.origin);
		if (this.starting) return this.starting;
		this.starting = new Promise<string>((resolve, reject) => {
			const failed = (error: Error) => reject(error);
			this.server.once("error", failed);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.removeListener("error", failed);
				const address = this.server.address() as AddressInfo;
				this.origin = `http://127.0.0.1:${address.port}`;
				resolve(this.origin);
			});
		});
		return this.starting;
	}

	private prune(): void {
		for (const [key, value] of this.sessions) if (value.expires <= Date.now()) this.sessions.delete(key);
		for (const [key, value] of this.tokens) if (value.expires <= Date.now()) this.tokens.delete(key);
		if (this.sessions.size >= 32) throw new OfficeRuntimeError("VIEWER_SESSION_LIMIT", "Close and restart the Office runtime before opening more files.");
	}

	private requestTrusted(req: IncomingMessage, mutation: boolean): boolean {
		if (this.disposed || !this.origin || req.headers.host !== new URL(this.origin).host) return false;
		return mutation ? req.headers.origin === this.origin : req.headers.origin === undefined || req.headers.origin === this.origin;
	}

	private sessionFor(req: IncomingMessage, key?: string): Session | undefined {
		const cookies = new Map((req.headers.cookie ?? "").split(";").map((value) => {
			const split = value.indexOf("=");
			return [value.slice(0, split).trim(), value.slice(split + 1)] as const;
		}));
		for (const [id, session] of this.sessions) {
			if (session.expires > Date.now() && cookies.get(session.cookie) === id &&
				(key === undefined || fileKey(session.file) === key)) return session;
		}
		return undefined;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const mutation = req.method !== "GET" && req.method !== "HEAD";
		if (!this.requestTrusted(req, mutation)) { send(res, 403); return; }
		const url = new URL(req.url ?? "/", this.origin);
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		if (url.pathname.startsWith("/open/") && req.method === "GET") {
			const token = url.pathname.slice("/open/".length);
			const grant = this.tokens.get(token);
			this.tokens.delete(token);
			const session = grant ? this.sessions.get(grant.session) : undefined;
			if (!grant || grant.expires <= Date.now() || !session) { send(res, 403); return; }
			await this.options.validate(session.file, session.cwd);
			res.writeHead(303, {
				"set-cookie": `${session.cookie}=${grant.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
				location: `/univer-viewer/?file=${fileKey(session.file)}`,
				"cache-control": "no-store",
			});
			res.end(); return;
		}
		if (url.pathname.startsWith("/uf/")) {
			const scope = gatewayScope(url.pathname);
			const session = scope ? this.sessionFor(req, scope.key) : undefined;
			if (!scope || !session || (mutation && url.pathname === `/uf/${scope.key}`)) { send(res, 403); return; }
			await this.options.validate(session.file, session.cwd, scope.worktreeId);
			await this.forward(req, res, `${url.pathname}${url.search}`); return;
		}
		if ((url.pathname !== "/univer-viewer" && !url.pathname.startsWith("/univer-viewer/")) || mutation) { send(res, 404); return; }
		const key = url.pathname === "/univer-viewer" || url.pathname === "/univer-viewer/"
			? url.searchParams.get("file") ?? "" : undefined;
		const session = this.sessionFor(req, key);
		if (!session) { send(res, 403); return; }
		await this.options.validate(session.file, session.cwd, optionalWorktree(url.searchParams.get("worktree")));
		if (url.pathname === "/univer-viewer/runtime-config") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ desktopStreamBaseUrl: this.origin })); return;
		}
		let suffix: string;
		try { suffix = decodeURIComponent(url.pathname.slice("/univer-viewer".length)); }
		catch { send(res, 404); return; }
		if (suffix.includes("\\") || suffix.includes("\0")) { send(res, 404); return; }
		const root = await realpath(this.options.viewerRoot);
		const asset = await realpath(join(root, suffix === "" || suffix === "/" ? "index.html" : suffix));
		assertInside(root, asset);
		const extension = extname(asset);
		const bytes = await readFile(asset);
		const body = extension === ".js" && this.options.license
			? Buffer.from(injectViewerLicense(bytes.toString("utf8"), this.options.license)) : bytes;
		const contentType: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
		res.writeHead(200, { "content-type": contentType[extension] ?? "application/octet-stream", "cache-control": "no-store" });
		res.end(req.method === "HEAD" ? undefined : body);
	}

	private async forward(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
		const origin = await this.options.gatewayOrigin();
		const headers = { ...req.headers };
		for (const key of ["cookie", "host", "origin", "connection", "upgrade"]) delete headers[key];
		const upstream = http.request(new URL(path, origin), { method: req.method, headers });
		this.requests.add(upstream);
		upstream.setTimeout(60_000, () => upstream.destroy());
		upstream.once("close", () => this.requests.delete(upstream));
		req.once("aborted", () => upstream.destroy());
		res.once("close", () => upstream.destroy());
		upstream.once("error", () => { if (!res.headersSent) send(res, 502); else res.destroy(); });
		upstream.on("response", (response) => {
			const responseHeaders = { ...response.headers };
			for (const name of Object.keys(responseHeaders)) {
				if (name.startsWith("access-control-") || ["set-cookie", "connection", "transfer-encoding"].includes(name)) delete responseHeaders[name];
			}
			res.writeHead(response.statusCode ?? 502, responseHeaders);
			response.once("error", () => res.destroy());
			response.pipe(res);
		});
		req.pipe(upstream);
	}

	private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		if (!this.requestTrusted(req, true)) { socket.destroy(); return; }
		const url = new URL(req.url ?? "/", this.origin);
		const tunnel = url.pathname === "/univer-viewer/ws";
		const target = tunnel ? url.searchParams.get("target") : `${url.pathname}${url.search}`;
		if (!target?.startsWith("/uf/") || target.startsWith("//")) { socket.destroy(); return; }
		const targetUrl = new URL(target, await this.options.gatewayOrigin());
		const scope = gatewayScope(targetUrl.pathname);
		const session = scope ? this.sessionFor(req, scope.key) : undefined;
		if (!scope || !session) { socket.destroy(); return; }
		await this.options.validate(session.file, session.cwd, scope.worktreeId);
		if (tunnel) for (const [name, value] of url.searchParams) if (name !== "target") targetUrl.searchParams.set(name, value);
		targetUrl.protocol = "ws:";
		if (this.disposed) { socket.destroy(); return; }
		this.sockets.handleUpgrade(req, socket, head, (client) => {
			const protocols = req.headers["sec-websocket-protocol"];
			const upstream = new WebSocket(targetUrl, protocols?.split(",").map((value) => value.trim()));
			const pending: { data: Buffer; binary: boolean }[] = [];
			let pendingBytes = 0;
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true; this.bridges.delete(close); client.terminate(); upstream.terminate();
			};
			this.bridges.add(close);
			client.on("message", (data, binary) => {
				if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
				else if (upstream.readyState === WebSocket.CONNECTING) {
					const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
					pendingBytes += buffer.length;
					if (pendingBytes > 1024 * 1024) close(); else pending.push({ data: buffer, binary });
				}
			});
			upstream.once("open", () => { for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.binary }); });
			upstream.on("message", (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
			for (const ws of [client, upstream]) { ws.once("error", close); ws.once("close", close); }
		});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.sessions.clear(); this.tokens.clear();
		for (const request of this.requests) request.destroy();
		for (const close of this.bridges) close();
		this.sockets.close();
		if (this.starting) await this.starting.catch(() => undefined);
		if (this.server.listening) await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
	}
}

function optionalWorktree(value: string | null): string | undefined {
	return value === null ? undefined : value;
}
