import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { NewsMaterial, NewsSourceInput } from "../src/core/news/types.ts";
import type { ServerResponseMessage } from "../src/modes/desktop/protocol.ts";
import { type DesktopServerHandle, startDesktopServer } from "../src/modes/desktop/serve.ts";

it("forwards public DNS fallback to source previews through the desktop host", async () => {
	const root = resolve(await mkdtemp(join(tmpdir(), "owl-news-host-")));
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("owl-news-host-")) {
		throw new Error("Unsafe news host cleanup target");
	}
	const agentDir = join(root, "profile");
	const cwd = join(root, "workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ plugins: [] }));
	vi.stubEnv("OWL_CODING_AGENT_DIR", agentDir);
	const forbiddenFetch = vi.fn<typeof fetch>(async () => {
		throw new Error("Real network calls are forbidden in news host tests");
	});
	vi.stubGlobal("fetch", forbiddenFetch);
	const resolvePublicHost = vi.fn(async (_host: string, signal: AbortSignal) => {
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
		return ["93.184.216.34"];
	});
	const fetchSource = vi.fn<typeof fetch>(async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		expect(url).toBe("https://desktop-news-fakeip.test/feed.xml");
		return new Response(
			"<rss><channel><item><title>Fixture article</title><link>https://desktop-news-fakeip.test/item</link></item></channel></rss>",
		);
	});
	const callModel = vi.fn(async () => {
		throw new Error("Model calls are forbidden in news host tests");
	});
	const source: NewsSourceInput = {
		id: "desktop-fakeip",
		name: "Offline feed fixture",
		kind: "rss",
		config: { feedUrl: "https://desktop-news-fakeip.test/feed.xml" },
		tier: "T2",
		participation: "editorial",
		enabled: false,
		intervalMinutes: 60,
		siteFulltext: false,
		syndicateFulltext: false,
	};
	let bridge: DesktopServerHandle | undefined;
	let socket: WebSocket | undefined;
	try {
		bridge = await startDesktopServer({
			port: 0,
			agentDir,
			cwd,
			mcpServers: {},
			onDiagnostic: () => {},
			news: {
				fetch: fetchSource,
				resolveHost: async () => ["198.18.0.1"],
				resolvePublicHost,
				listModels: () => [],
				callModel,
			},
		});
		socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
		const connected = socket;
		await new Promise<void>((done, reject) => {
			connected.once("open", done);
			connected.once("error", reject);
		});
		const response = await new Promise<ServerResponseMessage & { result?: NewsMaterial[] }>((done, reject) => {
			const timer = setTimeout(() => reject(new Error("News host preview timed out")), 5000);
			connected.on("message", (data) => {
				const message = JSON.parse(String(data)) as ServerResponseMessage & { result?: NewsMaterial[] };
				if (message.type !== "response" || message.id !== "preview-fakeip") return;
				clearTimeout(timer);
				done(message);
			});
			connected.send(
				JSON.stringify({
					type: "news.request",
					id: "preview-fakeip",
					request: { action: "previewSource", source },
				}),
			);
		});
		expect(response.ok, response.error).toBe(true);
		expect(response.result).toEqual([expect.objectContaining({ title: "Fixture article" })]);
		expect(resolvePublicHost).toHaveBeenCalledTimes(1);
		expect(resolvePublicHost).toHaveBeenCalledWith("desktop-news-fakeip.test", expect.any(AbortSignal));
		expect(fetchSource).toHaveBeenCalledTimes(1);
		expect(callModel).not.toHaveBeenCalled();
		expect(forbiddenFetch).not.toHaveBeenCalled();
	} finally {
		socket?.terminate();
		await bridge?.close();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
