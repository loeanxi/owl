/**
 * owl-wallpaper 桥插件入口：把 /wallpaper/* 同源路由挂进桌面桥的 HTTP 分发链。
 * 壁纸在应用启动时就要显示，所以走桥插件（桥启动即加载），不走会话扩展。
 */

import type { BridgePluginContext, BridgePluginFactory } from "@owl/owl-coding-agent";
import { handleWallpaperHttp } from "./wallpaper-http.ts";

/** 读全局设置里的 owlWallpaper 字段（字段由桌面 UI 写入，插件只读）。 */
async function wallpaperField(context: BridgePluginContext, key: "customDir" | "customPath"): Promise<string> {
	const wallpaper = await context.getGlobalSetting("owlWallpaper");
	if (typeof wallpaper !== "object" || wallpaper === null) return "";
	const value = (wallpaper as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

const createWallpaperBridgePlugin: BridgePluginFactory = (context) => ({
	handleHttp: (request, response) =>
		handleWallpaperHttp(request, response, {
			authorizeOrigin: (origin) => context.isTrustedOrigin(origin),
			getCustomDir: () => wallpaperField(context, "customDir"),
			getCustomPath: () => wallpaperField(context, "customPath"),
		}),
});

export default createWallpaperBridgePlugin;
