import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeClient } from "../../../apps/desktop/src/bridge/client.ts";
import { MAIL_AGENT_CONTEXT_ENTRY } from "../src/core/mail/agent.ts";
import { MailStore } from "../src/core/mail/store.ts";
import type { MailAccount, MailAgentStartResult, MailThread } from "../src/core/mail/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionSnapshotPayload, SessionStatsResult } from "../src/modes/desktop/protocol.ts";
import { isTrustedDesktopOrigin, startDesktopServer } from "../src/modes/desktop/serve.ts";

it("accepts local desktop origins and rejects remote, null, malformed and wildcard origins", () => {
	for (const origin of [
		undefined,
		"http://localhost:1420",
		"https://127.0.0.1:8787",
		"http://[::1]:1420",
		"tauri://localhost",
		"http://tauri.localhost",
		"https://tauri.localhost",
	]) {
		expect(isTrustedDesktopOrigin(origin), origin).toBe(true);
	}
	for (const origin of [
		"null",
		"",
		"https://attacker.test",
		"https://localhost.attacker.test",
		"file:///tmp/page",
		"http://localhost/path",
		"http://localhost?origin=attack",
		"http://user@localhost",
		"tauri://attacker.test",
	]) {
		expect(isTrustedDesktopOrigin(origin), origin).toBe(false);
	}
	expect(isTrustedDesktopOrigin("http://desktop.internal:8787", "desktop.internal")).toBe(true);
	expect(isTrustedDesktopOrigin("http://attacker.test", "0.0.0.0")).toBe(false);
	expect(isTrustedDesktopOrigin("http://attacker.test", "::")).toBe(false);
});

