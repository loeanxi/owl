/**
 * vendor 内核的统一引入点。
 *
 * acp-kernel 的 dist 原样取自 npm 包 acp-kernel@0.0.100（MIT），
 * 由 esbuild 在构建时打进 dist/index.js，运行时零外部依赖。
 */
export * from "../vendor/acp-kernel/dist/index.js";
