/** 「我的助理」面板调试页（仅 dev 用）：内存 mock 桥喂真实示例数据 + 模拟
 * 一轮 agent 对话事件流，打开 http://localhost:5188/debug-myself.html 看
 * tab 切换 / 流式回复 / 对话落盘，不碰磁盘、不调模型。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BridgeClient } from "../bridge/client.ts";
import type { FsListing, FsReadResult } from "../bridge/protocol.ts";
import { MyselfPanel } from "../features/myself/MyselfPanel.tsx";
import "../index.css";
import "../desktop-shell.css";

const DAY_07 = `# 2026-10-07（周三）

## 待办（手记）

- [ ] 跑一遍 coding-agent 测试，按 A/B/C/D/E 五类根因分批修
- [ ] 把 owl-myself 原型给用户看
- [ ] 复盘上周的项目复盘问题
- [ ] 看下人生指南第 4 章剩下的条目
- [ ] 给爸妈打个电话
- [ ] 处理积压邮件（建议今晚就清掉）
- [ ] 周三前的 DRAFT 文章要写完第一节

## AI 提炼（自动）

1. **上午先修测试** —— 周三有评审，先把根因 A/B 那批跑完
2. **中午给原型** —— 用户在等，今天必交
3. **晚上清邮件 + 复盘** —— 一天分三块，不挤一堆

## 对话

> 13:42 我：今天最重要的一件事是什么？
> 13:43 Owl Si：跑通测试 + 给出原型，这俩都是 deadline，先做这俩，别的都能挪。

## 完成情况

- [x] 跑一遍 coding-agent 测试，按 A/B/C/D/E 五类根因分批修
- [x] 把 owl-myself 原型给用户看
- [ ] 复盘上周的项目复盘问题
- [ ] 看下人生指南第 4 章剩下的条目
- [ ] 给爸妈打个电话
- [ ] 处理积压邮件
- [ ] 周三前的 DRAFT 文章要写完第一节
`;

const DAY_06 = `# 2026-10-06（周二）

## 待办（手记）

- [x] 画 owl-myself 原型（3 个变体）
- [x] 调研桌面端 ActivityRail 接线点
- [x] 把 stash 里那个坏掉的 icons.tsx 修好

## AI 提炼（自动）

1. **先修 icons.tsx** —— 上个会话断在半路，文件还是坏的
2. **原型收尾** —— 截图 A/B/C 给用户看

## 对话

> 20:15 我：继续完善个人助理
> 20:16 Owl Si：好，从入口按钮开始接。

## 完成情况

- [x] 画 owl-myself 原型（3 个变体）
- [x] 调研桌面端 ActivityRail 接线点
- [x] 把 stash 里那个坏掉的 icons.tsx 修好
`;

const DAY_05 = `# 2026-10-05（周一）

今天没记什么事，陪家人 + 把人生指南第 4 章读完了。
`;

/** 内存文件系统：fs.tree / fs.read / fs.write 的最小实现。 */
const files = new Map<string, string>([
	["2026-10-05.md", DAY_05],
	["2026-10-06.md", DAY_06],
	["2026-10-07.md", DAY_07],
]);

// -- 会话事件模拟：prompt 后回一段流式文本 + 权威 agent_end -------------------
type Listener = (message: { sessionId: string; event: Record<string, unknown> }) => void;
const listeners = new Set<Listener>();
let mockSession: string | null = null;
const REPLY = "看了一眼,今天还剩 5 件:复盘、人生指南第 4 章、给爸妈打电话、清邮件、DRAFT 第一节。建议下午 3 点先给爸妈打电话——那是最不想做但最值得的一件,做完别的都会顺。";

/** session.stats / set* 的返回:tokens/cost 必须齐全(Composer 的会话用量块假定有 stats 就有 tokens)。 */
const MOCK_STATS = {
	model: { provider: "minimax", id: "MiniMax-M3", name: "MiniMax-M3" },
	thinkingLevel: "high",
	availableThinkingLevels: ["off", "low", "medium", "high"],
	supportsThinking: true,
	contextUsage: { tokens: 12800, contextWindow: 200000, percent: 6.4, breakdown: { systemPrompt: 1800, toolDefinitions: 3200, messages: 5400, toolResults: 2400 } },
	stats: { userMessages: 1, assistantMessages: 1, toolCalls: 0, tokens: { input: 9800, output: 620, cacheRead: 5400, cacheWrite: 1800, total: 17620 }, cost: 0.0132, inputTokens: 9800, outputTokens: 620, cacheReadTokens: 5400, cacheWriteTokens: 1800, costUsd: 0.0132 },
};

