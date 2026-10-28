/** Sanitized real session turn. No synthetic progress has been added. */
export const REAL_REPLAY_SOURCE = {
	source: "2026-10-18T18-51-26-355Z_01a1505a-bd13-77cd-b57e-ec091f92abb2.jsonl",
	sourceSha256: "cc2457af42b28f0a2663b0de2a5fd4348cfe71cb68c4e946753af2da77a59792",
	userEntryId: "84eeabd1",
	finalEntryId: "fdfce2f5",
	retainedThinking: false,
	removed: [
		"thinking bodies",
		"model/provider/token metadata",
		"all other turns",
		"unrelated or long successful tool output lines",
	],
	shortenedOutputs: [
		{
			toolCallId: "call_00_WdABMXJ6nQELSS8jD8Pi7285",
			originalLines: 20,
			keptLines: 1,
		},
		{
			toolCallId: "call_01_sUHH0xhGyTReonSH8jFL3420",
			originalLines: 42,
			keptLines: 1,
		},
		{
			toolCallId: "call_00_aeJFG9Y1r9GG2yFxMy1y8615",
			originalLines: 12,
			keptLines: 1,
		},
		{
			toolCallId: "call_00_eKwBmAiK9Y9RVtdBTqyf3586",
			originalLines: 64,
			keptLines: 8,
		},
		{
			toolCallId: "call_01_qLJrwEV0g2e4TZwO6dd77162",
			originalLines: 22,
			keptLines: 4,
		},
		{
			toolCallId: "call_02_9Su6GxvGDiSobRQctbpB2013",
			originalLines: 37,
			keptLines: 6,
		},
		{
			toolCallId: "call_00_aYvam3MTptcRH5FE6ZNS6951",
			originalLines: 29,
			keptLines: 6,
		},
		{
			toolCallId: "call_01_E2bHIgaEb7rQMSYUGXPE7439",
			originalLines: 62,
			keptLines: 5,
		},
		{
			toolCallId: "call_00_fG2BqHFslnGlvh5IqNkY1320",
			originalLines: 18,
			keptLines: 6,
		},
		{
			toolCallId: "call_01_IL2plWrsiRPVxk9R36lH6053",
			originalLines: 42,
			keptLines: 2,
		},
	],
} as const;

export const REAL_REPLAY_ENTRY_IDS = [
	"84eeabd1",
	"7513285d",
	"7f76a281",
	"cfa067fa",
	"c4271e22",
	"e39b92a5",
	"0674fcfd",
	"cb0ad5ad",
	"f586c5af",
	"3f309948",
	"b289a2ed",
	"422c7bf9",
	"c78da4e3",
	"99d62fb1",
	"e5c5c0e0",
	"b13e7b5e",
	"387fc3cc",
	"28fc4299",
	"fdfce2f5",
] as const;

