/** 轨迹视图调试页（仅 dev 用）：固定 fixture 直接渲染 TrajectoryView，
 * 打开 http://localhost:5188/debug-trajectory.html 目检时间轴与台账。
 * 顶栏 tab（对话/上下文/轨迹）在主应用里，这里只呈现轨迹本体。 */
import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatEntry } from "../hooks/transcript.ts";
import { TrajectoryView } from "../features/trajectory/TrajectoryView.tsx";
import "../index.css";
import "../desktop-shell.css";

const BASE = Date.now() - 6 * 60_000;

const entries: ChatEntry[] = [
	{ kind: "user", text: "帮我看看这个项目的登录逻辑在哪里", timestamp: BASE },
	{
		kind: "assistant",
		thinking: "用户要找登录逻辑。先全局搜 login 相关代码，再读入口文件确认调用链。",
		tools: [
			{
				id: "g1", name: "grep", args: '{"pattern":"login","path":"D:/manager/src"}', summary: "搜索 login",
				status: "ok", startedAt: BASE + 800, finishedAt: BASE + 1400,
				output: { text: "Found 12 matches src/main/java/com/manager/auth/AuthController.java", totalLines: 1 },
			},
			{
				id: "r1", name: "read", args: '{"file_path":"D:/manager/src/main/java/com/manager/auth/AuthController.java"}', summary: "读取 AuthController.java",
				status: "ok", startedAt: BASE + 2000, finishedAt: BASE + 2600,
				output: { text: "<path>D:/manager/src/main/java/com/manager/auth/AuthController.java</path>\n<type>file</type>\n<content>…120 行…</content>", totalLines: 120 },
			},
		],
		segments: [
			{ kind: "thinking", text: "用户要找登录逻辑。先全局搜 login 相关代码，再读入口文件确认调用链。" },
			{ kind: "tool", toolId: "g1" },
			{ kind: "tool", toolId: "r1" },
			{ kind: "text", text: "登录逻辑在 `AuthController`，入口是 `POST /auth/login`，校验走 `CredentialHealthService`。" },
		],
		text: "登录逻辑在 `AuthController`，入口是 `POST /auth/login`，校验走 `CredentialHealthService`。",
		timestamp: BASE + 3000,
		endedAt: BASE + 9200,
		usage: { input: 18400, output: 620, cacheRead: 150000, cacheWrite: 2100 },
		model: "deepseek-v4.1-flash",
	},
	{ kind: "user", text: "把它的超时改成 30 秒", timestamp: BASE + 62_000 },
	{
		kind: "assistant",
		thinking: "",
		tools: [
			{
				id: "e1", name: "edit", args: '{"file_path":"AuthController.java","old_string":"timeout = 10","new_string":"timeout = 30"}', summary: "修改超时 10 → 30",
				status: "ok", startedAt: BASE + 63_000, finishedAt: BASE + 63_400,
				output: { text: "OK", totalLines: 1 },
			},
			{
				id: "b1", name: "bash", args: '{"command":"mvn test -Dtest=AuthTest"}', summary: "跑 AuthTest",
				status: "error", startedAt: BASE + 64_000, finishedAt: BASE + 71_200,
				output: { text: "[ERROR] Tests run: 3, Failures: 1 — AuthControllerTest.testLoginTimeout:31 expected 30 but was 10", totalLines: 24 },
			},
		],
		segments: [
			{ kind: "tool", toolId: "e1" },
			{ kind: "tool", toolId: "b1" },
			{ kind: "text", text: "改完了，但测试里还断言着旧值 10，我把测试一并对齐。等等——先确认改法。" },
		],
		text: "改完了，但测试里还断言着旧值 10，我把测试一并对齐。等等——先确认改法。",
		timestamp: BASE + 72_000,
		endedAt: BASE + 78_000,
		usage: { input: 22300, output: 310, cacheRead: 168000, cacheWrite: 900 },
		model: "deepseek-v4.1-flash",
	},
	{ kind: "user", text: "算了先别动测试，看看还有哪里引用了这个值", timestamp: BASE + 130_000 },
	{
		kind: "assistant",
		thinking: "",
		tools: [
			{
				id: "g2", name: "grep", args: '{"pattern":"timeout = 10","path":"D:/manager"}', summary: "搜索 timeout = 10",
				status: "ok", startedAt: BASE + 131_000, finishedAt: BASE + 131_300,
				output: { text: "Found 2 matches src/test/.../AuthControllerTest.java src/docs/timeout.md", totalLines: 2 },
			},
			{
				id: "rc", name: "run_code", args: '{"description":"统计各文件引用"}', summary: "统计各文件引用",
				status: "ok", startedAt: BASE + 132_000, finishedAt: BASE + 133_200,
				output: { text: "AuthControllerTest.java: 1 处；timeout.md: 1 处", totalLines: 1 },
			},
			{
				id: "sub", name: "read", args: '{"file_path":"src/docs/timeout.md"}', summary: "读取 timeout.md",
				status: "ok", startedAt: BASE + 132_500, finishedAt: BASE + 132_900,
				output: { text: "# 超时说明\n默认 10 秒…", totalLines: 12 },
			},
			{
				id: "run", name: "bash", args: '{"command":"sleep 30"}', summary: "等待中",
				status: "running", startedAt: BASE + 134_000,
			},
		],
		segments: [
			{ kind: "tool", toolId: "g2" },
			{ kind: "tool", toolId: "rc" },
			{ kind: "tool", toolId: "run" },
		],
		text: "",
		timestamp: BASE + 133_500,
	},
	{ kind: "user", text: "停一下", timestamp: BASE + 200_000, queued: true },
];

createRoot(document.getElementById("app")!).render(
	createElement(StrictMode, null,
		createElement("div", { className: "owl-desktop-shell" },
			createElement("div", { style: { display: "flex", flex: 1, minHeight: 0, height: "100dvh", flexDirection: "column" } },
				createElement(TrajectoryView, { entries, active: true }),
			),
		),
	),
);
