import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { fileWasReadThisTurn, GATE_SNAPSHOT_MARKER } from "../src/core/tools/edit-read-gate.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-read-gate-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function readMessages(
	path: string,
	options?: { isError?: boolean; id?: string; text?: string; offset?: number },
): AgentMessage[] {
	const id = options?.id ?? "read-1";
	const args: { path: string; offset?: number } = { path };
	if (options?.offset !== undefined) args.offset = options.offset;
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: args }],
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: options?.text ?? "file body" }],
			isError: options?.isError ?? false,
			timestamp: 1,
		} as AgentMessage,
	];
}

function mutationMessages(name: "edit" | "write", path: string, id = "mut-1"): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: { path } }],
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "Successfully" }],
			isError: false,
			timestamp: 2,
		} as AgentMessage,
	];
}

function editMessages(path: string, edits: { oldText: string; newText: string }[], id = "edit-done"): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "edit", arguments: { path, edits } }],
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "edit",
			content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
			isError: false,
			timestamp: 2,
		} as AgentMessage,
	];
}

function writeMessages(path: string, content: string, id = "write-done"): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "write", arguments: { path, content } }],
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "write",
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
			isError: false,
			timestamp: 2,
		} as AgentMessage,
	];
}

function bashMessages(command: string, output: string, id = "bash-1"): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: 2,
		} as AgentMessage,
	];
}

function session(messages: AgentMessage[]): ExtensionToolContext["sessionManager"] {
	return {
		buildSessionProjection: () => ({
			entries: [],
			messages,
			thinkingLevel: "off",
			model: null,
		}),
	} as unknown as ExtensionToolContext["sessionManager"];
}

describe("fileWasReadThisTurn", () => {
	it("accepts a successful read after the latest user message", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "file body");
		const messages = [
			{ role: "user", content: "earlier", timestamp: 1 } as AgentMessage,
			...readMessages(file, { id: "old" }),
			{ role: "user", content: "now", timestamp: 2 } as AgentMessage,
			...readMessages("a.txt"),
		];
		expect(fileWasReadThisTurn(messages, file, dir)).toBe(true);
	});

	it("rejects a read from the previous turn", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "file body");
		const messages = [...readMessages(file), { role: "user", content: "edit it", timestamp: 2 } as AgentMessage];
		expect(fileWasReadThisTurn(messages, file, dir)).toBe(false);
	});

	it("rejects a failed read and a read of a different file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		const other = join(dir, "b.txt");
		await writeFile(file, "file body");
		await writeFile(other, "other");
		expect(fileWasReadThisTurn(readMessages(file, { isError: true }), file, dir)).toBe(false);
		expect(fileWasReadThisTurn(readMessages(other), file, dir)).toBe(false);
	});

	it("rejects a read that compaction removed from the projection", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "file body");
		const messages = [
			{ role: "compactionSummary", summary: "read a.txt earlier", tokensBefore: 10, timestamp: 1 } as AgentMessage,
			{ role: "user", content: "continue", timestamp: 2 } as AgentMessage,
		];
		expect(fileWasReadThisTurn(messages, file, dir)).toBe(false);
	});

	it("drops a read that happened before an edit of the same file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "file body");
		const messages = [...readMessages(file), ...mutationMessages("edit", file)];
		expect(fileWasReadThisTurn(messages, file, dir)).toBe(false);
	});
});

describe("edit tool without a read", () => {
	it("edits an existing file that this session never read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text\r\nsecond\r\n");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([{ role: "user", content: "edit it", timestamp: 1 } as AgentMessage]),
		} as ExtensionToolContext;

		await tool.execute(
			"edit-1",
			{ path: file, edits: [{ oldText: "old", newText: "new" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(await readFile(file, "utf-8")).toBe("new text\r\nsecond\r\n");
	});

	it("edits a file that changed on disk after the last read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "changed outside\n");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(readMessages(file, { text: "old text\n" })),
		} as ExtensionToolContext;

		await tool.execute(
			"edit-1",
			{ path: file, edits: [{ oldText: "outside", newText: "inside" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(await readFile(file, "utf-8")).toBe("changed inside\n");
	});

	it("reports oldText that is not in the file as not found and leaves the file alone", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "// 如果为null，说明没有异常消息，结束循环\nbreak;\n");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([{ role: "user", content: "edit it", timestamp: 1 } as AgentMessage]),
		} as ExtensionToolContext;

		const failure = tool.execute(
			"edit-1",
			{ path: file, edits: [{ oldText: "// 如果没有异常消息，结束循环\nbreak;", newText: "return;" }] },
			undefined,
			undefined,
			ctx,
		);
		await expect(failure).rejects.toThrow(/Could not find the exact text/);
		await expect(failure).rejects.toThrow(/Line endings are normalized/);
		expect(await readFile(file, "utf-8")).toBe("// 如果为null，说明没有异常消息，结束循环\nbreak;\n");
	});

	it("still edits when the call has no session", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createEditToolDefinition(dir);

		await tool.execute(
			"edit-1",
			{ path: file, edits: [{ oldText: "old", newText: "new" }] },
			undefined,
			undefined,
			undefined as unknown as ExtensionToolContext,
		);

		expect(await readFile(file, "utf-8")).toBe("new text");
	});
});

