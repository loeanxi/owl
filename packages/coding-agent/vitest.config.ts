import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			// 把 agent 目录隔离到临时目录，防止测试会话写进真实 Owl-history（见 setup-agent-env.ts 头注释）。
			setupFiles: ["./test/setup-agent-env.ts"],
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			// tsconfig.build.json 的 include 是 src/**/*.ts，没排 *.test.ts，
			// 所以 dist/ 里会编译出同名测试产物（src/modes/desktop/schedule-*.test.ts → dist/…），
			// 而 vitest 默认也收集 dist：这些副本既重复又缺 "No test suite found" 噪音。
			// src-tauri/target 下同样有嵌入的源码副本，一并排除。
			exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/.artifacts/**"],
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
