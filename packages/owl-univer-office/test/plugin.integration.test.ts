import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadExtensionsCached } from "../../coding-agent/src/core/extensions/loader.ts";
import { startDesktopServer } from "../../coding-agent/src/modes/desktop/serve.ts";
import { OfficeRuntime } from "../src/runtime.ts";

it("loads all Office tools and completes a real desktop question approval over WebSocket", async () => {
	const assetRoot = process.env.OWL_UNIVER_TEST_RUNTIME;
	if (!assetRoot) throw new Error("Set OWL_UNIVER_TEST_RUNTIME for the explicit real-plugin integration check.");
	const root = await mkdtemp(join(tmpdir(), "owl-office-plugin-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const pluginPath = resolve(process.cwd(), "src", "index.ts");
	const previousAgent = process.env.OWL_CODING_AGENT_DIR;
	const previousRuntime = process.env.OWL_UNIVER_RUNTIME_ROOT;
	process.env.OWL_CODING_AGENT_DIR = agentDir;
	process.env.OWL_UNIVER_RUNTIME_ROOT = assetRoot;
	let bridge: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
	let socket: WebSocket | undefined;
	const seed = new OfficeRuntime({ assetRoot });
	const loaded = await loadExtensionsCached([pluginPath], cwd);
	try {
		expect(loaded.errors).toEqual([]);
		const extension = loaded.extensions[0];
		expect(extension.tools.size).toBe(14);
		await seed.call("new", { file: "review.univer" }, cwd);
		const draft = await seed.call("worktree", { file: "review.univer", action: "create" }, cwd);
		await seed.call(
			"unit",
			{ file: "review.univer", worktreeId: draft.worktreeId, action: "create", kind: "sheet", name: "审批样本" },
			cwd,
		);
		await seed.call("worktree", { file: "review.univer", worktreeId: draft.worktreeId, action: "ready" }, cwd);
		await seed.dispose();
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [resolve(pluginPath, "..", "..")] }));
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
		await new Promise<void>((done) => reserved.listen(0, "127.0.0.1", done));
		const address = reserved.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		await new Promise<void>((done) => reserved.close(() => done()));
		bridge = await startDesktopServer({
			port: address.port,
			agentDir,
			cwd,
			mcpServers: {},
			onDiagnostic: () => undefined,
		});
		socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
		const wire = socket;
		await new Promise<void>((done, reject) => {
			wire.once("open", done);
			wire.once("error", reject);
		});
		const created = new Promise<{ ok: boolean; result?: { sessionId: string }; error?: string }>((done) => {
			const receive = (raw: Buffer) => {
				const message = JSON.parse(raw.toString());
				if (message.id !== "create") return;
				wire.off("message", receive);
				done(message);
			};
			wire.on("message", receive);
			wire.send(JSON.stringify({ id: "create", type: "session.create", cwd, provider: "faux", model: "fixture" }));
		});
		const session = await created;
		expect(session.ok, session.error).toBe(true);
		if (!session.result) throw new Error("Session was not created");
		let requests = 0;
		wire.on("message", (raw: Buffer) => {
			const message = JSON.parse(raw.toString());
			if (message.type !== "question_request") return;
			requests += 1;
			expect(message.sessionId).toBe(session.result!.sessionId);
			wire.send(
				JSON.stringify({
					id: "approval",
					type: "question.response",
					requestId: message.requestId,
					answers: [{ index: 0, selectedLabels: ["确认合入"] }],
				}),
			);
		});
		const tool = extension.tools.get("univer_worktree")!.definition;
		const merged = await tool.execute(
			"office-approval",
			{ file: "review.univer", worktreeId: draft.worktreeId, action: "merge" },
			undefined,
			undefined,
			{
				cwd,
				hasUI: false,
				model: undefined,
				ui: {
					confirm: async () => {
						throw new Error("noOp UI must not be used");
					},
				},
				sessionManager: { getSessionId: () => session.result!.sessionId },
			} as never,
		);
		expect(requests).toBe(1);
		expect(merged.structuredContent).toMatchObject({ ok: true, operation: "worktree" });
		const status = await extension.tools
			.get("univer_status")!
			.definition.execute("office-status", { file: "review.univer" }, undefined, undefined, {
				cwd,
				hasUI: false,
				ui: {},
				sessionManager: { getSessionId: () => session.result!.sessionId },
			} as never);
		expect(JSON.stringify(status.structuredContent)).toContain("审批样本");
	} finally {
		socket?.terminate();
		await bridge?.close();
		for (const extension of loaded.extensions)
			for (const shutdown of extension.handlers.get("session_shutdown") ?? [])
				await shutdown({ type: "session_shutdown", reason: "quit" }, {} as never);
		await seed.dispose();
		if (previousAgent === undefined) delete process.env.OWL_CODING_AGENT_DIR;
		else process.env.OWL_CODING_AGENT_DIR = previousAgent;
		if (previousRuntime === undefined) delete process.env.OWL_UNIVER_RUNTIME_ROOT;
		else process.env.OWL_UNIVER_RUNTIME_ROOT = previousRuntime;
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
