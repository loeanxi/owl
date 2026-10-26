/**
 * 脏草稿防线测试：侧边栏编辑器里有用户未保存的修改时，模型的 write/edit 被挡下；
 * 没有草稿、别的文件、只读工具都不受影响。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { createEditorDraftGuard } from "../src/modes/desktop/editor-draft-guard.ts";
import { EditorDraftStore } from "../src/modes/desktop/editor-drafts.ts";

type ToolCallHandler = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { cwd: string },
) => unknown;

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 组出可用的守卫：拿到 tool_call 处理器。 */
function guardOf(agentDir: string): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
	const pi = {
		on: (event: string, listener: ToolCallHandler) => {
			if (event === "tool_call") handler = listener;
		},
	} as unknown as ExtensionAPI;
	createEditorDraftGuard(agentDir).factory(pi);
	if (handler === undefined) throw new Error("tool_call 处理器未注册");
	return handler;
}

async function makeWorkspace(): Promise<{ agentDir: string; cwd: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "owl-draft-guard-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "a.txt"), "base\n");
	return { agentDir, cwd, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

/** 在工作区里造一份「用户改了一半」的草稿。 */
async function putDraft(agentDir: string, cwd: string, path: string, content: string): Promise<void> {
	const base = "base\n";
	const drafts = new EditorDraftStore(agentDir, () => {});
	const result = drafts.put({
		cwd,
		path,
		content,
		baseRevision: `owl-file-v1:${hash(base)}:${"0".repeat(64)}`,
		baseContent: base,
		expectedDraftRevision: null,
		operationId: `op_${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
	});
	expect(result.status).toBe("saved");
}

describe("脏草稿防线", () => {
	it("文件有未保存草稿时挡住 write，并说清原因", async () => {
		const { agentDir, cwd, cleanup } = await makeWorkspace();
		try {
			await putDraft(agentDir, cwd, "a.txt", "base\n用户改了一半\n");
			const handler = guardOf(agentDir);
			const result = (await handler({ toolName: "write", toolCallId: "t1", input: { path: "a.txt" } }, { cwd })) as
				| { block?: boolean; reason?: string }
				| undefined;
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("a.txt");
			expect(result?.reason).toContain("未保存");
		} finally {
			await cleanup();
		}
	});

	it("绝对路径指向同一个文件时同样挡住", async () => {
		const { agentDir, cwd, cleanup } = await makeWorkspace();
		try {
			await putDraft(agentDir, cwd, "a.txt", "base\n用户改了一半\n");
			const handler = guardOf(agentDir);
			const result = (await handler(
				{ toolName: "edit", toolCallId: "t1", input: { path: join(cwd, "a.txt") } },
				{ cwd },
			)) as { block?: boolean } | undefined;
			expect(result?.block).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("没有草稿的文件照常写", async () => {
		const { agentDir, cwd, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(cwd, "b.txt"), "x\n");
			const handler = guardOf(agentDir);
			const result = await handler({ toolName: "write", toolCallId: "t1", input: { path: "b.txt" } }, { cwd });
			expect(result).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	it("只读工具与工作区外的路径都不拦", async () => {
		const { agentDir, cwd, cleanup } = await makeWorkspace();
		try {
			await putDraft(agentDir, cwd, "a.txt", "base\n用户改了一半\n");
			const handler = guardOf(agentDir);
			expect(
				await handler({ toolName: "read", toolCallId: "t1", input: { path: "a.txt" } }, { cwd }),
			).toBeUndefined();
			expect(
				await handler(
					{ toolName: "write", toolCallId: "t2", input: { path: join(cwd, "..", "outside.txt") } },
					{ cwd },
				),
			).toBeUndefined();
		} finally {
			await cleanup();
		}
	});
});