describe("write tool read gate across edits and shell output", () => {
	it("carries a read across its own edits, so a later overwrite needs no re-read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "class A {\r\n  int x;\r\n  // done\r\n}\r\n");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...readMessages(file, { text: "class A {\n  int y;\n  // todo\n}\n" }),
				...editMessages(file, [
					{ oldText: "int y;", newText: "int x;" },
					{ oldText: "// todo", newText: "// done" },
				]),
			]),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("keeps an earlier-turn read current across a fuzzy edit of fullwidth text", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, '名称（name）\nsay "bye"\nvalue = 1\n');
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				{ role: "user", content: "look at it", timestamp: 1 } as AgentMessage,
				...readMessages(file, { text: "名称（name）\nsay “hi”\nvalue = 1\n" }),
				{ role: "user", content: "继续", timestamp: 3 } as AgentMessage,
				...editMessages(file, [{ oldText: 'say "hi"', newText: 'say "bye"' }]),
			]),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("counts cat output of the whole file as a read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "Service.java");
		await writeFile(file, "interface Service {\n    void run();\n}\n");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(
				bashMessages("cd src && cat Service.java", "interface Service {\n    void run();\n}\n"),
			),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("ignores shell output of a command that does not name the file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(bashMessages("cat other.txt", "old text")),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/no read of its current content/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});

	it("refuses an earlier-turn read after the file changed on disk and attaches the current content", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "changed outside\n");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...readMessages(file, { text: "old text\n" }),
				{ role: "user", content: "继续", timestamp: 3 } as AgentMessage,
			]),
		} as ExtensionToolContext;

		const failure = tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx);
		await expect(failure).rejects.toThrow(/no read of its current content/);
		await expect(failure).rejects.toThrow(GATE_SNAPSHOT_MARKER);
		await expect(failure).rejects.toThrow(/changed outside/);
		expect(await readFile(file, "utf-8")).toBe("changed outside\n");
	});

	it("treats the content attached to a refusal as a read, so the retry succeeds", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text\n");
		const tool = createWriteToolDefinition(dir);
		const messages: AgentMessage[] = [{ role: "user", content: "rewrite it", timestamp: 1 } as AgentMessage];
		const ctx = { cwd: dir, sessionManager: session(messages) } as ExtensionToolContext;
		const args = { path: file, content: "rewritten" };

		const refusal = await tool.execute("write-1", args, undefined, undefined, ctx).then(
			() => undefined,
			(error: Error) => error.message,
		);
		expect(refusal).toContain(GATE_SNAPSHOT_MARKER);
		messages.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "write-1", name: "write", arguments: args }],
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "write-1",
				toolName: "write",
				content: [{ type: "text", text: refusal }],
				isError: true,
				timestamp: 2,
			} as AgentMessage,
		);

		await tool.execute("write-2", args, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});
});

