/**
 * 桥插件：桌面桥进程启动时加载一次、关闭时释放的进程级插件。
 *
 * 与会话扩展（package.json `owl.extensions`，每个会话加载）不同，桥插件声明在
 * `owl.bridge` 里，挂的是进程级的桌面功能（壁纸、地图等）；需要进会话的只有它提供的工具。来源复用全局设置的
 * `plugins` 列表，只认本地目录；插件只依赖这里的结构化类型，核心不反向依赖插件包。
 * 单个插件加载或处理失败只记诊断，不影响桥和其他插件。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { PluginSource } from "../../core/settings-manager.ts";
import type { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";
import { stripBom } from "../../utils/text.ts";
import type { collectUsageStats } from "./usage-stats.ts";

/** 宿主交给插件的能力：插件只通过这里拿核心功能，不直接导入核心内部模块。 */
export interface BridgePluginContext {
	agentDir: string;
	/** 桌面来源判定（与 WebSocket 握手同一规则）。 */
	isTrustedOrigin(origin: string | undefined): boolean;
	/** 现读全局 settings.json 的一个顶层字段；读不出返回 undefined。 */
	getGlobalSetting(key: string): Promise<unknown>;
	onDiagnostic(message: string): void;
	/** 推给所有已连接的 UI；消息类型由插件自己的协议定义。 */
	broadcast<Message extends BridgeServerMessage>(message: Message): void;
	/** cwd 对应的会话目录（与会话管理器同一编码规则）。 */
	sessionDirFor(cwd: string): string;
	/** owl 自身的用量聚合（设置页「使用统计」同一口径）。 */
	collectUsageStats: typeof collectUsageStats;
	/** 多个桥进程共用 agentDir 时的落盘约定：带锁、原子写、损坏备份。 */
	files: {
		atomicWriteFileSync: typeof atomicWriteFileSync;
		backupCorruptFile: typeof backupCorruptFile;
		withFileLockSync: typeof withFileLockSync;
	};
}

/** UI 经 WebSocket 发来的请求（type + id + 各自的载荷字段）。 */
export interface BridgeRequest {
	type: string;
	id: string;
	[field: string]: unknown;
}

export interface BridgeRequestClient {
	/** 发起连接的页面来源（握手时的 Origin 头）。 */
	origin: string | undefined;
}

/** 桥推给 UI 的消息。 */
export interface BridgeServerMessage {
	type: string;
}

/** 正在构建的编码会话（pi 运行时与邮箱、研究等专用会话不注入插件工具）。 */
export interface BridgeSession {
	sessionId: string;
	cwd: string;
}

/** 返回值作为 result 回给 UI；抛错则回 ok:false。 */
export type BridgeRequestHandler = (request: BridgeRequest, client: BridgeRequestClient) => unknown;

export interface BridgePlugin {
	/** 处理了返回 true；不属于本插件的请求返回 false，交给分发链下一站。 */
	handleHttp?(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
	/** 本插件认领的请求类型 → 处理函数；内核已有的类型不会分发到这里。 */
	requests?: Readonly<Record<string, BridgeRequestHandler>>;
	/** 每个编码会话构建时调用一次，返回的工具与内置自定义工具一起注册。 */
	sessionTools?(session: BridgeSession): ToolDefinition[] | Promise<ToolDefinition[]>;
	close?(): void | Promise<void>;
}

export type BridgePluginFactory = (context: BridgePluginContext) => BridgePlugin | Promise<BridgePlugin>;

export interface LoadedBridgePlugin {
	name: string;
	plugin: BridgePlugin;
}

/** 插件目录 package.json 里 `owl.bridge` 声明的入口（绝对路径，只保留存在的文件）。 */
export function bridgeEntriesOf(pluginDir: string): string[] {
	const packageJsonPath = join(pluginDir, "package.json");
	if (!existsSync(packageJsonPath)) return [];
	try {
		const pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { owl?: { bridge?: unknown } };
		const entries = pkg.owl?.bridge;
		if (!Array.isArray(entries)) return [];
		return entries
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => resolve(pluginDir, entry))
			.filter((entry) => existsSync(entry));
	} catch {
		return [];
	}
}

function packageNameOf(pluginDir: string): string {
	try {
		const pkg = JSON.parse(stripBom(readFileSync(join(pluginDir, "package.json"), "utf-8"))) as { name?: unknown };
		if (typeof pkg.name === "string" && pkg.name) return pkg.name;
	} catch {}
	return pluginDir;
}

