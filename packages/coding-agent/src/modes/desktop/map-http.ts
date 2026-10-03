import type { IncomingMessage, ServerResponse } from "node:http";
import type { MapCategory, MapCoordinate } from "../../core/maps/types.ts";
import type { RealMapService } from "./map-service.ts";

export interface MapHttpOptions {
	service: Pick<RealMapService, "geocode" | "nearby" | "reverse">;
	authorizeOrigin?: (origin: string | undefined) => boolean;
}

function numberParameter(url: URL, name: string, minimum: number, maximum: number, fallback?: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null && fallback !== undefined) return fallback;
	if (raw === null || !raw.trim()) throw new Error(`缺少参数 ${name}`);
	const value = Number(raw);
	if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} 超出有效范围`);
	return value;
}

function point(url: URL): MapCoordinate {
	return { lat: numberParameter(url, "lat", -90, 90), lng: numberParameter(url, "lng", -180, 180) };
}

function category(url: URL): MapCategory {
	const value = url.searchParams.get("category") ?? "all";
	if (value !== "all" && value !== "cafe" && value !== "restaurant" && value !== "park" && value !== "museum") {
		throw new Error("不支持的地点分类");
	}
	return value;
}

function send(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

/** A bounded read-only API; clients never submit an upstream URL or raw Overpass query. */
export async function handleMapHttp(
	request: IncomingMessage,
	response: ServerResponse,
	options: MapHttpOptions,
): Promise<boolean> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (!url.pathname.startsWith("/api/maps/")) return false;
	if (options.authorizeOrigin && !options.authorizeOrigin(request.headers.origin)) {
		send(response, { error: "地图接口只接受本地桌面请求" }, 403);
		return true;
	}
	if (request.method !== "GET") {
		response.setHeader("Allow", "GET");
		send(response, { error: "地图接口只支持 GET" }, 405);
		return true;
	}
	try {
		const language = url.searchParams.get("lang") === "en" ? "en" : "zh";
		const limit = numberParameter(url, "limit", 1, 30, 12);
		if (!Number.isInteger(limit)) throw new Error("limit 必须是整数");
		if (url.pathname === "/api/maps/search") {
			const query = (url.searchParams.get("q") ?? "").trim();
			if (!query || query.length > 200) throw new Error("搜索地点须为 1–200 个字符");
			const hasCenter = url.searchParams.has("lat") || url.searchParams.has("lng");
			send(
				response,
				await options.service.geocode({ query, limit, language, ...(hasCenter ? { center: point(url) } : {}) }),
			);
		} else if (url.pathname === "/api/maps/nearby") {
			const radiusMeters = numberParameter(url, "radius", 100, 5000, 2000);
			send(
				response,
				await options.service.nearby({ center: point(url), category: category(url), radiusMeters, limit }),
			);
		} else if (url.pathname === "/api/maps/reverse") {
			send(response, await options.service.reverse({ point: point(url), language }));
		} else {
			send(response, { error: "地图接口不存在" }, 404);
		}
	} catch (error) {
		send(response, { error: error instanceof Error ? error.message : "地图查询失败" }, 400);
	}
	return true;
}
