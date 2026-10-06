/**
 * 极简路由 —— method + 路径模式匹配，":name" 段捕获参数。
 * 路径不匹配返回 false，交给下一个 handler（对齐 map-http 的 handler 链模式）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { respondOk } from "./respond.ts";

export interface RequestContext {
	request: IncomingMessage;
	response: ServerResponse;
	params: Record<string, string>;
	query: URLSearchParams;
	/** 已解析的 JSON 请求体（按需读取，避免 GET 也吃流）。 */
	readBody<T = unknown>(): Promise<T>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<unknown>;

interface Route {
	method: string;
	segments: string[];
	handler: RouteHandler;
}

export class Router {
	readonly #routes: Route[] = [];

	/** 注册路由；pattern 形如 "/api/accounts/:id"。 */
	add(method: string, pattern: string, handler: RouteHandler): this {
		this.#routes.push({
			method: method.toUpperCase(),
			segments: pattern.split("/").filter((part) => part.length > 0),
			handler,
		});
		return this;
	}

	get(pattern: string, handler: RouteHandler): this {
		return this.add("GET", pattern, handler);
	}

	post(pattern: string, handler: RouteHandler): this {
		return this.add("POST", pattern, handler);
	}

	put(pattern: string, handler: RouteHandler): this {
		return this.add("PUT", pattern, handler);
	}

	patch(pattern: string, handler: RouteHandler): this {
		return this.add("PATCH", pattern, handler);
	}

	delete(pattern: string, handler: RouteHandler): this {
		return this.add("DELETE", pattern, handler);
	}

	/** 尝试匹配并执行；未命中返回 false（让调用方 404）。 */
	async handle(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		readBody: RequestContext["readBody"],
	): Promise<boolean> {
		const pathSegments = url.pathname.split("/").filter((part) => part.length > 0);
		for (const route of this.#routes) {
			if (route.method !== request.method) {
				continue;
			}
			const params = matchSegments(route.segments, pathSegments);
			if (params === null) {
				continue;
			}
			const result = await route.handler({
				request,
				response,
				params,
				query: url.searchParams,
				readBody,
			});
			if (result !== undefined && !response.writableEnded) {
				respondOk(response, result);
			}
			return true;
		}
		return false;
	}
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
	if (pattern.length !== actual.length) {
		return null;
	}
	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.length; i++) {
		const expected = pattern[i]!;
		const value = actual[i]!;
		if (expected.startsWith(":")) {
			params[expected.slice(1)] = decodeURIComponent(value);
		} else if (expected !== value) {
			return null;
		}
	}
	return params;
}
