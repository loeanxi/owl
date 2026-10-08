import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { currentTurnReads, readResultEvidence } from "../src/core/tools/edit-read-gate.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "owl-read-directory-"));
	roots.push(root);
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "a.txt"), "real file content");
	await writeFile(join(root, "b.txt"), "second");
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) {
		if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-read-directory-"))
			throw new Error("Unsafe cleanup target");
		await rm(root, { recursive: true, force: true });
	}
});
it("lists a directory, paginates, and still reads child content", async () => {
	const root = await fixture();
	const reader = createReadToolDefinition(root);
	const ctx = { cwd: root } as ExtensionToolContext;
	const first = await reader.execute("listing", { path: root, limit: 1 }, undefined, undefined, ctx);
	expect(first.details?.directory).toBe(true);
	expect(first.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"a.txt"') })]);
	expect(first.content).toEqual([expect.objectContaining({ text: expect.stringContaining("offset=2") })]);
	const second = await reader.execute("listing2", { path: root, offset: 2 }, undefined, undefined, ctx);
	expect(second.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"nested/"') })]);
	const file = await reader.execute("file", { path: join(root, "a.txt") }, undefined, undefined, ctx);
	expect(file.content).toEqual([{ type: "text", text: "real file content" }]);
});
it("never treats a directory listing as file-read evidence", async () => {
	const root = await fixture();
	const result = await createReadToolDefinition(root).execute("listing", { path: root }, undefined, undefined, {
		cwd: root,
	} as ExtensionToolContext);
	const messages: AgentMessage[] = [
		{ role: "user", content: "inspect", timestamp: 1 },
		fauxAssistantMessage([{ type: "toolCall", id: "listing", name: "read", arguments: { path: root } }]),
		{
			role: "toolResult",
			toolCallId: "listing",
			toolName: "read",
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: 2,
		} as AgentMessage,
	];
	expect(readResultEvidence(result.content, undefined).fullFile).toBe(false);
	expect(currentTurnReads(messages, root, root)).toEqual([]);
});
it("does not inspect the local filesystem for a remote adapter", async () => {
	let remoteReads = 0;
	const reader = createReadToolDefinition("/", {
		operations: {
			access: async () => {},
			readFile: async () => {
				remoteReads++;
				return Buffer.from("remote contents");
			},
		},
	});
	const result = await reader.execute(
		"remote",
		{ path: "/remote-only/file.txt" },
		undefined,
		undefined,
		{} as ExtensionToolContext,
	);
	expect(remoteReads).toBe(1);
	expect(result.content).toEqual([{ type: "text", text: "remote contents" }]);
});
