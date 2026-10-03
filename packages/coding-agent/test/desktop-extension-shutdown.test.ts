import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(): Promise<{
	bridge: DesktopServerHandle;
	cwd: string;
	request: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
	const root = await mkdtemp(join(tmpdir(), "owl-desktop-shutdown-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const pluginDir = join(root, "plugin");
	await mkdir(cwd);
	await mkdir(agentDir);
	await mkdir(pluginDir);
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const previous = process.env.OWL_CODING_AGENT_DIR;
	process.env.OWL_CODING_AGENT_DIR = agentDir;
	cleanup.push(async () => {
		if (previous === undefined) delete process.env.OWL_CODING_AGENT_DIR;
		else process.env.OWL_CODING_AGENT_DIR = previous;
	});
	await writeFile(
		join(pluginDir, "package.json"),
		JSON.stringify({ name: "desktop-shutdown-probe", type: "module", owl: { extensions: ["index.ts"] } }),
	);
	await writeFile(
		join(pluginDir, "index.ts"),
		`import { appendFile } from "node:fs/promises";
import { join } from "node:path";
export default function shutdownProbe(pi) {
  pi.on("session_shutdown", async (event, ctx) => {
    await appendFile(join(ctx.cwd, "shutdown.log"), JSON.stringify({reason:event.reason,sessionId:ctx.sessionManager.getSessionId()})+"\\n");
  });
}
`,
	);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [pluginDir] }));
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				faux: {
					baseUrl: "https://unused.invalid/v1",
					api: "openai-completions",
					apiKey: "unused-no-network",
					models: [{ id: "fixture", name: "Fixture", contextWindow: 8192, maxTokens: 1024 }],
				},
			},
		}),
	);
	const reserved = createServer();
	await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
	const address = reserved.address();
	if (!address || typeof address === "string") throw new Error("No fixture port");
	await new Promise<void>((resolve) => reserved.close(() => resolve()));
	const bridge = await startDesktopServer({
		port: address.port,
		agentDir,
		cwd,
		mcpServers: {},
		onDiagnostic: () => undefined,
	});
	cleanup.push(() => bridge.close());
	const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	cleanup.push(async () => {
		socket.terminate();
	});
	let count = 0;
	return {
		bridge,
		cwd,
		request: (message) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const id = `shutdown-${++count}`;
				const timeout = setTimeout(() => {
					socket.removeListener("message", receive);
					reject(new Error("Desktop request timed out"));
				}, 15_000);
				const receive = (data: Buffer) => {
					const value = JSON.parse(data.toString()) as Record<string, unknown>;
					if (value.id !== id) return;
					socket.removeListener("message", receive);
					clearTimeout(timeout);
					resolve(value);
				};
				socket.on("message", receive);
				socket.send(JSON.stringify({ ...message, id }));
			}),
	};
}

describe("desktop extension shutdown lifecycle", () => {
	it("emits session_shutdown before deleting a mounted session", async () => {
		const { cwd, request } = await fixture();
		const created = await request({ type: "session.create", cwd, provider: "faux", model: "fixture" });
		expect(created.ok, JSON.stringify(created)).toBe(true);
		const sessionId = (created.result as { sessionId: string }).sessionId;
		const deleted = await request({ type: "session.delete", sessionId });
		// Empty sessions have no persisted JSONL yet; their mounted runtime still needs shutdown.
		expect(deleted.error).toBe(`Unknown session: ${sessionId}`);
		const shutdown = (await readFile(join(cwd, "shutdown.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(shutdown).toEqual([{ reason: "quit", sessionId }]);
	}, 30_000);

	it("settles shutdown handlers for every mounted runtime before closing the bridge", async () => {
		const { bridge, cwd, request } = await fixture();
		const ids: string[] = [];
		for (let index = 0; index < 2; index++) {
			const created = await request({ type: "session.create", cwd, provider: "faux", model: "fixture" });
			expect(created.ok, JSON.stringify(created)).toBe(true);
			ids.push((created.result as { sessionId: string }).sessionId);
		}
		await bridge.close();
		const shutdown = (await readFile(join(cwd, "shutdown.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sessionId: string; reason: string });
		expect(shutdown.map((entry) => entry.sessionId).sort()).toEqual(ids.sort());
		expect(shutdown.every((entry) => entry.reason === "quit")).toBe(true);
	}, 30_000);

	it("shuts down the old extension before a skill reload and the replacement on close", async () => {
		const { bridge, cwd, request } = await fixture();
		const created = await request({ type: "session.create", cwd, provider: "faux", model: "fixture" });
		expect(created.ok, JSON.stringify(created)).toBe(true);
		const sessionId = (created.result as { sessionId: string }).sessionId;
		const changed = await request({ type: "skills.create", cwd, tab: "global", name: "shutdown-fixture", description: "A local lifecycle fixture.", body: "Read only fixture." });
		expect(changed.ok, JSON.stringify(changed)).toBe(true);
		let lines: { reason: string; sessionId: string }[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			try { lines = (await readFile(join(cwd, "shutdown.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
			catch { /* The asynchronous reload has not reached shutdown yet. */ }
			if (lines.some((entry) => entry.reason === "reload")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(lines).toEqual([{ reason: "reload", sessionId }]);
		await bridge.close();
		lines = (await readFile(join(cwd, "shutdown.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(lines).toEqual([{ reason: "reload", sessionId }, { reason: "quit", sessionId }]);
	}, 30_000);
});
