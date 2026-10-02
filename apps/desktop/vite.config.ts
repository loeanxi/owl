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
				target: "ws://127.0.0.1:8787",
				ws: true,
			},
		},
		fs: {
			allow: ["../.."],
		},
	},
});
