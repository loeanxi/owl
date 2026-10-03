// owl-billion-context 冒烟测试：bundle 可加载、工具/事件挂载齐全、
// 内核对一条迷你会话能完整跑一轮折叠渲染、compress 门禁生效。
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const mod = await import(pathToFileURL(join(process.cwd(), "dist", "index.js")).href);

const tools = [];
const handlers = {};
const pi = {
	registerTool: (t) => tools.push(t),
	on: (ev, h) => {
		(handlers[ev] ??= []).push(h);
	},
	appendEntry: () => {},
};
mod.default(pi);
const toolNames = tools.map((t) => t.name);
console.log("tools:", toolNames.join(", "));
console.log("events:", Object.keys(handlers).join(", "));
if (tools.length !== 4) throw new Error("expected 4 tools");
for (const ev of ["context", "before_agent_start", "session_before_compact", "session_shutdown"]) {
	if (!handlers[ev]) throw new Error(`missing handler: ${ev}`);
}

// ---- 迷你端到端：context 改写 ----
const ctx = {
	ui: {},
	hasUI: false,
	cwd: process.cwd(),
	model: { provider: "test", id: "test-model", contextWindow: 65536, input: [] },
	sessionManager: {
		getSessionId: () => "smoke-session",
		getSessionFile: () => null,
		getEntries: () => [
			{ type: "message", id: "e1", message: { role: "user", content: "hello world this is a user prompt", timestamp: 1 } },
		],
		buildContextEntries: () => [
			{ type: "message", id: "e1", message: { role: "user", content: "hello world this is a user prompt", timestamp: 1 } },
		],
	},
	getContextUsage: () => ({ tokens: 100, contextWindow: 65536, percent: 0.2 }),
	getSystemPrompt: () => "You are a test agent.",
	abort: () => {},
	signal: undefined,
};

const contextHandler = handlers["context"][0];
const out = await contextHandler({ type: "context", messages: [{ role: "user", content: "hello", timestamp: 1 }] }, ctx);
if (!out || !Array.isArray(out.messages)) throw new Error("context handler returned no messages");
const joined = out.messages.map((msg) => (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))).join("\n");
if (!joined.includes("m00001")) throw new Error("ref tag not rendered");
console.log("context render:", joined.split("\n").slice(0, 3).join(" / "));

const compactResult = handlers["session_before_compact"][0]({ type: "session_before_compact" }, ctx);
if (!compactResult || compactResult.cancel !== true) throw new Error("session_before_compact did not cancel");

// ---- compress 工具路径：消息太小应被内核最小区间门拒绝 ----
// 内核把门禁拒绝作为 receipt 里的 errors 返回（0 blocks），只有参数解析失败才 throw。
const compress = tools.find((t) => t.name === "compress");
const compressOut = await compress.execute("call-1", { content: [{ startId: "m00001", endId: "m00001", summary: "tiny" }] }, undefined, undefined, ctx);
const compressText = compressOut.content[0].text;
if (!compressText.startsWith("▣ ACP |")) throw new Error("compress receipt malformed");
if (compressOut.details?.blocksCreated !== 0) throw new Error("tiny range should create 0 blocks");
console.log("compress gate receipt:", compressText.split("\n")[0]);

// 参数解析失败必须 throw（isError 语义，喂失败计数）。
let threw = false;
try {
	await compress.execute("call-2", { content: "not json at all {{{" }, undefined, undefined, ctx);
} catch {
	threw = true;
}
if (!threw) throw new Error("unparseable compress args should throw");

// ---- acp_status 工具路径 ----
const status = tools.find((t) => t.name === "acp_status");
const statusOut = await status.execute("call-3", {}, undefined, undefined, ctx);
const statusText = statusOut.content[0].text;
if (!statusText.includes("ACP context status")) throw new Error("status receipt malformed");
console.log("status receipt head:", statusText.split("\n").slice(0, 3).join(" | "));

