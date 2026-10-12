import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

/**
 * owl-univer-office 的 vitest 配置同样只服务显式 `import ... from "vitest"` 的那几个测试；
 * 其余 node:test 用例由 scripts/run-mixed-tests.mjs 分流给 node --test。
 *
 * 依赖别名解析走仓库共用的 vitest.base.ts：测试要直接 import coding-agent 的源码
 * （test/plugin.integration.test.ts 从 ../../coding-agent/src/... 起），
 * 而 @owl/owl-coding-agent 这个包名在 workspace 里指向 dist，源码态必须显式指回 src。
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			// 真实渲染 / SDK 下载类用例要拉起 OfficeRuntime，默认 30s 不够。
			testTimeout: 180_000,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			// 构建产物不是测试。
			exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/.artifacts/**"],
			include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
		},
		resolve: {
			alias: [{ find: /^@owl\/owl-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);