describe("write tool read gate", () => {
	it("overwrites an existing file after it was read this turn", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = { cwd: dir, sessionManager: session(readMessages(file)) } as ExtensionToolContext;

		await tool.execute("write-1", { path: "a.txt", content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("refuses to overwrite an existing file that was not read this turn", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([{ role: "user", content: "rewrite it", timestamp: 1 } as AgentMessage]),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/Refusing to overwrite/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});

	it("overwrites after a full read from an earlier turn while the file is unchanged", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...readMessages(file, { text: "old text" }),
				{ role: "user", content: "rewrite it", timestamp: 3 } as AgentMessage,
			]),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: "a.txt", content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("overwrites its own written and edited file without a read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "first\nline2\n");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				{ role: "user", content: "create it", timestamp: 1 } as AgentMessage,
				...writeMessages(file, "line1\nline2\n"),
				...editMessages(file, [{ oldText: "line1", newText: "first" }]),
			]),
		} as ExtensionToolContext;

		await tool.execute("write-2", { path: file, content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("overwrites after an earlier-turn cat printed the whole unchanged file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text\nsecond\n");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...bashMessages("cat a.txt; echo ---", "old text\nsecond\n---\n"),
				{ role: "user", content: "rewrite it", timestamp: 3 } as AgentMessage,
			]),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: "a.txt", content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("creates a new file without a read", async () => {
		const dir = await createTempDir();
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([{ role: "user", content: "create it", timestamp: 1 } as AgentMessage]),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: "new.txt", content: "created" }, undefined, undefined, ctx);

		expect(await readFile(join(dir, "new.txt"), "utf-8")).toBe("created");
	});

	it("refuses to overwrite a read that started past the first line", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(readMessages(file, { text: "text", offset: 2 })),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/no read of the whole current file/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});

	it("refuses to overwrite after a partial read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(
				readMessages(file, { text: "old\n\n[Showing lines 1-1 of 2. Use offset=2 to continue.]" }),
			),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/no read of the whole current file/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});

	it("overwrites after offset reads that together cover the whole file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "l1\r\nl2\r\nl3\r\nl4\r\n");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				{ role: "user", content: "rewrite it", timestamp: 1 } as AgentMessage,
				...readMessages(file, {
					id: "r1",
					text: "l1\r\nl2\r\n\n[3 more lines in file. Use offset=3 to continue.]",
				}),
				...readMessages(file, { id: "r2", offset: 3, text: "l3\r\nl4\r\n" }),
			]),
		} as ExtensionToolContext;

		await tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("refuses offset reads that leave a gap", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "l1\nl2\nl3\nl4");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...readMessages(file, { id: "r1", text: "l1\n\n[3 more lines in file. Use offset=2 to continue.]" }),
				...readMessages(file, { id: "r2", offset: 3, text: "l3\nl4" }),
			]),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/no read of the whole current file/);
		expect(await readFile(file, "utf-8")).toBe("l1\nl2\nl3\nl4");
	});

	it("refuses offset reads whose text no longer matches the file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "l1\nl2\nchanged\nl4");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...readMessages(file, { id: "r1", text: "l1\nl2\n\n[2 more lines in file. Use offset=3 to continue.]" }),
				...readMessages(file, { id: "r2", offset: 3, text: "l3\nl4" }),
			]),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/no read of the whole current file/);
	});

	it("combines a truncated refusal snapshot with the follow-up offset read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		const lines = Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`);
		await writeFile(file, lines.join("\n"));
		const tool = createWriteToolDefinition(dir);
		const messages: AgentMessage[] = [{ role: "user", content: "rewrite it", timestamp: 1 } as AgentMessage];
		const ctx = { cwd: dir, sessionManager: session(messages) } as ExtensionToolContext;
		const args = { path: file, content: "rewritten" };

		const refusal = await tool.execute("write-1", args, undefined, undefined, ctx).then(
			() => "",
			(error: Error) => error.message,
		);
		const next = /Use read with offset=(\d+)/.exec(refusal);
		expect(next).not.toBeNull();
		const offset = Number(next![1]);
		messages.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "write-1", name: "write", arguments: args }],
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "write-1",
				toolName: "write",
				content: [{ type: "text", text: refusal }],
				isError: true,
				timestamp: 2,
			} as AgentMessage,
			...readMessages(file, { id: "r-rest", offset, text: lines.slice(offset - 1).join("\n") }),
		);

		await tool.execute("write-2", args, undefined, undefined, ctx);

		expect(await readFile(file, "utf-8")).toBe("rewritten");
	});

	it("refuses to overwrite a file this turn already changed", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createWriteToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([...readMessages(file, { text: "old text" }), ...mutationMessages("edit", file)]),
		} as ExtensionToolContext;

		await expect(
			tool.execute("write-1", { path: file, content: "rewritten" }, undefined, undefined, ctx),
		).rejects.toThrow(/no read of its current content/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});
});
