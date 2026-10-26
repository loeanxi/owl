/**
 * sidebar_context 工具测试：模型问侧栏「用户在看什么」，界面回焦点快照；
 * 界面没回时如实说没有，不编。
 */
import { describe, expect, it } from "vitest";
import type { DesktopServerMessage, SidebarContextMessage } from "../src/modes/desktop/protocol.ts";
import { SidebarAckQueue, type SidebarContextAck } from "../src/modes/desktop/sidebar-acks.ts";
import { createSidebarContextTool, formatSidebarFocus } from "../src/modes/desktop/sidebar-context-tool.ts";

type ToolResult = { content: Array<{ type: string; text?: string }> };

async function run(tool: ReturnType<typeof createSidebarContextTool>): Promise<string> {
	const result = (await (tool.execute as unknown as (id: string, args: unknown) => Promise<ToolResult>)(
		"call-1",
		{},
	)) as ToolResult;
	return result.content.map((part) => part.text ?? "").join("");
}

interface Harness {
	text: () => Promise<string>;
	requests: SidebarContextMessage[];
}

function harness(options?: { state?: SidebarContextAck["state"]; detail?: string; hasClients?: boolean }): Harness {
	const requests: SidebarContextMessage[] = [];
	const acks = new SidebarAckQueue<SidebarContextAck>(1000);
	const tool = createSidebarContextTool({
		cwd: "/workspace",
		broadcast: (message: DesktopServerMessage) => {
			if (message.type !== "sidebar.context") return;
			requests.push(message);
			acks.resolve(message.requestId, {
				...(options?.state !== undefined ? { state: options.state } : {}),
				...(options?.detail !== undefined ? { detail: options.detail } : {}),
			});
		},
		acks,
		hasClients: () => options?.hasClients ?? true,
	});
	return { text: () => run(tool), requests };
}

describe("sidebar_context 工具", () => {
	it("界面回了快照，就把用户在看什么讲给模型", async () => {
		const h = harness({
			state: {
				tabKind: "editor",
				path: "src/app.ts",
				line: 42,
				openFiles: ["src/app.ts", "src/util.ts"],
				dirtyFiles: ["src/util.ts"],
			},
		});
		const text = await h.text();
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]?.cwd).toBe("/workspace");
		expect(text).toContain("src/app.ts");
		expect(text).toContain("42");
		expect(text).toContain("src/util.ts");
	});

	it("界面没回（没连/在别的项目）时如实说拿不到，不编焦点", async () => {
		const h = harness({ detail: "当前界面在别的项目" });
		const text = await h.text();
		expect(text).toContain("拿不到侧边栏焦点");
		expect(text).toContain("当前界面在别的项目");
	});

	it("没有界面连着时不广播、不空等", async () => {
		const h = harness({ hasClients: false });
		const text = await h.text();
		expect(h.requests).toHaveLength(0);
		expect(text).toContain("没有连接到桌面界面");
	});
});

describe("formatSidebarFocus", () => {
	it("有文件有行 → 说清文件与行号", () => {
		const text = formatSidebarFocus({ tabKind: "editor", path: "src/app.ts", line: 42 });
		expect(text).toContain("src/app.ts（第 42 行）");
	});

	it("只有页签 → 说明停在哪个卡片", () => {
		const text = formatSidebarFocus({ tabKind: "changes" });
		expect(text).toContain("changes");
	});

	it("什么都没聚焦 → 明说没有，并列出未保存修改", () => {
		const text = formatSidebarFocus({ dirtyFiles: ["src/util.ts"] });
		expect(text).toContain("没有聚焦");
		expect(text).toContain("src/util.ts");
	});
});
