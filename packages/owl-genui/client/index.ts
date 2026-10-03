/**
 * owl-genui 浏览器端公共入口：owl 桌面前端（apps/desktop）从这里引入渲染器。
 * KaTeX 的样式与字体由本入口负责加载（dsh 由宿主 ui-primitives 供给）。
 * @module owl-genui/client
 */
import "katex/dist/katex.min.css";
import "./genui-tokens.css";

export { GenuiActionContext, type GenuiActionHandler, useGenuiAction } from "./action-context.ts";
export { ErrorBoundary } from "./ErrorBoundary.tsx";
export {
	describeFenceFailure,
	FenceDiagnostic,
	type GenuiFenceContext,
	type GenuiFenceSource,
	renderGenuiFence,
	resolveGenuiSpec,
} from "./fence-render.tsx";
export { GenuiBlock } from "./GenuiBlock.tsx";
export { processGenuiSpec, validateGenuiSpec } from "./guard.ts";
export { getLocale, setLocale } from "./i18n/index.ts";
export type { BlockInteractionState } from "./interaction-store.ts";
export { fenceStateKey, toolStateKey } from "./interaction-store.ts";
export { parsePartialGenuiSpec } from "./parse-partial.ts";
export type { GenuiNode, GenuiSpec } from "./spec.ts";
