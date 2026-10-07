import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MirrorHub } from "../src/modes/desktop/mirror-hub.ts";
import type {
	DesktopClientRequestWithoutId,
	MirrorProjectionGeometry,
	ServerResponseMessage,
} from "../src/modes/desktop/protocol.ts";
import { startDesktopServer } from "../src/modes/desktop/serve.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

it("isolates projection input and cleanup across actual WebSocket connections", async () => {
	const geometry: MirrorProjectionGeometry = {
		geometryId: "crop-1",
		crop: { x: 4, y: 40, width: 840, height: 507 },
		sourceWidth: 906,
		sourceHeight: 547,
	};
	const project = vi.spyOn(MirrorHub.prototype, "projectWindow").mockResolvedValue(geometry);
	const input = vi.spyOn(MirrorHub.prototype, "inputWindow").mockImplementation(() => {});
	const restore = vi.spyOn(MirrorHub.prototype, "unembedWindow").mockResolvedValue();
	const attach = vi.spyOn(MirrorHub.prototype, "attach").mockImplementation(() => {});
	const detach = vi.spyOn(MirrorHub.prototype, "detach").mockImplementation(() => {});
	const directory = await mkdtemp(join(tmpdir(), "owl-mirror-bridge-"));
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("owl-mirror-bridge-"))
		throw new Error("Unsafe test cleanup target");
	const agentDir = join(directory, "profile");
	const cwd = join(directory, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	await writeFile(join(agentDir, "settings.json"), "{}");
	const bridge = await startDesktopServer({ port: 0, agentDir, cwd, mcpServers: {}, onDiagnostic: () => {} });
	const sockets: WebSocket[] = [];
	async function connect(): Promise<WebSocket> {
		const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, {
			headers: { Origin: `http://127.0.0.1:${bridge.port}` },
		});
		sockets.push(socket);
		await new Promise<void>((done, reject) => {
			socket.once("open", done);
			socket.once("error", reject);
		});
		return socket;
	}
	function request(socket: WebSocket, payload: DesktopClientRequestWithoutId): Promise<ServerResponseMessage> {
		const id = randomUUID();
		return new Promise((done, reject) => {
			const cleanup = (): void => {
				clearTimeout(timer);
				socket.off("message", receive);
				socket.off("close", closed);
			};
			const closed = (): void => {
				cleanup();
				reject(new Error("test socket closed"));
			};
			const receive = (data: unknown): void => {
				const response = JSON.parse(String(data)) as ServerResponseMessage;
				if (response.type !== "response" || response.id !== id) return;
				cleanup();
				done(response);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("mirror response timed out"));
			}, 5000);
			socket.on("message", receive);
			socket.once("close", closed);
			socket.send(JSON.stringify({ ...payload, id }));
		});
	}
	try {
		const first = await connect();
		const second = await connect();
		const click = {
			type: "mirror.input",
			windowId: "123",
			geometryId: "crop-1",
			action: "click",
			u: 0.5,
			v: 0.5,
		} as const;
		expect(await request(first, { type: "mirror.project", windowId: "123" })).toMatchObject({
			ok: true,
			result: geometry,
		});
		expect(await request(second, { type: "mirror.project", windowId: "123" })).toMatchObject({ ok: false });
		expect(await request(first, click)).toMatchObject({ ok: false });
		await request(first, { type: "mirror.attach", windowId: "123" });
		await request(first, { type: "mirror.attach", windowId: "123" });
		expect(attach).toHaveBeenCalledExactlyOnceWith("123");
		await request(second, { type: "mirror.detach", windowId: "123" });
		expect(detach).not.toHaveBeenCalled();
		expect(await request(first, click)).toMatchObject({ ok: true });
		expect(await request(second, click)).toMatchObject({ ok: false });
		expect(input).toHaveBeenCalledOnce();
		expect(await request(first, { type: "mirror.project", windowId: "123", visible: false })).toMatchObject({
			ok: true,
		});
		expect(await request(first, click)).toMatchObject({ ok: false });
		expect(await request(first, { ...click, action: "cancel", geometryId: "old-crop" })).toMatchObject({ ok: true });
		expect(await request(second, { type: "mirror.unembed", windowId: "123" })).toMatchObject({ ok: false });
		expect(await request(second, { type: "mirror.unembed", windowId: "0123" })).toMatchObject({ ok: false });
		expect(restore).not.toHaveBeenCalled();
		expect(await request(first, { type: "mirror.unembed", windowId: "123" })).toMatchObject({ ok: true });
		await request(first, { type: "mirror.detach", windowId: "123" });
		await request(first, { type: "mirror.detach", windowId: "123" });
		expect(detach).toHaveBeenCalledExactlyOnceWith("123");
		await request(second, { type: "mirror.project", windowId: "123" });
		await request(first, { type: "mirror.project", windowId: "456" });
		first.terminate();
		await vi.waitFor(() => expect(restore.mock.calls).toEqual([["123"], ["456"]]));

		const third = await connect();
		let release!: (value: MirrorProjectionGeometry) => void;
		project.mockImplementationOnce(
			() =>
				new Promise((done) => {
					release = done;
				}),
		);
		const pending = request(third, { type: "mirror.project", windowId: "789" });
		const disconnected = expect(pending).rejects.toThrow("test socket closed");
		await vi.waitFor(() => expect(project).toHaveBeenLastCalledWith("789", true));
		third.terminate();
		await disconnected;
		release(geometry);
		await vi.waitFor(() => expect(restore.mock.calls).toEqual([["123"], ["456"], ["789"]]));
		expect(await request(second, { type: "mirror.project", windowId: "123", visible: false })).toMatchObject({
			ok: true,
		});
	} finally {
		for (const socket of sockets) socket.terminate();
		await bridge.close();
		await rm(absolute, { recursive: true, force: true });
	}
}, 20_000);