export const REAL_REPLAY_MESSAGES = [
	{
		role: "user",
		timestamp: 1792349503712,
		content: [
			{
				type: "text",
				text: "查看当前项目",
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1792349503754,
		persistedAt: 1792349505858,
		stopReason: "toolUse",
		content: [
			{
				type: "thinking",
				thinking: "[已移除原始 thinking 正文]",
			},
			{
				type: "toolCall",
				id: "call_00_WdABMXJ6nQELSS8jD8Pi7285",
				name: "ls",
				arguments: {
					path: "D:/owl",
				},
			},
			{
				type: "toolCall",
				id: "call_01_sUHH0xhGyTReonSH8jFL3420",
				name: "find",
				arguments: {
					pattern: "*.md",
					path: "D:/owl",
					limit: 40,
				},
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349505930,
		toolCallId: "call_00_WdABMXJ6nQELSS8jD8Pi7285",
		toolName: "ls",
		isError: false,
		content: [
			{
				type: "text",
				text: "owl-re-v1/",
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349505931,
		toolCallId: "call_01_sUHH0xhGyTReonSH8jFL3420",
		toolName: "find",
		isError: false,
		content: [
			{
				type: "text",
				text: ".frontend-design/review-changes/README.md",
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1792349505968,
		persistedAt: 1792349507723,
		stopReason: "toolUse",
		content: [
			{
				type: "thinking",
				thinking: "[已移除原始 thinking 正文]",
			},
			{
				type: "toolCall",
				id: "call_00_aeJFG9Y1r9GG2yFxMy1y8615",
				name: "ls",
				arguments: {
					path: "D:/owl/owl-re-v1",
				},
			},
			{
				type: "toolCall",
				id: "call_01_iV2qVanpWv5SAuOgbYBA9526",
				name: "ls",
				arguments: {
					path: "D:/owl/owl-re-v1/apps",
				},
			},
			{
				type: "toolCall",
				id: "call_02_xvax6Up245ygbIQ6Num13607",
				name: "ls",
				arguments: {
					path: "D:/owl/owl-re-v1/packages",
				},
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349507776,
		toolCallId: "call_00_aeJFG9Y1r9GG2yFxMy1y8615",
		toolName: "ls",
		isError: false,
		content: [
			{
				type: "text",
				text: "owl-mono/",
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349507776,
		toolCallId: "call_01_iV2qVanpWv5SAuOgbYBA9526",
		toolName: "ls",
		isError: false,
		content: [
			{
				type: "text",
				text: "[Path corrected from D:\\owl\\owl-re-v1\\apps to D:\\owl\\owl-re-v1\\owl-mono\\apps. Copy this path exactly; do not insert or drop a directory segment from memory.]\ndesktop/\npool-server/",
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349507776,
		toolCallId: "call_02_xvax6Up245ygbIQ6Num13607",
		toolName: "ls",
		isError: true,
		content: [
			{
				type: "text",
				text: "Path not found: D:\\owl\\owl-re-v1\\packages",
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1792349507810,
		persistedAt: 1792349510069,
		stopReason: "toolUse",
		content: [
			{
				type: "thinking",
				thinking: "[已移除原始 thinking 正文]",
			},
			{
				type: "toolCall",
				id: "call_00_eKwBmAiK9Y9RVtdBTqyf3586",
				name: "read",
				arguments: {
					path: "D:/owl/owl-re-v1/owl-mono/package.json",
				},
			},
			{
				type: "toolCall",
				id: "call_01_qLJrwEV0g2e4TZwO6dd77162",
				name: "ls",
				arguments: {
					path: "D:/owl/owl-re-v1/owl-mono/packages",
				},
			},
			{
				type: "toolCall",
				id: "call_02_9Su6GxvGDiSobRQctbpB2013",
				name: "ls",
				arguments: {
					path: "D:/owl/owl-re-v1/owl-mono",
				},
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349510615,
		toolCallId: "call_00_eKwBmAiK9Y9RVtdBTqyf3586",
		toolName: "read",
		isError: false,
		content: [
			{
				type: "text",
				text: '{\n\t"name": "owl",\n\t"private": true,\n\t"type": "module",\n\t"workspaces": [\n\t\t"packages/*",\n\t\t"apps/*"\n\t],',
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349510616,
		toolCallId: "call_01_qLJrwEV0g2e4TZwO6dd77162",
		toolName: "ls",
		isError: false,
		content: [
			{
				type: "text",
				text: "agent/\nai/\ncodemode/\ncoding-agent/",
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349510616,
		toolCallId: "call_02_9Su6GxvGDiSobRQctbpB2013",
		toolName: "ls",
		isError: false,
		content: [
			{
				type: "text",
				text: "AGENTS.md\napps/\nCHANGELOG.md\npackage.json\npackages/\nREADME.md",
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1792349510655,
		persistedAt: 1792349513178,
		stopReason: "toolUse",
		content: [
			{
				type: "thinking",
				thinking: "[已移除原始 thinking 正文]",
			},
			{
				type: "toolCall",
				id: "call_00_aYvam3MTptcRH5FE6ZNS6951",
				name: "bash",
				arguments: {
					command:
						'cd /d/owl/owl-re-v1/owl-mono && git log --oneline -5 && echo "---" && git status --short | head -20 && echo "---" && git branch --show-current',
				},
			},
			{
				type: "toolCall",
				id: "call_01_E2bHIgaEb7rQMSYUGXPE7439",
				name: "read",
				arguments: {
					path: "D:/owl/owl-re-v1/owl-mono/README.md",
					limit: 60,
				},
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349514786,
		toolCallId: "call_00_aYvam3MTptcRH5FE6ZNS6951",
		toolName: "bash",
		isError: false,
		content: [
			{
				type: "text",
				text: "dad93dff9 fix(pool-server): 编辑模型时一并保存平台路由\n958ff32d9 fix(pool-server): 无登录文件时用个人令牌拉目录\n8f38d2dcb fix(pool-server): 目录窗口只升不降，满血上游优先\n04b7c6673 fix(coding-agent): 已公布窗口覆盖本地旧声明\nf1c10bb4e fix(desktop): 聚焦后仍铺出下一步推荐词\n",
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349514787,
		toolCallId: "call_01_E2bHIgaEb7rQMSYUGXPE7439",
		toolName: "read",
		isError: false,
		content: [
			{
				type: "text",
				text: "# owl\n\n一个桌面优先的编码 agent。本仓库在 [pi](https://github.com/badlogic/pi-mono)（pi-mono，MIT 协议，\n原作者 Mario Zechner / earendil-works）的基础上改造而来，去掉了 TUI 终端界面，改为以桌面应用\n作为主要入口。",
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1792349514829,
		persistedAt: 1792349517104,
		stopReason: "toolUse",
		content: [
			{
				type: "thinking",
				thinking: "[已移除原始 thinking 正文]",
			},
			{
				type: "toolCall",
				id: "call_00_fG2BqHFslnGlvh5IqNkY1320",
				name: "bash",
				arguments: {
					command:
						'cd /d/owl/owl-re-v1/owl-mono && echo "modified: $(git status --short | wc -l)" && echo "last commit date: $(git log -1 --format=%cd)" && echo "--- tags ---" && git tag | tail -3 && echo "--- untracked ---" && git status --short | grep \'^??\' | head -10',
				},
			},
			{
				type: "toolCall",
				id: "call_01_IL2plWrsiRPVxk9R36lH6053",
				name: "read",
				arguments: {
					path: "D:/owl/owl-re-v1/owl-mono/CHANGELOG.md",
					limit: 40,
				},
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349517726,
		toolCallId: "call_00_fG2BqHFslnGlvh5IqNkY1320",
		toolName: "bash",
		isError: false,
		content: [
			{
				type: "text",
				text: "modified: 167\nlast commit date: Sun Oct 18 21:42:36 2026 +0800\n--- tags ---\nv0.99.1\nv0.99.2\nv1.0.0",
			},
		],
	},
	{
		role: "toolResult",
		timestamp: 1792349517727,
		toolCallId: "call_01_IL2plWrsiRPVxk9R36lH6053",
		toolName: "read",
		isError: false,
		content: [
			{
				type: "text",
				text: "# Owl 更新日志\n## 2026-10-19",
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1792349517762,
		persistedAt: 1792349521056,
		stopReason: "stop",
		content: [
			{
				type: "thinking",
				thinking: "[已移除原始 thinking 正文]",
			},
			{
				type: "text",
				text: "看完了，给你一份概览：\n\n**D:/owl** 是一个多项目工作区，主战场是 `owl-re-v1/owl-mono`——就是把上游 pi-mono（MIT）改造成桌面版编码 agent 的 **Owl**，当前版本 `v0.0.3`（tag 已到 v1.0.0）。\n\n**架构三件套**\n- 桥服务器：`packages/coding-agent/src/modes/desktop/`，WebSocket 协议 + 单端口托管 UI\n- 前端：`apps/desktop/src/`（React）\n- 壳：`apps/desktop/src-tauri/`（Tauri，Windows）\n\n**包结构**：4 个上游包（ai / agent / coding-agent / codemode）+ 20 个 owl-* 扩展包（compter-use、univer-office、life-guide、map、media-bridge、safety-net、genui……）+ 2 个 app（desktop、pool-server）。\n\n**⚠️ 值得注意的一点**：工作区现在有 **167 个未提交改动**，一堆新文件还没进 git（`app-keybindings.ts`、`ExecutionToolbar.tsx`、`ImageViewer.tsx`、`execution-view.test.tsx` 等），当前在 `main` 分支，最后一次提交是 10-18。CHANGELOG 里 10-19 那段「对话三视图 / 改动面板 / 后台任务」的改动看起来就是这批活儿。\n\n要我看某一块具体代码，还是帮你梳理这堆未提交改动、准备分批提交？",
			},
		],
	},
];
