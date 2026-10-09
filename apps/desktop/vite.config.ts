import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { BUILD_INFO_FILE, computeProtocolHash, createBuildInfo, toRepoPath } from "../../packages/coding-agent/src/core/build-info.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 把这次打包实际用到的源码模块（含 packages/ 下被直接引用的源码）记进 dist/build-info.json，
 * 桥据此判断「UI 源码比 dist 新」；buildId 同时经 define 注入 bundle，用来判断「窗口里跑的不是盘上这份 dist」。
 */
function owlBuildInfo(buildId: string): Plugin {
	return {
		name: "owl-build-info",
		apply: "build",
		generateBundle() {
			const inputs = [...this.getModuleIds()]
				.filter((id) => !id.startsWith("\0") && !id.includes("node_modules"))
				.map((id) => toRepoPath(repoRoot, resolve(id.split("?")[0])))
				.filter((path): path is string => path !== undefined);
			const info = createBuildInfo({ component: "ui", repoRoot, inputs, protocol: true, buildId });
			this.emitFile({ type: "asset", fileName: BUILD_INFO_FILE, source: `${JSON.stringify(info, null, "\t")}\n` });
		},
	};
}

export default defineConfig(({ command }) => {
	const buildId = randomUUID();
	const uiBuild = command === "build" ? { buildId, protocolHash: computeProtocolHash(repoRoot) } : { buildId: "dev" };
	return {
		define: { __OWL_UI_BUILD__: JSON.stringify(uiBuild) },
		// TEMP debug entry（owl-genui 引擎调试页 + 轨迹/自动化任务调试页）；问题排查完可移除
		build: { rollupOptions: { input: { main: "index.html", debug: "debug-genui.html", trajectory: "debug-trajectory.html", automation: "debug-automation.html" } } },
		plugins: [react(), tailwindcss(), owlBuildInfo(buildId)],
		server: {
			port: 5188,
			// 端口被占直接失败：vite 默认会静默换端口，而 tauri devUrl 固定 5188，
			// 窗口会悄悄连上一个不相干的服务器（owl-tauri-dev.cmd 会先清端口）
			strictPort: true,
			watch: {
				ignored: ["**/src-tauri/**"],
			},
			proxy: {
				"/api/maps": {
					target: (process.env.PI_RE_BRIDGE ?? "ws://127.0.0.1:8787").replace(/^ws/, "http"),
				},
				// dev: WebSocket through vite to the local bridge
				"/ws": {
					// 8787 默认端口被 manager 网关占用时，用 PI_RE_BRIDGE 指到桥的实际端口
					target: process.env.PI_RE_BRIDGE ?? "ws://127.0.0.1:8787",
					ws: true,
				},
			},
			fs: {
				allow: ["../.."],
			},
		},
	};
});
