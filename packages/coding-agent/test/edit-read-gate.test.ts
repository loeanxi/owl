import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { fileWasReadThisTurn } from "../src/core/tools/edit-read-gate.ts";
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

describe("edit tool read gate", () => {
	it("edits text that was in this turn's read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(readMessages(file, { text: "old text" })),
		} as ExtensionToolContext;

		await tool.execute(
			"edit-1",
			{ path: file, edits: [{ oldText: "old", newText: "new" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(await readFile(file, "utf-8")).toBe("new text");
	});

	it("refuses oldText that the read did not show", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "alpha\nbeta\n");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session(
				readMessages(file, { text: "alpha\n\n[Showing lines 1-1 of 2. Use offset=2 to continue.]" }),
			),
		} as ExtensionToolContext;

		await expect(
			tool.execute(
				"edit-1",
				{ path: file, edits: [{ oldText: "beta", newText: "BETA" }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/was not in a read/);
		expect(await readFile(file, "utf-8")).toBe("alpha\nbeta\n");
	});

	it("refuses another edit after this turn already changed the file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([...readMessages(file, { text: "old text" }), ...mutationMessages("edit", file)]),
		} as ExtensionToolContext;

		await expect(
			tool.execute("edit-2", { path: file, edits: [{ oldText: "old", newText: "new" }] }, undefined, undefined, ctx),
		).rejects.toThrow(/has not been read in this turn/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});

	it("edits again after a fresh read of the changed file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "new text");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([
				...readMessages(file, { id: "read-old", text: "old text" }),
				...mutationMessages("edit", file),
				...readMessages(file, { id: "read-new", text: "new text" }),
			]),
		} as ExtensionToolContext;

		await tool.execute(
			"edit-2",
			{ path: "a.txt", edits: [{ oldText: "new", newText: "done" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(await readFile(file, "utf-8")).toBe("done text");
	});

	it("refuses to edit when this turn has no successful read and does not change the file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		await writeFile(file, "old text");
		const tool = createEditToolDefinition(dir);
		const ctx = {
			cwd: dir,
			sessionManager: session([{ role: "user", content: "edit it", timestamp: 1 } as AgentMessage]),
		} as ExtensionToolContext;

		await expect(
			tool.execute("edit-1", { path: file, edits: [{ oldText: "old", newText: "new" }] }, undefined, undefined, ctx),
		).rejects.toThrow(/has not been read in this turn/);
		expect(await readFile(file, "utf-8")).toBe("old text");
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
		).rejects.toThrow(/did not read the whole file/);
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
		).rejects.toThrow(/did not read the whole file/);
		expect(await readFile(file, "utf-8")).toBe("old text");
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
		).rejects.toThrow(/has not been read in this turn/);
		expect(await readFile(file, "utf-8")).toBe("old text");
	});
});
