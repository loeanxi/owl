import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5188,
		proxy: {
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
