/**
 * GenUI action context, plugin-owned.
 *
 * owl 桌面端在应用顶层（App.tsx）安装 GenuiActionContext.Provider，把组件动作
 * 经桥的 owl-ui.action 请求转成会话消息回传给模型。没有 provider 时（例如
 * 纯节点侧渲染）交互组件呈展示态——钩子永不抛错。
 */
import { createContext, useContext } from "react";

/** v2 action handler: component action + its collected data. */
export type GenuiActionHandler = (action: string, payload: Record<string, unknown>) => void;

/** owl 桌面端在顶层安装；渲染器内部一律通过 useGenuiAction 消费。 */
export const GenuiActionContext = createContext<GenuiActionHandler | undefined>(undefined);

/** Read the installed action handler, if any. */
export function useGenuiAction(): GenuiActionHandler | undefined {
	return useContext(GenuiActionContext);
}
