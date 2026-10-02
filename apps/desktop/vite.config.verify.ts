// 临时验证配置：忽略 src-tauri 构建产物（Windows 上被占用会导致 vite watch EBUSY 崩溃），验证完删除。
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

export default mergeConfig(
	base,
	defineConfig({
		server: {
			watch: { ignored: ["**/src-tauri/**"] },
		},
	}),
);
