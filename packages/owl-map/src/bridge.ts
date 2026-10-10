/**
 * owl-map 桥插件入口：一个进程共用一份 RealMapService（限速、缓存都在里面），
 * 同时服务地图页的 /api/maps/* 和每个编码会话的 map_* 工具。
 */

import type { BridgePluginFactory } from "@owl/owl-coding-agent";
import { handleMapHttp } from "./map-http.ts";
import { RealMapService } from "./map-service.ts";
import { createMapTools } from "./map-tools.ts";

const createMapBridgePlugin: BridgePluginFactory = (context) => {
	const service = new RealMapService();
	return {
		handleHttp: (request, response) =>
			handleMapHttp(request, response, { service, authorizeOrigin: context.isTrustedOrigin }),
		sessionTools: ({ sessionId }) => createMapTools(service, sessionId, context.broadcast),
	};
};

export default createMapBridgePlugin;
