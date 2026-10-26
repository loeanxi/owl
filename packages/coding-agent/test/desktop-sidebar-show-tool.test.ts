/**
 * sidebar_show 工具测试：围栏、动作参数、行号钳制，以及最关键的「回执即事实」——
 * 模型只有在界面回执 delivered 时才可以说「已在侧边栏打开」。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopServerMessage, SidebarShowMessage } from "../src/modes/desktop/protocol.ts";
import { SidebarAckQueue, type SidebarShowAck } from "../src/modes/desktop/sidebar-acks.ts";
import { createSidebarShowTool } from "../src/modes/desktop/sidebar-show-tool.ts";

type ToolResult = { content: Array<{ type: string; text?: string }> };

/** 直接跑工具：只用到 id 与参数，运行时上下文与本用例无关。 */
async function run(tool: ReturnType<typeof createSidebarShowTool>, params: Record<string, unknown>): Promise<string> {
	const result = (await (tool.execute as unknown as (id: string, args: unknown) => Promise<ToolResult>)(
		"call-1",
		params,
	)) as ToolResult;
	return result.content.map((part) => part.text ?? "").join("");
}

const workspaces: string[] = [];

/** 临时工作区：放一个 README.md，够跑 file 动作。 */
async function makeWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "owl-sidebar-show-"));
	workspaces.push(dir);
	await writeFile(join(dir, "README.md"), "hello\n");
	return dir;
}

afterEach(async () => {
	while (workspaces.length > 0) {
		const dir = workspaces.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

interface Harness {
	text: (params: Record<string, unknown>) => Promise<string>;
	messages: SidebarShowMessage[];
	acks: SidebarAckQueue<SidebarShowAck>;
}

function harness(
	cwd: string,
	options?: { status?: "delivered" | "ignored" | "failed"; detail?: string; hasClients?: boolean },
): Harness {
	const messages: SidebarShowMessage[] = [];
	const acks = new SidebarAckQueue<SidebarShowAck>(1000);
	const status = options?.status ?? "delivered";
	const tool = createSidebarShowTool({
		cwd,
		broadcast: (message: DesktopServerMessage) => {
			if (message.type !== "sidebar.show") return;
			messages.push(message);
			acks.resolve(message.requestId, {
				status,
				...(options?.detail !== undefined ? { detail: options.detail } : {}),
			});
		},
		acks,
		hasClients: () => options?.hasClients ?? true,
	});
	return { text: (params) => run(tool, params), messages, acks };
}

describe("sidebar_show 工具", () => {
	it("file 动作：广播带 requestId 的 sidebar.show，回执 delivered 才报成功", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		const text = await h.text({ path: "README.md" });
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0]?.action).toBe("file");
		expect(h.messages[0]?.requestId).toBeTruthy();
		expect(h.messages[0]?.path).toBe("README.md");
		expect(text).toBe("已在侧边栏打开 README.md。");
	});

	it("行号与行段过线：模型给的锚点原样带给界面", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		await h.text({ path: "README.md", line: 42, endLine: 48, note: "这里是空指针的来源" });
		expect(h.messages[0]?.line).toBe(42);
		expect(h.messages[0]?.endLine).toBe(48);
		expect(h.messages[0]?.note).toBe("这里是空指针的来源");
	});

	it("行号非法（0 / 负数）当作没给", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		await h.text({ path: "README.md", line: 0 });
		expect(h.messages[0]?.line).toBeUndefined();
	});

	it("diff / review 动作：目标文件可以不存在（被删掉的改动也要看得见）", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		const text = await h.text({ path: "gone.ts", action: "diff" });
		expect(h.messages[0]?.action).toBe("diff");
		expect(text).toContain("「改动」卡片");
	});

	it("file 动作要求文件真实存在", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		const text = await h.text({ path: "definitely-missing-file.ts" });
		expect(h.messages).toHaveLength(0);
		expect(text).toContain("文件不存在");
	});

	it("工作区外的路径就地拒绝，不过线", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		const text = await h.text({ path: join(cwd, "..", "outside.ts") });
		expect(h.messages).toHaveLength(0);
		expect(text).toContain("工作区之外");
	});

	it("回执 ignored：如实说用户没看到，不报成功", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd, { status: "ignored", detail: "当前界面在别的项目" });
		const text = await h.text({ path: "README.md" });
		expect(text).toContain("侧边栏没有接收");
		expect(text).toContain("当前界面在别的项目");
		expect(text).not.toContain("已在侧边栏打开");
	});

	it("回执 failed：把失败原因带给模型", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd, { status: "failed", detail: "目标打不开" });
		const text = await h.text({ path: "README.md" });
		expect(text).toContain("侧边栏打开失败");
		expect(text).toContain("目标打不开");
	});

	it("没有界面连着：不空等，直接说摆不到用户眼前", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd, { hasClients: false });
		const text = await h.text({ path: "README.md" });
		expect(h.messages).toHaveLength(0);
		expect(text).toContain("没有连接到桌面界面");
	});

	it("工作区内的相对路径与绝对路径都归一成 workspace 相对 POSIX 路径", async () => {
		const cwd = await makeWorkspace();
		const h = harness(cwd);
		await h.text({ path: "README.md" });
		await h.text({ path: join(cwd, "README.md") });
		expect(h.messages.map((message) => message.path)).toEqual(["README.md", "README.md"]);
	});
});

describe("SidebarShowAckQueue", () => {
	it("回执能唤醒等待者；不认识或过期的 requestId 不误伤", async () => {
		const acks = new SidebarAckQueue<SidebarShowAck>(1000);
		const pending = acks.wait("req-1", { status: "timeout" });
		expect(acks.resolve("req-1", { status: "delivered" })).toBe(true);
		expect(await pending).toEqual({ status: "delivered" });
		expect(acks.resolve("req-1", { status: "delivered" })).toBe(false);
		expect(acks.resolve("req-unknown", { status: "failed" })).toBe(false);
	});

	it("超时按 timeout 结算：模型知道界面没回执", async () => {
		const acks = new SidebarAckQueue<SidebarShowAck>(20);
		const pending = acks.wait("req-2", { status: "timeout" });
		expect(await pending).toEqual({ status: "timeout" });
	});

	it("cancelAll：桥关闭时挂起的等待全部结算，不留悬挂 promise", async () => {
		const acks = new SidebarAckQueue<SidebarShowAck>(0);
		const pending = acks.wait("req-3", { status: "timeout" });
		acks.cancelAll({ status: "timeout" });
		expect(await pending).toEqual({ status: "timeout" });
		expect(acks.size).toBe(0);
	});
});
