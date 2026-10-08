import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOL_NAMES } from "../../src/core/settings-manager.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("nested read evidence for file changes", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	async function makeHarness(extra: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: [...DEFAULT_TOOL_NAMES, "codemode"],
			extensionFactories: [createCodemodeExtension()],
			...extra,
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		await writeFile(join(harness.tempDir, "file.txt"), "old text\n");
		return harness;
	}

	it.each(["edit", "write"])("accepts a successful codemode read before a nested %s", async (name) => {
		const harness = await makeHarness();
		const args =
			name === "edit"
				? { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] }
				: { path: "file.txt", content: "new text\n" };
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.read({ path: "file.txt" }); await tools.${name}(${JSON.stringify(args)});`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read and change the file.");

		const result = getToolResult(harness, "codemode");
		expect(getMessageText(result)).not.toContain("Refusing to");
		expect(result.isError).toBe(false);
		expect(result.nestedCalls?.calls.map((call) => [call.name, call.status])).toEqual([
			["read", "ok"],
			[name, "ok"],
		]);
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe("new text\n");
	});

	it.each([false, true])("keeps completed read evidence when the parent fails: %s", async (failParent) => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.read({ path: "file.txt" }); ${failParent ? 'throw new Error("later script failure");' : ""}`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("edit", { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read, then change the file.");
		expect(getToolResult(harness, "codemode").isError).toBe(failParent);
		expect(getToolResult(harness, "edit").isError).toBe(false);
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe("new text\n");
	});

	it.each([false, true])("requires a fresh read after a nested edit; fresh read: %s", async (freshRead) => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.read({ path: "file.txt" });
await tools.edit({ path: "file.txt", edits: [{ oldText: "old", newText: "new" }] });
${freshRead ? 'await tools.read({ path: "file.txt" });' : ""}
await tools.edit({ path: "file.txt", edits: [{ oldText: "new", newText: "done" }] });`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Change the file twice.");
		expect(getToolResult(harness, "codemode").isError).toBe(!freshRead);
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe(freshRead ? "done text\n" : "new text\n");
	});

	it.each([{ limit: 1 }, { offset: 2 }])("refuses overwrites after a limited nested read: %j", async (options) => {
		const harness = await makeHarness();
		await writeFile(join(harness.tempDir, "file.txt"), "old text\nsecond line\n");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.read(${JSON.stringify({ path: "file.txt", ...options })});
await tools.write({ path: "file.txt", content: "replacement" });`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Rewrite the file.");
		expect(getToolResult(harness, "codemode").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "codemode"))).toContain("did not read the whole file");
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe("old text\nsecond line\n");
	});

	it("does not carry a nested read into a later user turn", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: 'await tools.read({ path: "file.txt" });' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("read complete"),
			fauxAssistantMessage(fauxToolCall("write", { path: "file.txt", content: "replacement" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read the file.");
		await harness.session.prompt("Rewrite it now.");
		expect(getToolResult(harness, "write").isError).toBe(true);
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe("old text\n");
	});

	it("keeps nested read evidence on resume of the same user turn", async () => {
		const original = await makeHarness();
		const path = join(original.tempDir, "file.txt");
		original.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: `await tools.read({ path: ${JSON.stringify(path)} });` }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("paused"),
		]);
		await original.session.prompt("Read the file and pause.");
		original.session.dispose();

		const resumed = await makeHarness({ sessionManager: original.sessionManager });
		resumed.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "resumed text\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await resumed.session.resumeAfterPause("Continue changing the file.");
		expect(getToolResult(resumed, "write").isError).toBe(false);
		expect(await readFile(path, "utf8")).toBe("resumed text\n");
	});

	it("does not trust nested read metadata removed from the projection by compaction", async () => {
		const original = await makeHarness();
		const path = join(original.tempDir, "file.txt");
		original.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: `await tools.read({ path: ${JSON.stringify(path)} });` }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("paused"),
		]);
		await original.session.prompt("Read and pause.");
		const kept = original.sessionManager.getLeafId()!;
		original.sessionManager.appendCompaction("Earlier work summarized.", kept, 100);
		original.session.dispose();
		const resumed = await makeHarness({ sessionManager: original.sessionManager });
		resumed.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "unexpected" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await resumed.session.resumeAfterPause("Continue changing the file.");
		expect(getToolResult(resumed, "write").isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("old text\n");
	});

	it.each(["missing.txt", "other.txt"])("does not authorize file.txt using a nested read of %s", async (path) => {
		const harness = await makeHarness();
		await writeFile(join(harness.tempDir, "other.txt"), "old text\n");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `try { await tools.read({ path: ${JSON.stringify(path)} }); } catch {}
await tools.write({ path: "file.txt", content: "unexpected" });`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Rewrite file.txt.");
		expect(getToolResult(harness, "codemode").isError).toBe(true);
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe("old text\n");
	});

	it("expires a nested read after a write whose arguments exceed the recording limit", async () => {
		const harness = await makeHarness();
		const content = `old ${"x".repeat(9000)}`;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.read({ path: "file.txt" }); await tools.write(${JSON.stringify({ path: "file.txt", content })});`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("edit", { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Write a long file, then attempt another edit.");
		const result = getToolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		expect(result.nestedCalls?.calls[1].arguments).toBeUndefined();
		expect(result.nestedCalls?.calls[1].fileMutationPath).toBe("file.txt");
		expect(getToolResult(harness, "edit").isError).toBe(true);
		expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe(content);
	});

	it.each([false, true])(
		"does not revive a pending parent's old read after a parallel write; delayed read: %s",
		async (delayRead) => {
			let readCompleted!: () => void;
			let writeCompleted!: () => void;
			const readDone = new Promise<void>((resolveRead) => {
				readCompleted = resolveRead;
			});
			const writeDone = new Promise<void>((resolveWrite) => {
				writeCompleted = resolveWrite;
			});
			const definition = createWriteToolDefinition(process.cwd());
			const readDefinition = createReadToolDefinition(process.cwd());
			const harness = await makeHarness({
				initialActiveToolNames: [...DEFAULT_TOOL_NAMES, "read_then_edit"],
				extensionFactories: [
					(pi) => {
						if (delayRead) {
							pi.registerTool({
								...readDefinition,
								async execute(...args) {
									const result = await readDefinition.execute(...args);
									if (!args[0].includes("/")) return result;
									readCompleted();
									await writeDone;
									return result;
								},
							});
						}
						pi.registerTool({
							name: "read_then_edit",
							label: "Read then edit",
							description: "Wait for another tool after reading, then edit without a new read.",
							parameters: Type.Object({}),
							async execute(_id, _args, _signal, _onUpdate, ctx) {
								await ctx.executeTool("read", { path: "file.txt" });
								readCompleted();
								await writeDone;
								const outcome = await ctx.executeTool("edit", {
									path: "file.txt",
									edits: [{ oldText: "old", newText: "unexpected" }],
								});
								return { ...outcome.result, isError: outcome.isError };
							},
						});
						pi.registerTool({
							...definition,
							async execute(...args) {
								await readDone;
								return definition.execute(...args);
							},
						});
					},
				],
			});
			harness.session.subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolName === "write" && !("parentToolCallId" in event)) {
					writeCompleted();
				}
			});
			harness.setResponses([
				// An earlier read authorizes the other direct write even while the delayed read is running.
				fauxAssistantMessage(fauxToolCall("read", { path: "file.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[
						fauxToolCall("read_then_edit", {}),
						fauxToolCall("write", { path: "file.txt", content: "old text plus a parallel change\n" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Run both file operations together.");
			expect(getToolResult(harness, "write").isError).toBe(false);
			expect(getToolResult(harness, "read_then_edit").isError).toBe(true);
			expect(await readFile(join(harness.tempDir, "file.txt"), "utf8")).toBe("old text plus a parallel change\n");
		},
	);
});
