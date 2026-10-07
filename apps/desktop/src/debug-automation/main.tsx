/** 自动化任务页调试（仅 dev 用）：假桥数据直接渲染 AutomationPage，
 * 打开 http://localhost:5188/debug-automation.html 目检任务流、抽屉与新建弹窗。 */
import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { BridgeClient } from "../bridge/client.ts";
import type { ScheduleListResult, ScheduleRun, ScheduleTask } from "../bridge/protocol.ts";
import { AutomationPage } from "../features/automation/AutomationPage.tsx";
import { SchedulePin } from "../features/automation/SchedulePin.tsx";
import { ScheduleDeliveryCard } from "../features/automation/ScheduleDeliveryCard.tsx";
import { ChatStream } from "../components/ChatStream.tsx";
import type { ChatEntry } from "../hooks/transcript.ts";
import "../index.css";
import "../desktop-shell.css";

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();
const at = (dayOffset: number, hhmm: string): number => {
	const [h, m] = hhmm.split(":").map(Number);
	const date = new Date(now + dayOffset * 86_400_000);
	date.setHours(h ?? 0, m ?? 0, 0, 0);
	return date.getTime();
};

const tasks: ScheduleTask[] = [
	{
		id: "t1", name: "人生指南 · 每日一篇", emoji: "🌱",
		prompt: "从 HowToLiveBetter 拉一篇没读过的章节，用「说人话」格式总结成 3 条可执行建议，附上原文链接；读过的章节不要重复推荐。",
		sessionId: "s1", targetLabel: "给我一条人生指南中的建议",
		repeat: { kind: "daily", time: "08:30" }, missed: "catch-up",
		enabled: true, createdAt: now - 12 * 86_400_000,
		nextRunAt: at(new Date().getHours() < 8 ? 0 : 1, "08:30"), lastRunAt: at(-1, "08:30") + 131_000,
	},
	{
		id: "t2", name: "邮箱晨报", emoji: "📮",
		prompt: "检查未读邮件，挑出 3 封最要紧的：谁发来的、要我做什么、最晚什么时候回；其余的按发件人归堆给一行摘要。",
		sessionId: "s2", targetLabel: "邮件页 · 本地解析",
		repeat: { kind: "daily", time: "09:00" }, missed: "catch-up",
		enabled: true, createdAt: now - 34 * 86_400_000,
		nextRunAt: at(new Date().getHours() < 9 ? 0 : 1, "09:00"), lastRunAt: at(-1, "09:00") + 48_000,
	},
	{
		id: "t3", name: "Token 生涯周报", emoji: "📊",
		prompt: "汇总上周本机所有 agent 的 token 用量与花费，对比前一周；找出最烧钱的三个会话，各给一句「值不值」评价。",
		sessionId: "__new__", targetLabel: "新会话（跑完置顶）",
		repeat: { kind: "weekly", weekday: 1, time: "09:00" }, missed: "skip",
		enabled: true, createdAt: now - 30 * 86_400_000,
		nextRunAt: at(3, "09:00"), lastRunAt: at(-4, "09:00") + 62_000,
	},
	{
		id: "t4", name: "仓库巡查", emoji: "🛠",
		prompt: "git status + 未提交变更摘要；有冲突标记就提醒我。",
		sessionId: "s1", targetLabel: "owl 项目会话",
		repeat: { kind: "interval", minutes: 20 }, missed: "skip",
		enabled: false, createdAt: now - 40 * 86_400_000,
		nextRunAt: null, lastRunAt: now - 3 * 86_400_000,
	},
];

const runs: Record<string, ScheduleRun[]> = {
	t1: [
		{ id: "r1", taskId: "t1", scheduledAt: at(-1, "08:30"), deliveredAt: at(-1, "08:30") + 131_000, status: "ok", durationMs: 131_000, sessionId: "s1" },
		{ id: "r2", taskId: "t1", scheduledAt: at(-2, "08:30"), deliveredAt: at(-2, "08:30") + 122_000, status: "ok", durationMs: 122_000 },
	],
	t2: [
		{ id: "r3", taskId: "t2", scheduledAt: at(-1, "09:00"), deliveredAt: at(-1, "09:00") + 48_000, status: "ok", durationMs: 48_000, sessionId: "s2" },
		{ id: "r4", taskId: "t2", scheduledAt: at(-2, "09:00"), deliveredAt: at(-2, "09:00") + 160_000, status: "error", durationMs: 160_000, note: "邮件服务超时" },
		{ id: "r5", taskId: "t2", scheduledAt: at(-2, "09:05"), deliveredAt: at(-2, "09:06") + 51_000, status: "ok", durationMs: 51_000, note: "自动重试成功" },
		{ id: "r6", taskId: "t2", scheduledAt: at(-3, "09:00"), deliveredAt: at(-3, "09:00") + 44_000, status: "ok", durationMs: 44_000, note: "无未读，未打扰" },
	],
	t3: [{ id: "r7", taskId: "t3", scheduledAt: at(-4, "09:00"), deliveredAt: at(-4, "09:00") + 62_000, status: "ok", durationMs: 62_000, sessionId: "ab12cd34-5678-90ab-cdef-112233445566" }],
	t4: [{ id: "r8", taskId: "t4", scheduledAt: now - 3 * 86_400_000, deliveredAt: null, status: "skipped", note: "owl 没开着，按策略跳过" }],
};

