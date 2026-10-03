import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeRuntime } from "../src/runtime.ts";
import { authorizePath, fileKey, OfficeRuntimeError } from "../src/runtime-paths.ts";
import { OfficeProcesses, processEnvironment } from "../src/runtime-process.ts";
import { gatewayScope, injectViewerLicense, OfficeViewerProxy } from "../src/runtime-proxy.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "owl-office-runtime-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	return root;
}

describe("Office workspace boundary", () => {
	it("rejects traversal and junction escapes while preserving existing output", async () => {
		const root = await workspace();
		const cwd = join(root, "workspace");
		const outside = join(root, "outside");
		await mkdir(cwd); await mkdir(outside);
		await writeFile(join(outside, "original.xlsx"), "original");
		await writeFile(join(cwd, "existing.xlsx"), "keep");
		await symlink(outside, join(cwd, "escape"), "junction");
		await expect(authorizePath(cwd, "../outside/original.xlsx", "existing")).rejects.toMatchObject({ code: "WORKSPACE_DENIED" });
		await expect(authorizePath(cwd, "escape/original.xlsx", "existing")).rejects.toMatchObject({ code: "WORKSPACE_DENIED" });
		await expect(authorizePath(cwd, "escape/new.xlsx", "new")).rejects.toMatchObject({ code: "WORKSPACE_DENIED" });
		await expect(authorizePath(cwd, "existing.xlsx", "new")).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		expect(await readFile(join(cwd, "existing.xlsx"), "utf8")).toBe("keep");
	});

	it("requires user confirmation before merge and rejects unsupported operations", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "review.univer"), "fixture");
		const runtime = new OfficeRuntime({ assetRoot: join(cwd, "not-installed") });
		cleanup.push(() => runtime.dispose());
		await expect(runtime.call("worktree", { file: "review.univer", action: "merge", worktreeId: "draft" }, cwd)).rejects.toMatchObject({ code: "USER_CONFIRMATION_REQUIRED" });
		await expect(runtime.call("worktree", { file: "review.univer", action: "discard", worktreeId: "draft" }, cwd)).rejects.toMatchObject({ code: "USER_CONFIRMATION_REQUIRED" });
		await expect(runtime.call("pretend", {}, cwd)).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
		await expect(runtime.call("new", { file: "review.univer" }, cwd)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		expect(await readFile(join(cwd, "review.univer"), "utf8")).toBe("fixture");
	});
});

