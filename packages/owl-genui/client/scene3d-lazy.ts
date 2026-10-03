/**
 * three.js 场景渲染器懒加载：vite 动态 import 把 three 拆成独立异步 chunk，
 * 仅在规格含 `scene3d` 节点时下载；加载失败时 Scene3DNode 显示错误提示。
 * @module owl-genui/client/scene3d-lazy
 */
import type { GenuiScene3D } from "./spec.ts";

/**
 * Mount a GenUI 3D scene into `container` (engine loaded on demand).
 * @param container - the DOM node to host the WebGL canvas.
 * @param scene - the declarative scene spec.
 * @returns a disposer that removes the renderer and its context.
 */
export async function mountScene(container: HTMLElement, scene: GenuiScene3D): Promise<() => void> {
	const api = await import("./scene3d-core.ts");
	return api.mountScene(container, scene);
}