const data: ScheduleListResult = { tasks, runs };
// ?empty：看空态的示例引导（模板卡片 + 预填）
const emptyMode = new URLSearchParams(location.search).has("empty");
const viewData: ScheduleListResult = emptyMode ? { tasks: [], runs: {} } : data;

const iso = (ms: number): string => new Date(ms).toISOString();
const chatEntries: ChatEntry[] = [
	{ kind: "user", text: "帮我看看这个项目的登录逻辑在哪里", timestamp: now - 60 * MIN },
	{
		kind: "assistant", text: "登录逻辑在 AuthController，入口是 POST /auth/login。", thinking: "",
		tools: [], segments: [{ kind: "text", text: "登录逻辑在 AuthController，入口是 POST /auth/login。" }],
		timestamp: now - 58 * MIN, endedAt: now - 57 * MIN,
		usage: { input: 18400, output: 620, cacheRead: 150000, cacheWrite: 2100 }, model: "deepseek-v4.1-flash",
	},
	{ kind: "user", text: `〔owl-schedule:t2〕（自动化任务「邮箱晨报」到点执行 · 每天 09:00 · 现在 ${new Date(now - 9 * MIN).toLocaleString("sv-SE").slice(0, 16)}）\n\n检查未读邮件，挑出 3 封最要紧的：谁发来的、要我做什么、最晚什么时候回。`, timestamp: now - 9 * MIN },
	{
		kind: "assistant", text: "今早有 3 封要紧的：① 平台方账期确认，周四前回复；② 部署告警复核；③ 新同事入职表单。", thinking: "",
		tools: [], segments: [{ kind: "text", text: "今早有 3 封要紧的：① 平台方账期确认，周四前回复；② 部署告警复核；③ 新同事入职表单。" }],
		timestamp: now - 8 * MIN, endedAt: now - 7 * MIN,
		usage: { input: 22300, output: 310, cacheRead: 168000, cacheWrite: 900 }, model: "deepseek-v4.1-flash",
	},
];
const sessions = [
	{ id: "s1", title: "给我一条人生指南中的建议" },
	{ id: "s2", title: "邮件页 · 本地解析" },
	{ id: "s3", title: "owl 项目会话" },
];

const fakeClient = {
	request: async (request: { type: string; taskId?: string; enabled?: boolean }) => {
		if (request.type === "schedule.list") return { ok: true, result: viewData };
		if (request.type === "schedule.update" && request.taskId) {
			const task = tasks.find((candidate) => candidate.id === request.taskId);
			if (task && request.enabled !== undefined) task.enabled = request.enabled;
			return { ok: true };
		}
		if (request.type === "schedule.run" && request.taskId) {
			(request as { run?: ScheduleRun });
			const run: ScheduleRun = { id: `rr-${Date.now()}`, taskId: request.taskId, scheduledAt: Date.now(), deliveredAt: Date.now(), status: "ok", durationMs: 900 };
			runs[request.taskId] = [run, ...(runs[request.taskId] ?? [])];
			return { ok: true, result: { run } };
		}
		if (request.type === "schedule.delete" && request.taskId) {
			const index = tasks.findIndex((candidate) => candidate.id === request.taskId);
			if (index >= 0) tasks.splice(index, 1);
			return { ok: true };
		}
		return { ok: true };
	},
	onScheduleChanged: () => () => {},
} as unknown as BridgeClient;

createRoot(document.getElementById("app")!).render(
	createElement(StrictMode, null,
		createElement("div", { className: "owl-desktop-shell" },
			createElement("div", { style: { display: "flex", flex: 1, minHeight: 0, height: "100dvh", flexDirection: "column" } },
				createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
					createElement(AutomationPage, { client: fakeClient, active: true, sessions, onOpenSession: (id) => { window.alert("open session " + id.slice(0, 8)); } }),
				),
				createElement("div", { style: { flex: "none", height: 380, borderTop: "1px solid var(--owl-ui-border)", display: "flex", flexDirection: "column", minHeight: 0 } },
					createElement("div", { style: { padding: "6px 14px", color: "var(--owl-ui-muted)", fontSize: 11 } }, "会话内的样子（任务卡 + 输入框上方倒计时）："),
					createElement(ChatStream, { entries: chatEntries, client: fakeClient, onOpenAutomation: () => {} }),
					createElement("div", { style: { padding: "0 14px 10px" } },
						createElement(SchedulePin, { client: fakeClient, sessionId: "s1", onOpenAutomation: () => {} }),
					),
				),
			),
		),
	),
);
