import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { pathCorrectionNote } from "../../src/core/tools/path-utils.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup() {
	const harness = await createHarness({
		initialActiveToolNames: ["read", "write", "edit", "codemode"],
		extensionFactories: [createCodemodeExtension()],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const directory = join(harness.tempDir, "资料 空间");
	await mkdir(directory);
	const actual = join(directory, "file.txt");
	const requested = join(directory, "invented", "file.txt");
	await writeFile(actual, "old text\nsecond line\n");
	return { harness, actual, requested, directory };
}

describe("corrected read evidence", () => {
	it.each([false, true])("combines real paginated CRLF reads before rewrite (corrected=%s)", async (corrected) => {
		const { harness, requested, actual } = await setup();
		await writeFile(actual, "l1\r\nl2\r\nl3\r\nl4\r\n");
		const path = corrected ? requested : actual;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path, limit: 2 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path, offset: 3 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path: actual, content: "replacement\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read the whole file in two pages and then rewrite it.");
		expect(getToolResult(harness, "write").isError, getMessageText(getToolResult(harness, "write"))).toBe(false);
		expect(await readFile(actual, "utf8")).toBe("replacement\n");
	});

	it("preserves literal path notices in file content when removing the generated notice", async () => {
		const { harness, requested, actual } = await setup();
		const original = `${pathCorrectionNote(requested, actual)}\nliteral source text\n`;
		await writeFile(actual, original);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: requested }), { stopReason: "toolUse" }),
			fauxAssistantMessage("read complete"),
			fauxAssistantMessage(fauxToolCall("write", { path: actual, content: original + "updated\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read the file.");
		await harness.session.prompt("Append the update while preserving the original contents.");
		expect(getToolResult(harness, "write").isError).toBe(false);
		expect(await readFile(actual, "utf8")).toBe(original + "updated\n");
	});

	it.each([false, true])("allows a full corrected read before a rewrite (next user turn=%s)", async (nextTurn) => {
		const { harness, requested, actual } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: requested }), { stopReason: "toolUse" }),
			...(nextTurn ? [fauxAssistantMessage("Read complete.")] : []),
			fauxAssistantMessage(fauxToolCall("write", { path: actual, content: "updated\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read and rewrite the file.");
		if (nextTurn) await harness.session.prompt("Now rewrite the same unchanged file.");
		expect(getToolResult(harness, "read").isError).toBe(false);
		expect(getToolResult(harness, "write").isError, getMessageText(getToolResult(harness, "write"))).toBe(false);
		expect(await readFile(actual, "utf8")).toBe("updated\n");
	});

	it("preserves the resolved path for nested read and write in the same codemode call", async () => {
		const { harness, requested, actual } = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.read({path:${JSON.stringify(requested)}}); await tools.write({path:${JSON.stringify(actual)},content:"updated\\n"});`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read and then rewrite with codemode.");
		const result = getToolResult(harness, "codemode");
		expect(result.isError, getMessageText(result)).toBe(false);
		expect(result.nestedCalls?.calls.map((call) => call.status)).toEqual(["ok", "ok"]);
		expect(await readFile(actual, "utf8")).toBe("updated\n");
	});

	it.each(["partial", "directory", "changed"])("does not allow a rewrite from %s corrected evidence", async (kind) => {
		const { harness, requested, actual, directory } = await setup();
		const path = kind === "directory" ? join(harness.tempDir, "invented", "资料 空间") : requested;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path, ...(kind === "partial" ? { limit: 1 } : {}) }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("read complete"),
		]);
		await harness.session.prompt("Inspect the current file.");
		expect(getToolResult(harness, "read").isError).toBe(false);
		if (kind === "changed") await writeFile(actual, "external changes\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: actual, content: "must not overwrite" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("blocked"),
		]);
		await harness.session.prompt(`Rewrite ${directory}.`);
		expect(getToolResult(harness, "write").isError).toBe(true);
		expect(await readFile(actual, "utf8")).toBe(
			kind === "changed" ? "external changes\n" : "old text\nsecond line\n",
		);
	});
});
