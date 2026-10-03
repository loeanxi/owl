/**
 * Mermaid 引擎懒加载：vite 动态 import 把 mermaid 拆成独立异步 chunk，仅在
 * 规格含 `mermaid` 节点时下载；加载失败时 MermaidNode 显示源码兜底。纯源码
 * 工具仍从 mermaid-safe 静态导出，供测试与节点直接使用。
 * @module owl-genui/client/mermaid-lazy
 */
export { assertSafeSvg, ensureFlowchartKind, repairMermaidSource } from "./mermaid-safe.ts";

/**
 * Render mermaid source to an SVG string (engine loaded on demand).
 * @param code - the mermaid diagram source.
 * @returns the rendered SVG markup (verified free of script/event handlers).
 * @throws when the kind is not whitelisted, rendering fails, or the output
 *   fails the sanitization check.
 */
export async function renderMermaid(code: string): Promise<string> {
	const api = await import("./mermaid-core.ts");
	return api.renderMermaid(code);
}
