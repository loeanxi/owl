import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Account } from "owl-pool";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CodexChatClient } from "../src/gateway/codex-client.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), "owl-codex-quota-test-"));
const home = join(root, "selected-account");
mkdirSync(home);
const account: Account = {
	id: "codex-quota-test",
	name: "Codex quota test",
	platform: "CODEX",
	credentials: { codexHome: home },
	enabled: true,
	createdAt: 0,
	updatedAt: 0,
};

type RpcReply = { result?: Record<string, unknown>; error?: { code: number; message: string } };

function appServer(replies: Partial<Record<string, RpcReply>>) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => {
			child.emit("exit", 0);
			return true;
		}),
	});
	const methods: string[] = [];
	child.stdin.on("data", (chunk: Buffer) => {
		const call: { id?: number; method: string } = JSON.parse(chunk.toString());
		methods.push(call.method);
		if (call.id === undefined) return;
		const reply = replies[call.method] ?? {
			result: call.method === "account/read" ? { account: { type: "chatgpt" } } : {},
		};
		queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: call.id, ...reply })}\n`));
	});
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
	return { child, methods };
}

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Codex selected-account quota RPC", () => {
	it("sets the selected CODEX_HOME and only reads account and rate limits", async () => {
		vi.stubEnv("CODEX_HOME", join(root, "unrelated-global-account"));
		const server = appServer({
			"account/rateLimits/read": { result: { rateLimits: { primary: { usedPercent: 37 } } } },
		});
		const snapshot = await new CodexChatClient({ homeRoot: root, executable: "codex.exe" }).quota(account);
		expect(snapshot).toMatchObject({ ok: true, credits: null, buckets: [{ remainingPercent: 63 }] });
		expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
			cwd: home,
			env: { CODEX_HOME: home },
			windowsHide: true,
		});
		expect(server.methods).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
		expect(server.child.kill).toHaveBeenCalledOnce();
	});

	it("retries initialization failures in a fresh process", async () => {
		const first = appServer({ initialize: { error: { code: -32000, message: "transient boot failure" } } });
		const second = appServer({
			"account/rateLimits/read": { result: { rateLimits: { primary: { usedPercent: 13 } } } },
		});
		const snapshot = await new CodexChatClient({ homeRoot: root }).quota(account);
		expect(snapshot).toMatchObject({ ok: true, buckets: [{ remainingPercent: 87 }] });
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(first.child.kill).toHaveBeenCalledOnce();
		expect(second.child.kill).toHaveBeenCalledOnce();
	});

	it("keeps repeated quota RPC failures as SERVER and hides upstream private messages", async () => {
		const error = { code: -32001, message: "private upstream detail token=do-not-show" };
		appServer({ "account/rateLimits/read": { error } });
		appServer({ "account/rateLimits/read": { error } });
		const client = new CodexChatClient({ homeRoot: root });
		const failure = await client.quota(account).catch((error: unknown) => error);
		expect(failure).toMatchObject({
			kind: "SERVER",
			message: expect.stringContaining("-32001"),
		});
		expect(failure).toMatchObject({ message: expect.not.stringContaining("do-not-show") });
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("does not fabricate zero balance for unavailable quota windows", async () => {
		appServer({ "account/rateLimits/read": { result: { rateLimits: { primary: null, secondary: null } } } });
		appServer({ "account/rateLimits/read": { result: { rateLimits: { primary: null, secondary: null } } } });
		const snapshot = await new CodexChatClient({ homeRoot: root }).quota(account);
		expect(snapshot).toMatchObject({ ok: false, credits: null, buckets: [] });
	});

	it("preserves authoritative missing ChatGPT login as AUTH without a retry", async () => {
		const server = appServer({ "account/read": { result: { account: null } } });
		await expect(new CodexChatClient({ homeRoot: root }).quota(account)).rejects.toMatchObject({ kind: "AUTH" });
		expect(spawn).toHaveBeenCalledOnce();
		expect(server.child.kill).toHaveBeenCalledOnce();
	});
});
