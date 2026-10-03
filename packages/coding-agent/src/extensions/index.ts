import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import { owlMemoryExtension } from "./owl-memory/index.ts";

// owl:上游同路径文件还有 llama.cpp / tool-search / mcp 三个内置扩展。本 fork 的 WIP
//（412e7b190）删除了整个 src/extensions/，其中 MCP 改由桌面桥的 core/mcp-lite.ts 自行连接，
// llama 与 tool-search 未使用，因此只恢复 codemode；owl-memory 为本 fork 新增的跨会话记忆。
export const builtInExtensions: InlineExtension[] = [
	// Replaceable: an extension that registers `codemode` takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	// Replaceable: 跨会话记忆（remember 工具 + 历史会话自动抽取 + 提示词注入 + /memory）。
	owlMemoryExtension,
];