it("routes mailbox RPCs, isolates/resumes mailbox sessions and blocks remote event subscribers through the real bridge", async () => {
	const root = await mkdtemp(join(tmpdir(), "owl-mail-bridge-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const pluginDir = join(root, "ordinary-plugin");
	const sentinel = join(root, "plugin-loaded.txt");
	await mkdir(agentDir);
	await mkdir(cwd);
	await mkdir(pluginDir);
	await writeFile(
		join(pluginDir, "package.json"),
		JSON.stringify({ name: "mail-isolation-probe", type: "module", owl: { extensions: ["index.ts"] } }),
	);
	await writeFile(
		join(pluginDir, "index.ts"),
		`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "loaded"); export default function() {}`,
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			plugins: [pluginDir],
			defaultProvider: "faux",
			defaultModel: "fixture",
			cacheWarming: { mode: "off" },
		}),
	);
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				faux: {
					baseUrl: "https://unused.invalid/v1",
					api: "openai-completions",
					apiKey: "unused-no-network",
					models: [
						{ id: "fixture", name: "Fixture", contextWindow: 8192, maxTokens: 1024 },
						{ id: "selected", name: "Selected", contextWindow: 8192, maxTokens: 1024 },
					],
				},
			},
		}),
	);
	const transform = async (value: string) => value;
	const store = new MailStore(agentDir, transform, transform);
	await store.save({
		accounts: [
			{
				id: "work",
				email: "me@work.test",
				label: "工作",
				status: "connected",
				scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
				accessToken: "offline-fixture",
				expiresAt: Date.now() + 3600_000,
			},
		],
	});
	const mailContext = {
		mode: "threads" as const,
		accountIds: ["work"],
		threads: [{ accountId: "work", threadId: "thread1" }],
	};
	const saved = SessionManager.create(cwd, join(agentDir, "mail", "agent-sessions"));
	saved.appendCustomEntry(MAIL_AGENT_CONTEXT_ENTRY, mailContext);
	saved.appendMessage({ role: "user", content: "总结邮件", timestamp: Date.now() });
	saved.appendMessage({
		role: "assistant",
		api: "openai-completions",
		provider: "faux",
		model: "fixture",
		stopReason: "stop",
		content: [{ type: "text", text: "先前摘要" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
	const calls: string[] = [];
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("/threads/thread1?")) {
			return Response.json({
				id: "thread1",
				messages: [
					{
						id: "message1",
						internalDate: String(Date.now()),
						payload: {
							mimeType: "text/plain",
							headers: [
								{ name: "From", value: "client@example.test" },
								{ name: "To", value: "me@work.test" },
								{ name: "Subject", value: "交付" },
								{ name: "Message-ID", value: "<source@example.test>" },
							],
							body: { data: Buffer.from("请确认交付时间").toString("base64url") },
						},
					},
				],
			});
		}
		throw new Error(`Unexpected network request: ${url}`);
	};
	const originalWebSocket = globalThis.WebSocket;
	const previousAgentDir = process.env.OWL_CODING_AGENT_DIR;
	process.env.OWL_CODING_AGENT_DIR = agentDir;
	globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
	const bridge = await startDesktopServer({
		port: 0,
		agentDir,
		cwd,
		mcpServers: {},
		onDiagnostic: () => {},
		mail: { fetch: fakeFetch, seal: transform, unseal: transform },
	});
	const client = new BridgeClient(`ws://127.0.0.1:${bridge.port}/ws`);
	try {
		const rejected = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { origin: "https://attacker.test" });
		const rejection = await new Promise<number>((resolve, reject) => {
			rejected.once("open", () => reject(new Error("Untrusted website subscribed to private mail events")));
			rejected.once("unexpected-response", (_request, response) => {
				response.resume();
				rejected.terminate();
				resolve(response.statusCode ?? 0);
			});
			rejected.on("error", () => {});
		});
		expect(rejection).toBe(401);
		await new Promise<void>((resolve) => {
			client.onStatus((connected) => {
				if (connected) resolve();
			});
			client.connect();
		});
		const response = await client.request<MailAccount[]>({ type: "mail.request", request: { action: "accounts" } });
		expect(response).toMatchObject({ ok: true, result: [{ id: "work", email: "me@work.test" }] });
		expect(JSON.stringify(response)).not.toContain("offline-fixture");
		expect(
			await client.request<MailThread>({
				type: "mail.request",
				request: { action: "thread.get", accountId: "work", threadId: "thread1" },
			}),
		).toMatchObject({
			ok: true,
			result: { accountId: "work", id: "thread1", messages: [{ bodyText: "请确认交付时间" }] },
		});
		const started = await client.request<MailAgentStartResult>({
			type: "mail.agent.start",
			context: mailContext,
			provider: "faux",
			model: "selected",
		});
		expect(started).toMatchObject({ ok: true, result: { context: mailContext } });
		if (!started.result?.sessionId) throw new Error(JSON.stringify(started));
		expect(
			await client.request<SessionStatsResult>({ type: "session.stats", sessionId: started.result.sessionId }),
		).toMatchObject({ ok: true, result: { model: { provider: "faux", id: "selected" } } });
		const resumed = await client.request<SessionSnapshotPayload>({
			type: "session.resume",
			sessionId: saved.getSessionId(),
			approvalMode: "auto",
		});
		expect(resumed).toMatchObject({
			ok: true,
			result: { mailContext, messages: [{ role: "user" }, { role: "assistant" }] },
		});
		expect(existsSync(sentinel)).toBe(false);
		const listed = await client.request<Array<{ id: string }>>({ type: "session.list" });
		expect(listed.ok).toBe(true);
		expect(listed.result?.some((item) => item.id === saved.getSessionId())).toBe(false);
		expect(calls.every((url) => url.startsWith("https://gmail.googleapis.com/"))).toBe(true);
	} finally {
		client.disconnect();
		await bridge.close();
		globalThis.WebSocket = originalWebSocket;
		if (previousAgentDir === undefined) delete process.env.OWL_CODING_AGENT_DIR;
		else process.env.OWL_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
