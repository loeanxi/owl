import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEntry, ToolCard } from "./transcript.ts";
import { rebuild } from "./transcript.ts";
import { attachmentPathKey, collectAttachmentReceipts } from "./attachment-receipts.ts";
import { createReadTool } from "../../../../packages/coding-agent/src/core/tools/read.ts";

const user = (path = "a.ts", queued = false): ChatEntry => ({ kind: "user", text: "请检查材料", attachedPaths: [path], ...(queued ? { queued } : {}) });
const read = (overrides: Partial<ToolCard> = {}): ToolCard => ({ id: "read-one", name: "read", args: JSON.stringify({ path: "a.ts" }), summary: "读取a.ts", status: "ok", output: { text: "first\nsecond\n", totalLines: 3 }, ...overrides });
const assistant = (...tools: ToolCard[]): ChatEntry => ({ kind: "assistant", text: "已经全部理解了", thinking: "", tools });
const receipt = (tool?: ToolCard) => collectAttachmentReceipts([user(), assistant(...(tool ? [tool] : []))], "D:/project").get(0)![0];

describe("attachment read receipts from actual current-turn tools", () => {
	it("uses a real native read result through transcript replay, including its exact continuation range", async () => {
		const directory = mkdtempSync(join(tmpdir(), "owl-attachment-receipt-"));
		try {
			writeFileSync(join(directory, "a.ts"), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
			const tool = createReadTool(directory);
			const result = await tool.execute("native-read", { path: "a.ts", offset: 4, limit: 2 });
			const entries = rebuild([{ role: "user", content: "[Attached files for this turn]\n- a.ts\n\n读取材料" }, { role: "assistant", content: [{ type: "toolCall", id: "native-read", name: "read", arguments: { path: "a.ts", offset: 4, limit: 2 } }] }, { role: "toolResult", toolCallId: "native-read", toolName: "read", content: result.content, details: result.details, isError: false }]);
			const receipt = collectAttachmentReceipts(entries, directory).get(0)![0];
			expect(receipt.status).toBe("partial"); expect(receipt.evidence[0].range).toEqual({ start: 4, end: 5, total: 10, limit: 2 });
			const listing = await tool.execute("native-directory", { path: directory });
			const directoryEntries = rebuild([{ role: "user", content: `[Attached files for this turn]\n- ${directory}\n\n查看目录` }, { role: "assistant", content: [{ type: "toolCall", id: "native-directory", name: "read", arguments: { path: directory } }] }, { role: "toolResult", toolCallId: "native-directory", toolName: "read", content: listing.content, details: listing.details, isError: false }]);
			expect(collectAttachmentReceipts(directoryEntries, directory).get(0)![0].evidence[0].note).toBe("directory");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
	it("does not use prose, shell output, a basename match or a historical read as evidence", () => {
		const entries = [user(), assistant(read()), user(), assistant(read({ name: "bash", output: { text: "cat a.ts\nall read", totalLines: 2 } }), read({ id: "other", args: JSON.stringify({ path: "other/a.ts" }) }))];
		expect(collectAttachmentReceipts(entries, "D:/project").get(0)![0].status).toBe("returned");
		expect(collectAttachmentReceipts(entries, "D:/project").get(2)![0]).toEqual({ path: "a.ts", status: "referenced", evidence: [] });
	});
	it("distinguishes pending, running, returned, failure, cancellation and missing nested output", () => {
		expect(receipt(read({ status: "pending", output: undefined })).status).toBe("referenced");
		expect(receipt(read({ status: "running" })).status).toBe("reading");
		expect(receipt(read()).status).toBe("returned");
		expect(receipt(read({ status: "error", output: { text: "ENOENT", totalLines: 1 } })).evidence[0].error).toBe("ENOENT");
		expect(receipt(read({ status: "cancelled" })).status).toBe("unknown");
		expect(receipt(read({ parentToolCallId: "codemode", output: undefined })).evidence[0].note).toBe("missingOutput");
	});
	it("shows exact native read truncation range without claiming complete content", () => {
		const result = receipt(read({ args: JSON.stringify({ path: "a.ts", offset: 10, limit: 2000 }), output: { text: "body\n\n[Showing lines 10-19 of 100 (50.0KB limit). Use offset=20 to continue.]", totalLines: 3 } }));
		expect(result.status).toBe("partial"); expect(result.evidence[0].range).toEqual({ start: 10, end: 19, total: 100, limit: 2000 });
	});
	it("handles native explicit-limit remainder and offset-only reads", () => {
		const result = receipt(read({ args: JSON.stringify({ path: "a.ts", offset: 4, limit: 2 }), output: { text: "x\ny\n\n[5 more lines in file. Use offset=6 to continue.]", totalLines: 4 } }));
		expect(result.evidence[0].range).toEqual({ start: 4, end: 5, total: 10, limit: 2 });
		expect(receipt(read({ args: JSON.stringify({ path: "a.ts", offset: 4 }) })).status).toBe("partial");
	});
	it("does not treat a directory listing or an overlong first-line warning as file content", () => {
		expect(receipt(read({ output: { text: "[Directory listing: D:/project/a.ts]\nchild.ts", totalLines: 2 } })).evidence[0].note).toBe("directory");
		expect(receipt(read({ output: { text: "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a.ts | head -c 51200]", totalLines: 1 } })).evidence[0].note).toBe("tooLong");
	});
	it("requires returned image data and honors the explicit non-vision omission", () => {
		const image = { data: "pixels", mimeType: "image/png" };
		expect(receipt(read({ output: { text: "Read image file [image/png]", images: [image], totalLines: 1 } })).status).toBe("returned");
		expect(receipt(read({ output: { text: "Read image file [image/png]", totalLines: 1 } })).status).toBe("unknown");
		expect(receipt(read({ output: { text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]", images: [image], totalLines: 2 } })).evidence[0].note).toBe("imageOmitted");
	});
	it("keeps unsupported read_file output shape unknown while preserving its real call for inspection", () => {
		const result = receipt(read({ name: "read_file", args: JSON.stringify({ file_path: "a.ts" }) }));
		expect(result.status).toBe("unknown"); expect(result.evidence[0].toolId).toBe("read-one");
	});
	it("does not let a queued follow-up steal the running turn's reads", () => {
		const result = collectAttachmentReceipts([user(), user("a.ts", true), assistant(read())], "D:/project");
		expect(result.get(0)![0].status).toBe("returned"); expect(result.get(1)![0].status).toBe("referenced");
	});
	it("keeps all attempts rather than hiding a failed read behind an earlier successful one", () => {
		const result = collectAttachmentReceipts([user(), assistant(read(), read({ id: "retry", status: "error" }))], "D:/project").get(0)![0];
		expect(result.status).toBe("failed"); expect(result.evidence.map((item) => item.toolId)).toEqual(["read-one", "retry"]);
	});
	it("retains explicit empty responses but never invents a result for malformed tool arguments", () => {
		expect(receipt(read({ output: { text: "", totalLines: 0 } })).evidence[0].note).toBe("empty");
		expect(receipt(read({ args: "{bad" })).status).toBe("referenced");
	});
	it("uses Windows/UNC case-insensitivity and POSIX case-sensitivity, preserving external absolute paths", () => {
		expect(attachmentPathKey("D:\\PROJECT\\A.ts", "D:/project")).toBe(attachmentPathKey("a.ts", "D:/project"));
		expect(attachmentPathKey("//SERVER/Share/A.ts", "D:/project")).toBe(attachmentPathKey("//server/share/a.ts", "D:/project"));
		expect(attachmentPathKey("/project/A.ts", "/project")).not.toBe(attachmentPathKey("/project/a.ts", "/project"));
		expect(attachmentPathKey("D:/external/a.ts", "D:/project")).toBe("d:/external/a.ts");
		expect(attachmentPathKey("https://example.test/a.ts", "D:/project")).toBeUndefined();
	});
});