describe("Office Viewer browser authorization", () => {
	async function viewer(): Promise<{ url: string; origin: string; key: string; requests: string[] }> {
		const cwd = await workspace();
		const file = join(cwd, "book.univer");
		await writeFile(file, "fixture");
		const viewerRoot = join(cwd, "viewer");
		await mkdir(viewerRoot); await mkdir(join(viewerRoot, "assets"));
		await writeFile(join(viewerRoot, "index.html"), "<html>Office viewer fixture</html>");
		await writeFile(join(viewerRoot, "assets", "viewer.js"), "window.fixture=true;");
		const requests: string[] = [];
		const gateway = http.createServer((req, res) => {
			requests.push(req.url ?? "");
			res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
			res.end(JSON.stringify({ success: true }));
		});
		const ws = new WebSocketServer({ server: gateway });
		ws.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const address = gateway.address() as AddressInfo;
		cleanup.push(async () => {
			for (const socket of ws.clients) socket.terminate();
			ws.close();
			await new Promise<void>((resolve) => { gateway.close(() => resolve()); gateway.closeAllConnections(); });
		});
		const proxy = new OfficeViewerProxy({ viewerRoot, gatewayOrigin: async () => `http://127.0.0.1:${address.port}`,
			validate: async (path, workspace, id) => {
				await authorizePath(workspace, path, "existing");
				if (id !== undefined && id !== "allowed") throw new OfficeRuntimeError("WORKTREE_NOT_FOUND", "forbidden");
			},
		});
		cleanup.push(() => proxy.dispose());
		const url = await proxy.open(file, cwd);
		return { url, origin: new URL(url).origin, key: fileKey(file), requests };
	}

	it("uses a single-use bootstrap and requires scoped cookies for documents, static assets and API", async () => {
		const { url, origin, key, requests } = await viewer();
		expect((await fetch(`${origin}/univer-viewer/?file=${key}`)).status).toBe(403);
		expect((await fetch(`${origin}/univer-viewer/assets/viewer.js`)).status).toBe(403);
		const bootstrap = await fetch(url, { redirect: "manual" });
		expect(bootstrap.status).toBe(303);
		const setCookie = bootstrap.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict");
		const cookie = setCookie.split(";")[0] ?? "";
		expect((await fetch(url, { redirect: "manual" })).status).toBe(403);
		expect(bootstrap.headers.get("location")).toBe(`/univer-viewer/?file=${key}`);
		expect((await fetch(`${origin}/univer-viewer/?file=${key}`, { headers: { cookie } })).status).toBe(200);
		expect((await fetch(`${origin}/univer-viewer/assets/viewer.js`, { headers: { cookie } })).status).toBe(200);
		const ok = await fetch(`${origin}/uf/${key}/units`, { headers: { cookie } });
		expect(ok.status).toBe(200); expect(ok.headers.get("access-control-allow-origin")).toBeNull();
		expect((await fetch(`${origin}/uf/different/units`, { headers: { cookie } })).status).toBe(403);
		expect((await fetch(`${origin}/uf/${key}/units`, { headers: { cookie, origin: "https://attacker.invalid" } })).status).toBe(403);
		expect((await fetch(`${origin}/uf/${key}/worktrees/allowed/merge`, { method: "POST", headers: { cookie } })).status).toBe(403);
		expect((await fetch(`${origin}/uf/${key}/worktrees/allowed/merge`, { method: "POST", headers: { cookie, origin } })).status).toBe(200);
		expect((await fetch(`${origin}/uf/${key}/worktrees/forbidden/units`, { headers: { cookie } })).status).toBe(502);
		expect((await fetch(`${origin}/uf/${key}/optimize`, { method: "POST", headers: { cookie, origin } })).status).toBe(403);
		expect(requests).toEqual([`/uf/${key}/units`, `/uf/${key}/worktrees/allowed/merge`]);
	});

	it("checks WebSocket cookie, origin and worktree scope and preserves TEXT frames", async () => {
		const { url, origin, key } = await viewer();
		const bootstrap = await fetch(url, { redirect: "manual" });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
		async function rejected(path: string, headers: Record<string, string>): Promise<void> {
			const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, { headers });
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => { socket.terminate(); reject(new Error("unauthorized WebSocket did not settle")); }, 2_000);
				socket.once("error", () => { clearTimeout(timeout); resolve(); });
				socket.once("open", () => { clearTimeout(timeout); socket.terminate(); reject(new Error("unauthorized WebSocket opened")); });
			});
		}
		await rejected(`/uf/${key}/events`, { origin });
		await rejected(`/uf/${key}/events`, { cookie, origin: "https://attacker.invalid" });
		await rejected(`/uf/different/events`, { cookie, origin });
		await rejected(`/uf/${key}/worktrees/forbidden/events`, { cookie, origin });
		const path = `/univer-viewer/ws?target=${encodeURIComponent(`/uf/${key}/worktrees/allowed/events`)}`;
		const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, { headers: { cookie, origin } });
		const reply = await new Promise<{ text: string; binary: boolean }>((resolve, reject) => {
			const timeout = setTimeout(() => { socket.terminate(); reject(new Error("authorized WebSocket timed out")); }, 2_000);
			socket.once("open", () => socket.send("你好 Office"));
			socket.once("error", reject);
			socket.once("message", (data, binary) => { clearTimeout(timeout); socket.close(); resolve({ text: data.toString(), binary }); });
		});
		expect(reply).toEqual({ text: "你好 Office", binary: false });
	});

	it("rejects routing escapes and changes only complete license literals", () => {
		expect(gatewayScope("/uf/key/worktrees/a%2fb/units")).toBeUndefined();
		expect(gatewayScope("/uf/key/optimize")).toBeUndefined();
		expect(gatewayScope("/uf/key/worktrees/allowed/events")).toEqual({ key: "key", worktreeId: "allowed" });
		const license = "123456789012-1-cGF5bG9hZA==-c2lnbmF0dXJl-1794758400";
		const source = `const license='${license}';validateLicense(license);`;
		expect(injectViewerLicense(source, 'owned"license')).toBe('const license="owned\\"license";validateLicense(license);');
		expect(injectViewerLicense("validateLicense('ordinary string')", "owned")).toBe("validateLicense('ordinary string')");
	});
});

describe("Office worker settlement", () => {
	it("cancels an owned process before returning and does not forward unrelated credentials", async () => {
		const root = await workspace();
		const pidFile = join(root, "pid.txt");
		const worker = join(root, "worker.cjs");
		await writeFile(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
		const processes = new OfficeProcesses({ assetRoot: root });
		cleanup.push(() => processes.dispose());
		const controller = new AbortController();
		const pending = processes.worker(worker, {}, controller.signal);
		const settled = pending.catch((error: unknown) => error);
		let pid: number | undefined;
		for (let attempt = 0; attempt < 200; attempt++) {
			try { pid = Number(await readFile(pidFile, "utf8")); break; }
			catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
		}
		expect(pid).toBeTypeOf("number");
		controller.abort();
		expect(await settled).toMatchObject({ name: "AbortError" });
		if (pid === undefined) throw new Error("Worker did not start");
		expect(() => process.kill(pid, 0)).toThrow();
		const original = process.env.OWL_OFFICE_TEST_CREDENTIAL;
		process.env.OWL_OFFICE_TEST_CREDENTIAL = "not-for-child";
		try { expect(processEnvironment({ assetRoot: root }).OWL_OFFICE_TEST_CREDENTIAL).toBeUndefined(); }
		finally { if (original === undefined) delete process.env.OWL_OFFICE_TEST_CREDENTIAL; else process.env.OWL_OFFICE_TEST_CREDENTIAL = original; }
	});
});
