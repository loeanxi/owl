import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentSession } from "../src/core/agent-session.ts";
import type { DesktopClientRequestWithoutId, ServerResponseMessage } from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

it("applies memory settings to mounted sessions without reloading them and preserves project overrides", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-memory-settings-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-memory-settings-")) {
		throw new Error("Unsafe memory settings cleanup target");
	}
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const projectCwd = join(root, "project-override");
	await mkdir(agentDir);
	await mkdir(cwd);
	await mkdir(join(projectCwd, ".owl"), { recursive: true });
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ plugins: [], cacheWarming: { mode: "off" }, owlMemory: { enabled: true } }),
	);
	await writeFile(join(projectCwd, ".owl", "settings.json"), JSON.stringify({ owlMemory: { enabled: true } }));
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const mounted = new Map<string, AgentSession>();
	// Exercise real bridge mounting and settings propagation without entering a provider request.
	const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
		mounted.set(this.sessionManager.getSessionId(), this);
	});
	const reload = vi.spyOn(AgentSession.prototype, "reload");
	const abort = vi.spyOn(AgentSession.prototype, "abort");
	const noFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("External requests forbidden in memory settings tests");
	});
	let bridge: DesktopServerHandle | undefined;
	let socket: WebSocket | undefined;
	try {
		bridge = await startDesktopServer({
			port: 0,
			agentDir,
			cwd,
			mcpServers: {},
			onDiagnostic: () => {},
			news: {
				fetch: noFetch,
				listModels: () => [],
				callModel: async () => {
					throw new Error("Model calls forbidden");
				},
				resolveModel: async () => {
					throw new Error("Model calls forbidden");
				},
			},
		});
		socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
		const connected = socket;
		await new Promise<void>((done, reject) => {
			connected.once("open", done);
			connected.once("error", reject);
		});
		function request<T>(payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage & { result?: T }> {
			const id = randomUUID();
			return new Promise((done, reject) => {
				const timer = setTimeout(() => {
					connected.off("message", receive);
					reject(new Error("Memory settings bridge request timed out"));
				}, 5000);
				const receive = (data: unknown) => {
					const response = JSON.parse(String(data)) as ServerResponseMessage & { result?: T };
					if (response.type !== "response" || response.id !== id) return;
					clearTimeout(timer);
					connected.off("message", receive);
					done(response);
				};
				connected.on("message", receive);
				connected.send(JSON.stringify({ ...payload, id }));
			});
		}
		const ids: string[] = [];
		for (const project of [cwd, cwd, projectCwd]) {
			const created = await request<{ sessionId: string }>({ type: "session.create", cwd: project });
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.result?.sessionId) throw new Error("No session returned");
			const sessionId = created.result.sessionId;
			ids.push(sessionId);
			expect(await request({ type: "session.prompt", sessionId, message: "inspect fixture" })).toMatchObject({
				ok: true,
			});
		}
		const runtimes = ids.map((id) => {
			const session = mounted.get(id);
			if (!session) throw new Error(`Session not mounted: ${id}`);
			return session;
		});
		expect(runtimes.map((session) => session.settingsManager.getOwlMemoryEnabled())).toEqual([true, true, true]);
		expect(await request({ type: "settings.set", values: { owlMemory: { enabled: false } } })).toMatchObject({
			ok: true,
		});
		expect(runtimes.map((session) => session.settingsManager.getSettings().owlMemory?.enabled)).toEqual([
			false,
			false,
			true,
		]);
		expect(runtimes.map((session) => session.settingsManager.getGlobalSettings().owlMemory?.enabled)).toEqual([
			false,
			false,
			false,
		]);
		expect(await request({ type: "settings.set", values: { owlMemory: { enabled: true } } })).toMatchObject({
			ok: true,
		});
		expect(runtimes.map((session) => session.settingsManager.getOwlMemoryEnabled())).toEqual([true, true, true]);
		expect(runtimes[2].settingsManager.getProjectSettings().owlMemory).toEqual({ enabled: true });
		expect(reload).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(noFetch).not.toHaveBeenCalled();
	} finally {
		socket?.terminate();
		await bridge?.close();
		prompt.mockRestore();
		reload.mockRestore();
		abort.mockRestore();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
