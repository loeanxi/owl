import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	REA_ALLOWED_TOOLS,
	REA_PACKAGE_VERSION,
	ResearchReaClient,
	type ResearchReaSdkClient,
} from "../src/core/research/rea-client.ts";

const temporary: string[] = [];

async function fixture(version = REA_PACKAGE_VERSION) {
	const agentDir = await mkdtemp(join(tmpdir(), "owl-research-rea-client-"));
	temporary.push(agentDir);
	const root = join(agentDir, "tools", "research-rea");
	const packageRoot = join(root, "node_modules", "rea-agents");
	const ghidraHome = join(agentDir, "ghidra");
	const javaHome = join(agentDir, "java");
	await Promise.all([
		mkdir(join(packageRoot, "scripts"), { recursive: true }),
		mkdir(join(packageRoot, "dist"), { recursive: true }),
		mkdir(ghidraHome),
		mkdir(javaHome),
	]);
	await Promise.all([
		writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "rea-agents", version, description: "metadata ".repeat(2500) }),
		),
		writeFile(join(packageRoot, "scripts", "rea.mjs"), "// mock entry; never executed"),
		writeFile(join(packageRoot, "dist", "main.js"), "// mock runtime; never executed"),
		writeFile(
			join(root, "rea-toolchain.json"),
			JSON.stringify({
				version: REA_PACKAGE_VERSION,
				packageRoot,
				nodePath: process.execPath,
				ghidraHome,
				javaHome,
			}),
		),
	]);
	return { agentDir, root, packageRoot, ghidraHome, javaHome };
}

