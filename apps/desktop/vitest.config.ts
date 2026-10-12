import { defineConfig } from "vitest/config";

/**
 * apps/desktop 的测试入口是 `npm test`（scripts/run-mixed-tests.mjs），不是本配置。
 *
 * 该脚本按 import 来源分流：38 个 node:test 文件交给 node --test，2 个 vitest 文件
 * （用到 vi.mock / vi.importActual / vi.unstubAllGlobals，node 内建 runner 提供不了）
 * 交给 vitest，并逐个文件名传进来。刻意不把 node:test 用例迁过来：它们有 800 多条
 * node:assert 断言和 42 处 t.after，迁移只会制造一千行噪音 diff。
 *
 * 因此直接跑 `npx vitest run` 会把 node:test 文件也收进来，报 "No test suite found"——
 * 那是预期噪音，不代表回归。要跑单个文件：
 *   node ../../scripts/run-mixed-tests.mjs src/components/usage-display.test.ts
 */
export default defineConfig({
	test: {
		// 这些用例直接把组件渲染成静态 HTML，不依赖浏览器环境。
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		// src-tauri/target 下有嵌入的源码副本，dist 下有编译产物：都不是测试。
		exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/.artifacts/**"],
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
	},
});