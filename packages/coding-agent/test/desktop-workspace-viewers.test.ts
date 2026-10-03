/// <reference lib="dom" />

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeClient } from "../../../apps/desktop/src/bridge/client.ts";
import type {
	ViewerChangedMessage,
	ViewerListResult,
	WorkspaceViewerOpenResult,
} from "../../../apps/desktop/src/bridge/protocol.ts";
import { registerWorkspaceViewer } from "../src/core/workspace-viewers.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

it("discovers, opens and unloads a plugin viewer through the real desktop WebSocket bridge", async () => {
	const root = await mkdtemp(join(tmpdir(), "owl-viewer-bridge-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	await writeFile(join(agentDir, "settings.json"), "{}");
	await writeFile(join(cwd, "report.univer"), "fixture");
	const reserved = createServer();
	await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
	const address = reserved.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	await new Promise<void>((resolve) => reserved.close(() => resolve()));
	const bridge = await startDesktopServer({
		port: address.port,
		agentDir,
		cwd,
		mcpServers: {},
		onDiagnostic: () => {},
	});
	const originalWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
	const client = new BridgeClient(`ws://127.0.0.1:${bridge.port}/ws`);
	let disposeViewer: (() => void) | undefined;
	try {
		await new Promise<void>((resolve) => {
			client.onStatus((connected) => {
				if (connected) resolve();
			});
			client.connect();
		});
		expect(await client.request<ViewerListResult>({ type: "viewer.list" })).toMatchObject({
			ok: true,
			result: { viewers: [] },
		});
		const changed = new Promise<ViewerChangedMessage>((resolve) => {
			const off = client.onViewersChanged((message) => {
				off();
				resolve(message);
			});
		});
		const calls: string[] = [];
		disposeViewer = registerWorkspaceViewer({
			id: "office",
			title: "Office",
			extensions: ["univer"],
			open: async (request) => {
				calls.push(request.path);
				return { url: "http://127.0.0.1:23456/uf?token=fixture", title: "Report" };
			},
		});
		expect((await changed).viewers).toEqual([{ id: "office", title: "Office", extensions: ["univer"] }]);
		expect(
			await client.request<WorkspaceViewerOpenResult>({
				type: "viewer.open",
				viewerId: "office",
				cwd,
				path: "report.univer",
			}),
		).toMatchObject({
			ok: true,
			result: { url: "http://127.0.0.1:23456/uf?token=fixture", title: "Report" },
		});
		expect(
			await client.request({ type: "viewer.open", viewerId: "office", cwd, path: "../secret.univer" }),
		).toMatchObject({ ok: false });
		expect(calls).toEqual(["report.univer"]);
		const unloaded = new Promise<ViewerChangedMessage>((resolve) => {
			const off = client.onViewersChanged((message) => {
				off();
				resolve(message);
			});
		});
		disposeViewer();
		expect((await unloaded).viewers).toEqual([]);
		expect(
			await client.request({ type: "viewer.open", viewerId: "office", cwd, path: "report.univer" }),
		).toMatchObject({ ok: false });
	} finally {
		disposeViewer?.();
		client.disconnect();
		await bridge.close();
		globalThis.WebSocket = originalWebSocket;
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);