function emit(type: string, extra: Record<string, unknown>, delay: number): void {
	setTimeout(() => {
		if (!mockSession) return;
		for (const fn of listeners) fn({ sessionId: mockSession, event: { type, ...extra } });
	}, delay);
}

const mockClient = {
	request(payload: { type: string; path?: string; content?: string; message?: string } & Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		if (payload.type === "fs.tree") {
			const listing: FsListing = {
				path: "",
				entries: [...files.keys()].map((name) => ({ name, path: name, isDir: false, hidden: false, isSymlink: false, broken: false })),
				truncated: false,
			};
			return Promise.resolve({ ok: true, result: listing });
		}
		if (payload.type === "fs.read") {
			const content = files.get(payload.path ?? "");
			if (content === undefined) return Promise.resolve({ ok: false, error: "not found" });
			const result: FsReadResult = { kind: "text", content, truncated: false, size: content.length };
			return Promise.resolve({ ok: true, result });
		}
		if (payload.type === "fs.write") {
			files.set(payload.path ?? "", payload.content ?? "");
			return Promise.resolve({ ok: true, result: { path: payload.path, size: (payload.content ?? "").length } });
		}
		if (payload.type === "session.create") {
			mockSession = `mock-${Date.now()}`;
			return Promise.resolve({ ok: true, result: { sessionId: mockSession } });
		}
		if (payload.type === "session.resume") return Promise.resolve({ ok: false, error: "no history" });
		if (payload.type === "session.abort") {
			mockSession = null;
			return Promise.resolve({ ok: true, result: {} });
		}
		if (payload.type === "session.stats") {
			return Promise.resolve({ ok: true, result: MOCK_STATS });
		}
		if (payload.type === "session.running") return Promise.resolve({ ok: true, result: { running: [] } });
		if (payload.type === "commands.list") return Promise.resolve({ ok: true, result: { commands: [{ name: "new", kind: "builtin" }, { name: "settings", kind: "builtin" }, { name: "model", kind: "builtin" }, { name: "thinking", kind: "builtin" }, { name: "compact", kind: "builtin" }] } });
		if (payload.type === "session.setModel" || payload.type === "session.setThinkingLevel" || payload.type === "session.setApprovalMode" || payload.type === "session.compact") {
			return Promise.resolve({ ok: true, result: MOCK_STATS });
		}
		if (payload.type === "session.prompt") {
			const userText = (payload.message ?? "").trim().split("\n").at(-1) ?? "";
			emit("agent_start", {}, 120);
			emit("message_start", { message: { role: "assistant", content: [] } }, 320);
			let delay = 520;
			for (const part of REPLY.split(/(?<=。）)/)) {
				emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: part } }, delay);
				delay += 180;
			}
			emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: REPLY }], stopReason: "stop" } }, delay + 120);
			emit("agent_end", {
				messages: [
					{ role: "user", content: [{ type: "text", text: userText }] },
					{ role: "assistant", content: [{ type: "text", text: REPLY }] },
				],
			}, delay + 240);
			emit("agent_settled", {}, delay + 360);
			return Promise.resolve({ ok: true, result: {} });
		}
		return Promise.resolve({ ok: false, error: `unsupported: ${payload.type}` });
	},
	onSessionEvent(fn: Listener): () => void {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},
} as unknown as BridgeClient;

createRoot(document.getElementById("app")!).render(
	<StrictMode>
		<MyselfPanel
			active
			client={mockClient}
			connected
			workspaceDir="D:\\owl"
			agentDir="C:\\Users\\demo\\.owl\\agent"
			providers={[{ id: "minimax", name: "MiniMax", models: [{ id: "MiniMax-M3", name: "MiniMax-M3" }] }]}
			defaultModel="minimax/MiniMax-M3"
			defaultThinkingLevel="high"
			defaultApprovalMode="confirm"
		/>
	</StrictMode>,
);
