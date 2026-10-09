import type { UiBuildFingerprint } from "./protocol.ts";

declare const __OWL_UI_BUILD__: UiBuildFingerprint | undefined;

/** 本 bundle 的构建指纹（vite define 注入；dev server / 测试环境下为 dev，桥跳过 UI 侧比对）。 */
export const UI_BUILD: UiBuildFingerprint = typeof __OWL_UI_BUILD__ !== "undefined" ? __OWL_UI_BUILD__ : { buildId: "dev" };
