/** 消息操作栏调试页（仅 dev 用）：mock 转录渲染 ChatStream，检查回答操作栏、
 * 工具输出的时间+复制、用户消息的编辑/复制/回退。打开
 * http://localhost:5188/msg-actions-debug.html。排查完可整体移除。 */
import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChatStream } from "../components/ChatStream.tsx";
import { GenuiSessionProvider } from "../components/Genui.tsx";
import type { BridgeClient } from "../bridge/client.ts";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import "../index.css";

// 展开工具记录：调试页要看工具详情里的时间+复制行
document.documentElement.dataset.owlToolRecords = "expanded";

const noop = () => {};
const stubClient = { request: async () => ({ ok: true }) } as unknown as BridgeClient;

const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 9, 4, hours, minutes, seconds).getTime();

const buildTool: ToolCard = {
	id: "tool-1",
	name: "bash",
	args: JSON.stringify({ command: "npm run build" }),
	summary: "运行了 `npm run build`",
	detail: "$ npm run build\n> tsc -p tsconfig.build.json && shx chmod +x dist/cli.js",
	status: "ok",
	output: {
		text: ["npm error code 2", "npm error path D:\\owl\\owl-mono\\packages\\coding-agent", "npm error command failed", "npm error Lifecycle script `build` failed with error:", "owl-start failed. ExitCode=1"].join("\n"),
		totalLines: 5,
	},
	startedAt: at(8, 41),
	finishedAt: at(8, 41),
};

const entries: ChatEntry[] = [
	{ kind: "user", text: "启动项目桌面端步骤，顺便看看构建日志里报的 npm error code 2 是怎么回事", entryId: "entry-1", timestamp: at(8, 39, 12) },
	{
		kind: "assistant",
		text: "明白，我先复现一次构建，看看报错到底卡在哪一步。",
		entryId: "entry-3",
		thinking: "用户遇到 npm error code 2。常见原因是 tsc 类型检查失败……先跑一次 build 拿到完整报错。",
		tools: [buildTool],
		segments: [
			{ kind: "thinking", text: "用户遇到 npm error code 2。常见原因是 tsc 类型检查失败……" },
			{ kind: "text", text: "明白，我先复现一次构建，看看报错到底卡在哪一步。" },
			{ kind: "tool", toolId: "tool-1" },
		],
		timestamp: at(8, 40, 48),
		usage: { input: 12000, output: 860, cacheRead: 152300, cacheWrite: 1450 },
	},
	{
		kind: "assistant",
		text: [
			"## 结论",
			"最常见的单包 **类型检查失败**（`tsc -p tsconfig.build.json`），npm 把它包装成 `code 2`。",
			"",
			"- 出路一：按上面报错把文件改好，再跑一次本地脚本",
			"- 出路二：加 `-tolerant` 重跑（tsc 报错也继续，dist 照常产出）",
			"",
			"```bash",
			"scripts/owl-start.cmd -Skip frontend",
			"```",
		].join("\n"),
		segments: [{ kind: "text", text: "## 结论\n最常见的单包 **类型检查失败**……" }],
		thinking: "",
		entryId: "entry-4",
		timestamp: at(8, 42, 36),
		usage: { input: 984500, output: 42300, cacheRead: 1920400, cacheWrite: 0 },
		tools: [],
	},
	{ kind: "user", text: "好，按方案一修，修完把两个包都重新类型检查一遍", entryId: "entry-2", timestamp: at(8, 43, 5) },
	{
		kind: "assistant",
		text: "全绿了，两个包都严格类型检查通过。",
		segments: [{ kind: "text", text: "全绿了，两个包都严格类型检查通过。" }],
		thinking: "",
		entryId: "entry-5",
		timestamp: at(8, 45, 27),
		usage: { input: 81200, output: 310, cacheRead: 640000, cacheWrite: 0 },
		tools: [],
	},
];

function App(): React.JSX.Element {
	return (
		<div style={{ display: "flex", height: "100vh", background: "#171717" }}>
			<div style={{ flex: 1, minWidth: 0 }}>
				<GenuiSessionProvider client={stubClient} sessionId="debug-session">
					<ChatStream
						entries={entries}
						activity="idle"
						onRewind={noop}
						onRegenerate={noop}
						onEditMessage={noop}
						onBranch={noop}
					/>
				</GenuiSessionProvider>
			</div>
		</div>
	);
}

/** 临时排查用边界：渲染错误直接显示在页面上。 */
class DebugBoundary extends Component<{ children: ReactNode }, { error?: string }> {
	state = { error: undefined };
	static getDerivedStateFromError(error: unknown) {
		return { error: String((error as Error)?.stack ?? error) };
	}
	render() {
		if (this.state.error) return <pre id="debug-error" style={{ color: "#f87171", padding: 20, whiteSpace: "pre-wrap" }}>{this.state.error}</pre>;
		return this.props.children;
	}
}

createRoot(document.getElementById("app")!).render(
	<StrictMode>
		<DebugBoundary>
			<App />
		</DebugBoundary>
	</StrictMode>,
);