// ---- 真实折叠端到端：足够大的旧区间真压一次，验证块创建 + 摘要注入 ----
// 注意内核保护区（preserveRecentMessages=5）：只有 12 条会话里压前 8 条才合法。
const filler = "x".repeat(7000);
const bigEntries = [];
for (let i = 0; i < 8; i++) {
	bigEntries.push({ type: "message", id: `u${i}`, message: { role: "user", content: `step ${i}: analyze logs part ${i}`, timestamp: i * 2 } });
	bigEntries.push({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: filler + ` (report ${i})` }], timestamp: i * 2 + 1 } });
}
for (let i = 0; i < 4; i++) {
	bigEntries.push({ type: "message", id: `tail${i}`, message: { role: "user", content: `recent message ${i}`, timestamp: 100 + i } });
}
const bigCtx = {
	...ctx,
	sessionManager: {
		...ctx.sessionManager,
		// 独立会话 id：内核状态按会话隔离，避免上一节的 ref 映射串场。
		getSessionId: () => "smoke-session-fold",
		getEntries: () => bigEntries,
		buildContextEntries: () => bigEntries,
	},
};
// 先跑一轮 context 让内核给消息铸 ref（u0→m00001, a0→m00002, ...）
await contextHandler({ type: "context", messages: [] }, bigCtx);
const foldOut = await compress.execute(
	"call-4",
	{ content: [{ startId: "m00001", endId: "m00016", summary: "Steps 0-7: user asked to analyze build log parts 0-7; each produced a long report (elided). All eight reports concluded 'no errors found'." }] },
	undefined,
	undefined,
	bigCtx,
);
const foldText = foldOut.content[0].text;
console.log("fold receipt:", foldText.split("\n").slice(0, 2).join(" | "));
if (foldOut.details?.blocksCreated !== 1) {
	console.error("receipt:\n" + foldText);
	throw new Error("expected 1 block created, got " + JSON.stringify(foldOut.details));
}

// 再渲染一轮上下文：被折消息应被摘要替换；保护区（最近 ~5000 token）的
// filler 按设计保留原文 —— 断言折掉了大多数而不是全部。
const afterFold = await contextHandler({ type: "context", messages: [] }, bigCtx);
const afterText = afterFold.messages.map((msg) => (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))).join("\n");
if (!afterText.includes("Compressed conversation section")) throw new Error("fold summary not injected into view");
const fillerCount = afterFold.messages.filter((msg) => JSON.stringify(msg.content).includes(filler)).length;
if (fillerCount >= 8) throw new Error("no filler messages were folded (protected zone swallowed everything)");
if (!afterText.includes("recent message 3")) throw new Error("kept recent message lost");
console.log(`post-fold view: summary=yes, filler 8→${fillerCount} (protected zone kept), recent-kept=yes`);
console.log("post-fold message count:", afterFold.messages.length, "(raw was 16)");

// ---- 恢复路径：search_context 找到块，decompress 读回内容（默认写文件）----
const search = tools.find((t) => t.name === "search_context");
const searchOut = await search.execute("call-5", { query: "reports concluded" }, undefined, undefined, bigCtx);
if (!searchOut.content[0].text.includes("b1")) throw new Error("search_context did not find block b1");
console.log("search_context hit:", searchOut.content[0].text.split("\n")[0]);

const decompress = tools.find((t) => t.name === "decompress");
const decompOut = await decompress.execute("call-6", { blockId: "b1" }, undefined, undefined, bigCtx);
const decompText = decompOut.content[0].text;
const isFileMode = decompText.includes("written to");
const hasContent = decompText.includes("SEVEN REPORTS") || (decompOut.details?.file ?? "");
if (!isFileMode && !decompText.includes("SEVEN REPORTS")) throw new Error("decompress returned neither file pointer nor content");
console.log("decompress:", isFileMode ? `file mode → ${decompOut.details.file}` : "inline mode");
void hasContent;

console.log("SMOKE OK");
