/**
 * Presentation for the codemode tool.
 *
 * owl:本 fork 移除了 TUI（pi-tui 与 modes/interactive 已删），上游的交互式渲染器无法编译。
 * 桌面端从会话事件自行渲染 codemode 输出，因此这里保持 ToolDefinition 的渲染签名但不再
 * 返回组件；签名保留是为了让 codemodeRenderers 的类型形状与上游一致。
 */

import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { CodemodeToolDetails } from "./tool.ts";

export const codemodeRenderers: Pick<
	ToolDefinition<any, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall() {
		return undefined;
	},
	renderResult() {
		return undefined;
	},
};