/** settings.plugins 里启用的本地目录；相对路径按 agentDir 解析（与包管理器的用户级来源一致）。 */
export function localPluginDirs(sources: readonly PluginSource[], agentDir: string): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	for (const entry of sources) {
		if (typeof entry === "object" && entry.disabled === true) continue;
		const source = typeof entry === "string" ? entry : entry.source;
		if (!source || /^(npm|git|https?):/i.test(source)) continue;
		const dir = isAbsolute(source) ? source : resolve(agentDir, source);
		const key = process.platform === "win32" ? dir.toLowerCase() : dir;
		if (seen.has(key)) continue;
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		seen.add(key);
		dirs.push(dir);
	}
	return dirs;
}

export async function loadBridgePlugins(
	sources: readonly PluginSource[],
	context: BridgePluginContext,
	importModule: (modulePath: string) => Promise<unknown>,
): Promise<LoadedBridgePlugin[]> {
	const loaded: LoadedBridgePlugin[] = [];
	for (const dir of localPluginDirs(sources, context.agentDir)) {
		const entries = bridgeEntriesOf(dir);
		if (entries.length === 0) continue;
		const name = packageNameOf(dir);
		for (const entry of entries) {
			try {
				const factory = await importModule(entry);
				if (typeof factory !== "function") {
					context.onDiagnostic(`bridge plugin ${name}: ${entry} 没有默认导出工厂函数`);
					continue;
				}
				loaded.push({ name, plugin: await (factory as BridgePluginFactory)(context) });
			} catch (error) {
				context.onDiagnostic(
					`bridge plugin ${name} 加载失败：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	return loaded;
}

/** 请求类型 → 处理函数；两个插件认领同一类型时先加载的生效，并记诊断。 */
export function bridgeRequestRoutes(
	plugins: readonly LoadedBridgePlugin[],
	onDiagnostic: (message: string) => void,
): Map<string, BridgeRequestHandler> {
	const routes = new Map<string, BridgeRequestHandler>();
	const owners = new Map<string, string>();
	for (const { name, plugin } of plugins) {
		for (const [type, handler] of Object.entries(plugin.requests ?? {})) {
			const owner = owners.get(type);
			if (owner) {
				onDiagnostic(`bridge plugin ${name}: 请求类型 ${type} 已由 ${owner} 认领，忽略`);
				continue;
			}
			owners.set(type, name);
			routes.set(type, handler);
		}
	}
	return routes;
}

/** 依次交给各插件；某个插件抛错时回 500 并记诊断，不再往下传。 */
export async function handleBridgePluginHttp(
	plugins: readonly LoadedBridgePlugin[],
	request: IncomingMessage,
	response: ServerResponse,
	onDiagnostic: (message: string) => void,
): Promise<boolean> {
	for (const { name, plugin } of plugins) {
		if (!plugin.handleHttp) continue;
		try {
			if (await plugin.handleHttp(request, response)) return true;
		} catch (error) {
			onDiagnostic(`bridge plugin ${name} HTTP 处理失败：${error instanceof Error ? error.message : String(error)}`);
			if (!response.headersSent) {
				response
					.writeHead(500, { "Content-Type": "application/json" })
					.end(JSON.stringify({ error: `${name} 处理失败` }));
			}
			return true;
		}
	}
	return false;
}

/** 按加载顺序汇总各插件给该会话的工具；某个插件抛错只跳过它并记诊断，会话照常创建。 */
export async function bridgePluginSessionTools(
	plugins: readonly LoadedBridgePlugin[],
	session: BridgeSession,
	onDiagnostic: (message: string) => void,
): Promise<ToolDefinition[]> {
	const tools: ToolDefinition[] = [];
	for (const { name, plugin } of plugins) {
		if (!plugin.sessionTools) continue;
		try {
			tools.push(...(await plugin.sessionTools(session)));
		} catch (error) {
			onDiagnostic(
				`bridge plugin ${name} 会话工具创建失败：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return tools;
}

export async function closeBridgePlugins(
	plugins: readonly LoadedBridgePlugin[],
	onDiagnostic: (message: string) => void,
): Promise<void> {
	await Promise.all(
		plugins.map(async ({ name, plugin }) => {
			try {
				await plugin.close?.();
			} catch (error) {
				onDiagnostic(`bridge plugin ${name} 关闭失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}),
	);
}