function adapter(result: CallToolResult = { content: [{ type: "text", text: "ok" }] }) {
	const transport: Transport = {
		start: vi.fn(async () => {}),
		send: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
	const client: ResearchReaSdkClient = {
		connect: vi.fn(async () => {}),
		listTools: vi.fn(async () => ({
			tools: REA_ALLOWED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" as const, properties: {} } })),
		})),
		getServerVersion: vi.fn(() => ({ name: "rea", version: REA_PACKAGE_VERSION })),
		callTool: vi.fn(async () => result),
		close: vi.fn(async () => {}),
	};
	const transportFactory = vi.fn((_parameters: StdioServerParameters) => transport);
	const clientFactory = vi.fn(() => client);
	return { client, transport, clientFactory, transportFactory };
}

afterEach(async () => {
	vi.useRealTimers();
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("research REA client", () => {
	it("inventories the fixed package without spawning and retains complete Evidence plus progress/deadline options", async () => {
		const data = await fixture();
		const evidence: CallToolResult = {
			content: [{ type: "text", text: '{"evidence_id":"ev_fixture"}' }],
			structuredContent: {
				evidence_id: "ev_fixture",
				normalized_result: { exact: "facts" },
				raw_result: { source: "provider" },
			},
		};
		const mock = adapter(evidence);
		const client = new ResearchReaClient("research-a", {
			agentDir: data.agentDir,
			environment: {
				PATH: "local-tools",
				SystemRoot: "C:\\Windows",
				OPENAI_API_KEY: "must-not-pass",
				MODEL_PROMPT: "must-not-pass",
				REA_BINARY_PATH: "must-not-pass",
			},
			...mock,
		});
		expect((await client.inventory()).status).toBe("available");
		expect(mock.clientFactory).not.toHaveBeenCalled();
		const progress = vi.fn();
		expect(
			await client.call("analyze_javascript_application", { input_path: "D:/fixture" }, undefined, progress),
		).toBe(evidence);
		const options = vi.mocked(mock.client.callTool).mock.calls[0][2];
		expect(options).toMatchObject({
			timeout: 360_000,
			maxTotalTimeout: 360_000,
			resetTimeoutOnProgress: false,
			onprogress: progress,
		});
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(vi.mocked(mock.client.connect).mock.calls[0][1]?.timeout).toBe(60_000);
		const launch = mock.transportFactory.mock.calls[0][0];
		expect(launch).toMatchObject({
			command: await realpath(process.execPath),
			args: [join(data.packageRoot, "scripts", "rea.mjs"), "mcp"],
			maxBufferSize: 10_485_760,
		});
		expect(launch.env).toMatchObject({
			PATH: "local-tools",
			SYSTEMROOT: "C:\\Windows",
			GHIDRA_INSTALL_DIR: data.ghidraHome,
			JAVA_HOME: data.javaHome,
			REA_GHIDRA_STARTUP_TIMEOUT_MS: "330000",
		});
		expect(launch.env).not.toHaveProperty("OPENAI_API_KEY");
		expect(launch.env).not.toHaveProperty("MODEL_PROMPT");
		expect(launch.env).not.toHaveProperty("REA_BINARY_PATH");
		expect(await client.close()).toMatchObject({ status: "complete", ownerSessionId: "research-a" });
		expect(mock.client.callTool).toHaveBeenLastCalledWith(
			{ name: "close_binary", arguments: {} },
			undefined,
			expect.objectContaining({ timeout: 10_000 }),
		);
		expect(mock.client.close).toHaveBeenCalledOnce();
		expect(mock.transport.close).toHaveBeenCalledOnce();
	});

	it("owns an independent MCP client for each research session and reuses its own connection", async () => {
		const data = await fixture();
		const first = adapter();
		const second = adapter();
		const a = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...first });
		const b = new ResearchReaClient("research-b", { agentDir: data.agentDir, ...second });
		await Promise.all([a.call("binary_session", {}), b.call("binary_session", {})]);
		await a.call("binary_overview", {});
		expect(first.clientFactory).toHaveBeenCalledOnce();
		expect(second.clientFactory).toHaveBeenCalledOnce();
		expect(first.client.connect).toHaveBeenCalledWith(first.transport, expect.anything());
		expect(second.client.connect).toHaveBeenCalledWith(second.transport, expect.anything());
		await a.close();
		expect(second.client.close).not.toHaveBeenCalled();
		await b.close();
	});

	it("rejects package/version mismatch and foreign tool names before subprocess creation", async () => {
		const data = await fixture("6.4.1");
		const mock = adapter();
		const client = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		expect(await client.inventory()).toMatchObject({ status: "invalidConfiguration", version: "6.4.1" });
		await expect(client.call("binary_session", {})).rejects.toThrow("版本不匹配");
		for (const name of ["capture_process_scenario", "install_adb_package", "set_comment", "unknown"]) {
			await expect(client.call(name, {})).rejects.toThrow("未开放");
		}
		expect(mock.transportFactory).not.toHaveBeenCalled();
	});

	it("refuses mismatched live server identities and preserves MCP isError text unchanged", async () => {
		const data = await fixture();
		const mock = adapter();
		vi.mocked(mock.client.getServerVersion).mockReturnValue({ name: "rea", version: "6.3.0" });
		const bad = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		await expect(bad.call("binary_session", {})).rejects.toThrow("实际服务版本");
		expect(mock.transport.close).toHaveBeenCalledOnce();
		const failure: CallToolResult = {
			isError: true,
			content: [{ type: "text", text: '{"error":{"code":"capability_unavailable"}}' }],
		};
		const errorMock = adapter(failure);
		const good = new ResearchReaClient("research-b", { agentDir: data.agentDir, ...errorMock });
		expect(await good.call("analyze_function", {})).toBe(failure);
		await good.close();
	});

	it("actively closes a cancelled connection, rejects concurrent state changes, and creates a fresh ledger for the next call", async () => {
		const data = await fixture();
		const first = adapter();
		const second = adapter();
		vi.mocked(first.client.callTool).mockImplementation(async () => await new Promise<CallToolResult>(() => {}));
		const factory = vi.fn().mockReturnValueOnce(first.client).mockReturnValueOnce(second.client);
		const transports = vi.fn().mockReturnValueOnce(first.transport).mockReturnValueOnce(second.transport);
		const client = new ResearchReaClient("research-a", {
			agentDir: data.agentDir,
			clientFactory: factory,
			transportFactory: transports,
		});
		const controller = new AbortController();
		const pending = client.call("binary_overview", {}, controller.signal);
		const rejection = expect(pending).rejects.toThrow("cancel fixture");
		await vi.waitFor(() => expect(first.client.callTool).toHaveBeenCalledOnce());
		await expect(client.call("open_binary", {})).rejects.toThrow("不能并行");
		controller.abort(new Error("cancel fixture"));
		await rejection;
		expect(first.client.close).toHaveBeenCalledOnce();
		expect(first.transport.close).toHaveBeenCalledOnce();
		await client.call("binary_session", {});
		expect(second.client.connect).toHaveBeenCalledOnce();
		await client.close();
	});

	it("closes the failed transport on SDK timeout and blocks reuse when cleanup fails", async () => {
		const data = await fixture();
		const mock = adapter();
		vi.mocked(mock.client.callTool).mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "fixture timeout"));
		vi.mocked(mock.transport.close).mockRejectedValue(new Error("fixture cleanup incomplete"));
		const client = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		await expect(client.call("binary_overview", {})).rejects.toMatchObject({
			cleanup: { status: "cleanupIncomplete", errors: ["MCP transport: fixture cleanup incomplete"] },
		});
		expect(mock.client.close).toHaveBeenCalledOnce();
		await expect(client.call("binary_session", {})).rejects.toThrow("上次清理未完成");
		expect(await client.close()).toMatchObject({ status: "cleanupIncomplete" });
		expect(mock.clientFactory).toHaveBeenCalledOnce();
	});

	it("uses existing native-toolchain paths and permits package-only installation without global settings changes", async () => {
		const data = await fixture();
		const nativeDir = join(data.agentDir, "tools", "research-decompilers");
		await mkdir(nativeDir);
		await writeFile(
			join(nativeDir, "native-toolchain.json"),
			JSON.stringify({ ghidraHome: data.ghidraHome, javaHome: data.javaHome }),
		);
		await rm(join(data.root, "rea-toolchain.json"));
		const settings = join(data.agentDir, "settings.json");
		await writeFile(settings, '{"mcpServers":{"other":{}}}');
		const mock = adapter();
		const client = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		expect(await client.inventory()).toMatchObject({
			status: "available",
			ghidraHome: data.ghidraHome,
			javaHome: data.javaHome,
		});
		await client.call("binary_session", {});
		await client.close();
		expect(await readFile(settings, "utf8")).toBe('{"mcpServers":{"other":{}}}');
		await expect(client.call("binary_session", {})).rejects.toThrow("已关闭");
	});

	it("does not launch when the caller is already cancelled", async () => {
		const data = await fixture();
		const mock = adapter();
		const client = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		await expect(client.call("binary_session", {}, controller.signal)).rejects.toThrow("already cancelled");
		expect(mock.transportFactory).not.toHaveBeenCalled();
	});

	it("bounds a hung initialize before a tool can run", async () => {
		const data = await fixture();
		const mock = adapter();
		vi.mocked(mock.client.connect).mockImplementation(async () => await new Promise<void>(() => {}));
		vi.useFakeTimers();
		const client = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		const pending = client.call("binary_session", {});
		const failure = expect(pending).rejects.toThrow("60000 ms");
		await vi.waitFor(() => expect(mock.client.connect).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(60_000);
		await failure;
		expect(mock.transport.close).toHaveBeenCalledOnce();
		expect(mock.client.callTool).not.toHaveBeenCalled();
	});

	it("disposes and terminates an active call when its research owner closes", async () => {
		const data = await fixture();
		const mock = adapter();
		vi.mocked(mock.client.callTool).mockImplementation(async () => await new Promise<CallToolResult>(() => {}));
		const client = new ResearchReaClient("research-a", { agentDir: data.agentDir, ...mock });
		const pending = client.call("binary_overview", {});
		const failure = expect(pending).rejects.toThrow("已关闭");
		await vi.waitFor(() => expect(mock.client.callTool).toHaveBeenCalledOnce());
		expect(await client.close()).toMatchObject({ status: "complete" });
		await failure;
		expect(mock.transport.close).toHaveBeenCalledOnce();
		await expect(client.call("binary_session", {})).rejects.toThrow("已关闭");
	});
});
