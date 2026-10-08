import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { fileWasReadThisTurn } from "../src/core/tools/edit-read-gate.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "owl-known-write-"));
	directories.push(cwd);
	const path = join(cwd, "source.txt");
	await writeFile(path, "original\n");
	const messages: AgentMessage[] = [
		{ role: "user", content: "authorized edit", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "source.txt" } }],
		},
		{
			role: "toolResult",
			toolCallId: "read",
			toolName: "read",
			content: [{ type: "text", text: "original\n" }],
			isError: false,
			timestamp: 2,
		},
	] as AgentMessage[];
	const ctx = {
		cwd,
		sessionManager: { buildSessionProjection: () => ({ messages, entries: [], model: null, thinkingLevel: "off" }) },
	} as unknown as ExtensionToolContext;
	const writer = createWriteToolDefinition(cwd);
	const content = "known first\r\nsecond line\r\n";
	const result = await writer.execute("write-1", { path: "source.txt", content }, undefined, undefined, ctx);
	messages.push({
		role: "assistant",
		content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "source.txt", content } }],
	} as unknown as AgentMessage);
	messages.push({
		role: "toolResult",
		toolCallId: "write-1",
		toolName: "write",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: 3,
	} as AgentMessage);
	return { cwd, path, messages, ctx, writer, content };
}
describe("verified full-write baselines", () => {
	it("permits a second complete write from the same unchanged known bytes without pretending they were read", async () => {
		const f = await fixture();
		expect(fileWasReadThisTurn(f.messages, f.path, f.cwd)).toBe(false);
		await f.writer.execute(
			"write-2",
			{ path: "source.txt", content: "second version\n" },
			undefined,
			undefined,
			f.ctx,
		);
		expect(await readFile(f.path, "utf8")).toBe("second version\n");
	});
	it("permits a unique edit from the complete known write", async () => {
		const f = await fixture();
		const editor = createEditToolDefinition(f.cwd);
		await editor.execute(
			"edit-2",
			{ path: "source.txt", edits: [{ oldText: "known first", newText: "edited first" }] },
			undefined,
			undefined,
			f.ctx,
		);
		expect(await readFile(f.path, "utf8")).toBe("edited first\r\nsecond line\r\n");
	});
	it("rejects externally changed bytes and preserves that change", async () => {
		const f = await fixture();
		await writeFile(f.path, "external revision\n");
		await expect(
			f.writer.execute("write-2", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
		expect(await readFile(f.path, "utf8")).toBe("external revision\n");
	});
	it("does not reuse a previous user turn or a compacted call", async () => {
		const f = await fixture();
		f.messages.push({ role: "user", content: "new request", timestamp: 4 });
		await expect(
			f.writer.execute("write-2", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
		f.messages.splice(0, f.messages.length, {
			role: "user",
			content: "same content was written earlier",
			timestamp: 5,
		});
		await expect(
			f.writer.execute("write-3", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
	});
	it("requires explicit read for a remote writer without raw-byte verification", async () => {
		const f = await fixture();
		const remote = createWriteToolDefinition(f.cwd, {
			operations: { writeFile: async () => {}, mkdir: async () => {}, exists: async () => true },
		});
		await expect(
			remote.execute("write-2", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
	});
	it.each(["failed", "wrong-tool", "missing-content", "binary", "invalid-utf8"])(
		"does not treat %s write records as a known text version",
		async (kind) => {
			const f = await fixture();
			const assistant = f.messages[3];
			const result = f.messages[4];
			if (assistant?.role !== "assistant" || result?.role !== "toolResult") throw new Error("bad fixture");
			const call = assistant.content[0];
			if (call?.type !== "toolCall") throw new Error("bad fixture call");
			f.messages.splice(1, 2);
			if (kind === "failed") result.isError = true;
			if (kind === "wrong-tool") result.toolName = "bash";
			if (kind === "missing-content") delete call.arguments.content;
			if (kind === "binary" || kind === "invalid-utf8") {
				const content = kind === "binary" ? "a\0b" : "a\ud800b";
				call.arguments.content = content;
				await writeFile(f.path, content);
			}
			await expect(
				f.writer.execute("next", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
			).rejects.toThrow(/read/);
		},
	);
	it("invalidates the known write after another edit even if bytes happen to match", async () => {
		const f = await fixture();
		f.messages.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "later", name: "edit", arguments: { path: "source.txt" } }],
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "later",
				toolName: "edit",
				content: [],
				isError: false,
				timestamp: 4,
			} as AgentMessage,
		);
		await expect(
			f.writer.execute("next", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
	});
	it("does not promote omitted nested write arguments into a known full version", async () => {
		const f = await fixture();
		f.messages.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "parent", name: "functions", arguments: {} }],
			} as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "parent",
				toolName: "functions",
				content: [],
				isError: false,
				timestamp: 4,
				nestedCalls: {
					complete: false,
					calls: [
						{
							id: "nested-write",
							name: "write",
							status: "ok",
							fileMutationPath: "source.txt",
							completionOrder: 1,
						},
					],
				},
			} as AgentMessage,
		);
		await expect(
			f.writer.execute("next", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
	});
	it("keeps uniqueness checks for edits based on a known full write", async () => {
		const f = await fixture();
		const editor = createEditToolDefinition(f.cwd);
		await expect(
			editor.execute(
				"edit",
				{
					path: "source.txt",
					edits: [
						{ oldText: "line", newText: "change" },
						{ oldText: "second line", newText: "other" },
					],
				},
				undefined,
				undefined,
				f.ctx,
			),
		).rejects.toThrow(/overlap/);
		expect(await readFile(f.path, "utf8")).toBe(f.content);
	});
	it("invalidates a baseline when a still-active parent has unrecorded file accesses", async () => {
		const f = await fixture();
		f.messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: "parent", name: "functions", arguments: {} }],
		} as unknown as AgentMessage);
		f.ctx.getPendingNestedToolCalls = () => [
			{ parentToolCallId: "parent", calls: { calls: [], complete: false, fileAccessComplete: false } },
		];
		await expect(
			f.writer.execute("next", { path: "source.txt", content: "unsafe" }, undefined, undefined, f.ctx),
		).rejects.toThrow(/read/);
	});
	it("allows a verified baseline after a completed mutation of a different file", async () => {
		const f = await fixture();
		f.messages.push(
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "other", name: "write", arguments: { path: "other.txt", content: "unrelated" } },
				],
			} as unknown as AgentMessage,
			{ role: "toolResult", toolCallId: "other", toolName: "write", content: [], isError: false, timestamp: 4 },
		);
		await f.writer.execute("next", { path: "source.txt", content: "safe" }, undefined, undefined, f.ctx);
		expect(await readFile(f.path, "utf8")).toBe("safe");
	});
});
