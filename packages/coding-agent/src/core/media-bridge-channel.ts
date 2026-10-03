/**
 * 「媒体桥」HTTP 通道注册表——与 question-channel 同一套单例接缝。
 *
 * owl-media-bridge 以普通插件形式加载（settings plugins 里的 owl-media-bridge），
 * 但 /media-bridge/api/* 的同源 HTTP 路由只有桌面桥能挂：桥进程在分发链里向
 * 这里取处理器（getMediaBridgeHttpHandler），插件侧在工厂里用
 * setMediaBridgeHttpHandler 注入。未加载插件（或 print/-p 模式）时处理器缺位，
 * 桥的分发链直接落到下一站，行为与没有媒体桥时完全一致——纯增量。
 *
 * 单例语义：桥与插件运行在同一进程，经 @owl/owl-coding-agent 别名拿到的是
 * 同一份 dist 模块实例，这里就是两边共享的接缝。类型刻意保持结构化，
 * 避免核心反向依赖 owl-media-bridge 包。
 */

/** 结构化请求视图：Node IncomingMessage 的窄投影（同 owl-media-bridge 的 BridgeHttpRequest）。 */
export interface MediaBridgeHttpRequest {
	url?: string;
	method?: string;
	headers: Record<string, string | string[] | undefined>;
	// 读 POST 请求体必须可迭代；IncomingMessage 天然满足。
	[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

/** 结构化响应视图：Node ServerResponse 的窄投影。 */
export interface MediaBridgeHttpResponse {
	statusCode: number;
	writeHead(status: number, headers?: Record<string, string>): unknown;
	end(body?: string): unknown;
}

/** 桥传入的选项：把桌面桥已有的来源信任判定交给媒体桥复用。 */
export interface MediaBridgeHttpOptions {
	authorizeOrigin?: (origin: string | undefined) => boolean;
}

/** 返回 true 表示该请求属于 /media-bridge/api/* 且已应答。 */
export type MediaBridgeHttpHandler = (
	request: MediaBridgeHttpRequest,
	response: MediaBridgeHttpResponse,
	options: MediaBridgeHttpOptions,
) => Promise<boolean>;

let handler: MediaBridgeHttpHandler | undefined;

/** 插件工厂注入处理器；传 undefined 摘除（扩展重载/卸载时）。 */
export function setMediaBridgeHttpHandler(next: MediaBridgeHttpHandler | undefined): void {
	handler = next;
}

export function getMediaBridgeHttpHandler(): MediaBridgeHttpHandler | undefined {
	return handler;
}
