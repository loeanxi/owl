import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	// TEMP debug entry（owl-genui 引擎调试页 + 轨迹/自动化任务调试页）；问题排查完可移除
	build: { rollupOptions: { input: { main: "index.html", debug: "debug-genui.html", trajectory: "debug-trajectory.html", automation: "debug-automation.html" } } },
	plugins: [react(), tailwindcss()],
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
});
