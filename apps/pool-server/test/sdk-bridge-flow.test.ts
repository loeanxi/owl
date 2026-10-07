import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "owl-pool";
import { afterEach, describe, expect, it } from "vitest";
import { SdkBridgeChatClient, SdkBridgeManager } from "../src/gateway/sdk-bridge.ts";

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
	while (closers.length > 0) {
		closers.pop()?.();
	}
	const dir = dirs.pop();
	if (dir !== undefined) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟
		}
	}
});

/**
 * 假桥脚本：讲真协议（initialize/chat/text_delta/tool_call/usage/done），
 * 用于验证运行时客户端与回合语义，不依赖任何平台 SDK。
 */
function writeFakeBridge(dir: string, mode: "text" | "tool"): string {
	const script = join(dir, "fake-bridge.mjs");
	const body = `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const frame = JSON.parse(line);
	const send = (event, extra = {}) => {
		process.stdout.write(JSON.stringify({ id: frame.id, event, ...extra }) + "\\n");
	};
	if (frame.method === "initialize") {
		send("result", { data: { initialized: true } });
		return;
	}
	if (frame.method === "chat") {
		const push = (payload) => process.stdout.write(JSON.stringify({ id: frame.id, ...payload }) + "\\n");
		if (${JSON.stringify(mode)} === "text") {
			push({ event: "text_delta", text: "你好" });
			push({ event: "text_delta", text: "世界" });
			push({ event: "usage", inputTokens: 3, outputTokens: 2 });
			push({ event: "done", finishReason: "stop" });
		} else {
			push({ event: "tool_call", toolCallId: "rt-1", name: "read_file", arguments: "{\\"path\\":\\"a.ts\\"}" });
			push({ event: "usage", inputTokens: 4, outputTokens: 0 });
			// 不发 done：等待 tool_result（DEFERRED 语义）
		}
		return;
	}
	if (frame.method === "tool_result") {
		send("result", { data: { ok: true } });
		return;
	}
	if (frame.method === "cancel") {
		send("result", { data: { cancelled: true } });
	}
});
`;
	writeFileSync(script, body, "utf8");
	return script;
}

function makeBridge(mode: "text" | "tool"): {
	client: SdkBridgeChatClient;
	account: Account;
	manager: SdkBridgeManager;
} {
	const dir = mkdtempSync(join(tmpdir(), "owl-pool-bridge-"));
	dirs.push(dir);
	const script = writeFakeBridge(dir, mode);
	const accounts = {
		list: () => [],
		listEnabled: () => [],
		get: () => undefined,
		require: () => {
			throw new Error("not implemented");
		},
		create: () => {
			throw new Error("not implemented");
		},
		updateFields: () => {
			throw new Error("not implemented");
		},
		patchState: () => {
			throw new Error("not implemented");
		},
		delete: () => undefined,
	};
	const manager = new SdkBridgeManager(
		{
			nodeExecutable: process.execPath,
			script,
			homeRoot: join(dir, "accounts"),
			requestTimeoutMs: 10_000,
			idleRecycleMs: 60_000,
			userHome: dir,
		},
		accounts,
	);
	closers.push(() => manager.stop());
	const client = new SdkBridgeChatClient(manager, accounts, "CURSOR", {
		nodeExecutable: process.execPath,
		script,
		homeRoot: join(dir, "accounts"),
		requestTimeoutMs: 10_000,
		idleRecycleMs: 60_000,
		userHome: dir,
	});
	const acct: Account = {
		id: "cursor-1",
		name: "Cursor号",
		platform: "CURSOR",
		credentials: { apiKey: "ck" },
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};
	return { client, account: acct, manager };
}

describe("SdkBridge（真子进程协议回环）", () => {
	it("文本回合：initialize 握手 → text_delta 转 chunk → done 出收尾（KNOWN usage）", async () => {
		const { client, account } = makeBridge("text");
		const chunks: Array<Record<string, unknown>> = [];
		await client.chatCompletionStream(
			account,
			{ model: "composer-1", messages: [{ role: "user", content: "hi" }] },
			(json) => {
				chunks.push(JSON.parse(json));
			},
		);
		expect(chunks.length).toBeGreaterThanOrEqual(5); // role / 你好 / 世界 / finish / usage
		expect((chunks[0]!.choices as Array<Record<string, unknown>>)[0]!.delta).toEqual({ role: "assistant" });
		expect((chunks[1]!.choices as Array<Record<string, unknown>>)[0]!.delta).toMatchObject({ content: "你好" });
		expect((chunks[2]!.choices as Array<Record<string, unknown>>)[0]!.delta).toMatchObject({ content: "世界" });
		const finishChunk = chunks[chunks.length - 2]!;
		expect((finishChunk.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("stop");
		const usageFrame = chunks[chunks.length - 1]!;
		expect(usageFrame.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
		expect(usageFrame.usage_source).toBe("KNOWN");
	});

	it("工具回合：DEFERRED 段带 call_gw 工具与 tool_calls finish，usage 为 -1 哨兵", async () => {
		const { client, account } = makeBridge("tool");
		const chunks: Array<Record<string, unknown>> = [];
		await client.chatCompletionStream(
			account,
			{ model: "composer-1", messages: [{ role: "user", content: "读文件" }] },
			(json) => {
				chunks.push(JSON.parse(json));
			},
		);
		const finishChunk = chunks[chunks.length - 2]!;
		expect((finishChunk.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("tool_calls");
		const usageFrame = chunks[chunks.length - 1]!;
		expect(usageFrame.usage).toEqual({ prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 });
		expect(usageFrame.usage_source).toBe("DEFERRED");
		// 工具调用出现在前面的 chunk
		const withTools = chunks.find((chunk) =>
			Array.isArray(
				((chunk.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown> | undefined)
					?.tool_calls,
			),
		);
		const call = ((withTools!.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>)
			.tool_calls as Array<Record<string, unknown>>;
		expect(call[0]?.function).toMatchObject({ name: "read_file", arguments: '{"path":"a.ts"}' });
		expect(String(call[0]?.id)).toMatch(/^call_gw_/);
	});

	it("非流式 = 流式聚合", async () => {
		const { client, account } = makeBridge("text");
		const completion = await client.chatCompletion(account, {
			model: "composer-1",
			messages: [{ role: "user", content: "hi" }],
		});
		expect((completion.choices as Array<Record<string, unknown>>)[0]!.message).toMatchObject({ content: "你好世界" });
	});
});
