/**
 * owl MCP lite: connect stdio/HTTP MCP servers with the official SDK and
 * expose their tools per the configured exposure.
 *
 * - `direct`（默认需显式写）：工具作为原生工具声明给模型；
 * - `codemode`（配置默认值）：工具注册为 codemode 暴露——不直接声明给模型，
 *   但内置 `codemode` 工具激活后可从脚本经 `ctx.executeTool()` 调用，描述里
 *   只列服务器命名空间，省 token；
 * - `deferred`：同 codemode 可调用，另可被 tool_search 发现；
 * - `hidden`：不注册。
 *
 * Config shape matches core/mcp-servers.ts so settings can carry servers as
 * `{ mcpServers: { <name>: McpServerConfig } }`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { ToolDefinition, ToolNamespace } from "./extensions/index.ts";
import { getMcpToolExposure, type McpServerConfig } from "./mcp-servers.ts";

interface McpConnection {
	name: string;
	client: Client;
	tools: ToolDefinition[];
	close(): Promise<void>;
}

export interface McpConnections {
	tools: ToolDefinition[];
	connections: McpConnection[];
	close(): Promise<void>;
}

export async function connectMcpServers(
	servers: Record<string, McpServerConfig>,
	onDiagnostic?: (message: string) => void,
): Promise<McpConnections> {
	const connections: McpConnection[] = [];
	const tools: ToolDefinition[] = [];

	for (const [name, config] of Object.entries(servers)) {
		if (config.enabled === false) continue;
		try {
			const connection = await connectServer(name, config, onDiagnostic);
			connections.push(connection);
			tools.push(...connection.tools);
		} catch (error) {
			onDiagnostic?.(`MCP server "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		tools,
		connections,
		async close() {
			for (const connection of connections) {
				await connection.close().catch(() => {});
			}
		},
	};
}

async function connectServer(
	name: string,
	config: McpServerConfig,
	onDiagnostic?: (message: string) => void,
): Promise<McpConnection> {
	const client = new Client({ name: "owl", version: "1.0.0" });
	const http = config as { url?: string; headers?: Record<string, string> };
	const stdio = config as { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
	const transport =
		"url" in config && typeof http.url === "string"
			? new StreamableHTTPClientTransport(new URL(http.url), {
					requestInit: { headers: http.headers },
				})
			: new StdioClientTransport({
					command: stdio.command,
					args: stdio.args ?? [],
					env: stdio.env,
					cwd: stdio.cwd,
				});
	await client.connect(transport);

	const listing = await client.listTools();
	const namespace: ToolNamespace = {
		name: `mcp_${name}`.replace(/[^A-Za-z0-9_-]/g, "_"),
		description: config.description ?? `Tools of the "${name}" MCP server.`,
		instructions: undefined,
	};
	const definitions: ToolDefinition[] = [];
	const counts = { direct: 0, codemode: 0, deferred: 0 };
	for (const tool of listing.tools) {
		const exposure = getMcpToolExposure(config, tool.name);
		if (exposure === "hidden") continue;
		counts[exposure === "direct" ? "direct" : exposure === "deferred" ? "deferred" : "codemode"]++;
		definitions.push(
			defineMcpTool(
				name,
				client,
				{
					name: tool.name,
					description: tool.description ?? "",
					inputSchema: tool.inputSchema,
				},
				exposure,
				namespace,
			),
		);
	}
	onDiagnostic?.(
		`MCP server "${name}": ${counts.direct} direct, ${counts.codemode} codemode, ${counts.deferred} deferred tool(s)`,
	);

	return {
		name,
		client,
		tools: definitions,
		async close() {
			await client.close();
		},
	};
}

function defineMcpTool(
	server: string,
	client: Client,
	tool: { name: string; description: string; inputSchema: unknown },
	exposure: "direct" | "codemode" | "deferred",
	namespace: ToolNamespace,
): ToolDefinition {
	const definition = {
		name: `mcp_${server}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_"),
		label: `${server}: ${tool.name}`,
		description: `[MCP:${server}] ${tool.description}`,
		parameters: Type.Unsafe(tool.inputSchema as never),
		// direct 走工具系统默认；codemode/deferred 注册即可被 codemode 脚本经 ctx.executeTool 调用
		...(exposure !== "direct" ? { exposure } : {}),
		namespace,
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const result = (await client.callTool({
				name: tool.name,
				arguments: (params ?? {}) as Record<string, unknown>,
			})) as {
				content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
				isError?: boolean;
			};
			const content = (result.content ?? [])
				.map((part: any) =>
					part.type === "image"
						? { type: "image" as const, data: part.data, mimeType: part.mimeType }
						: { type: "text" as const, text: String(part.text ?? "") },
				)
				.filter((part: any) => part.type === "text" || part.type === "image");
			return {
				content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
				details: undefined,
				...(result.isError === true ? { isError: true } : {}),
			};
		},
	} as unknown as ToolDefinition;
	return definition;
}
