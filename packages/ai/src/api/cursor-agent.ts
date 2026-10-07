/**
 * Cursor native AgentService stream — bootstraps @rahularya01/pi-cursor's
 * Connect/protobuf streamSimple and feeds it Owl-resolved access tokens.
 *
 * Attribution: stream implementation from MIT-licensed @rahularya01/pi-cursor
 * (community reverse-engineered Cursor wire protocol). Unofficial; may break.
 */

import type {
	Api,
	AssistantMessage,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

type NativeStream = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions | SimpleStreamOptions,
) => AssistantMessageEventStream;

type NativeRefreshModels = (context: {
	force?: boolean;
	allowNetwork?: boolean;
	signal?: AbortSignal;
}) => Promise<readonly Record<string, unknown>[]>;

type PiCursorExtension = (api: {
	on: (...args: unknown[]) => void;
	registerCommand: (...args: unknown[]) => void;
	registerProvider: (
		id: string,
		config: {
			streamSimple?: NativeStream;
			stream?: NativeStream;
			refreshModels?: NativeRefreshModels;
			models?: readonly Record<string, unknown>[];
		},
	) => void;
}) => void | Promise<void>;

interface NativeCapabilities {
	stream: NativeStream;
	refreshModels?: NativeRefreshModels;
	seedModels: readonly Record<string, unknown>[];
}

let boot: Promise<NativeCapabilities> | undefined;
let native: NativeCapabilities | undefined;

async function loadNativeCapabilities(): Promise<NativeCapabilities> {
	if (native) return native;

	let capturedStream: NativeStream | undefined;
	let capturedRefresh: NativeRefreshModels | undefined;
	let capturedModels: readonly Record<string, unknown>[] = [];
	const stub = {
		on: () => {},
		registerCommand: () => {},
		registerProvider: (
			_id: string,
			config: {
				streamSimple?: NativeStream;
				stream?: NativeStream;
				refreshModels?: NativeRefreshModels;
				models?: readonly Record<string, unknown>[];
			},
		) => {
			capturedStream = config.streamSimple ?? config.stream;
			capturedRefresh = config.refreshModels;
			if (Array.isArray(config.models)) capturedModels = config.models;
		},
	};

	const mod = (await import("@rahularya01/pi-cursor")) as { default: PiCursorExtension };
	await mod.default(stub);

	if (!capturedStream) {
		throw new Error("Cursor native stream failed to register (pi-cursor extension)");
	}
	native = {
		stream: capturedStream,
		...(capturedRefresh ? { refreshModels: capturedRefresh } : {}),
		seedModels: capturedModels,
	};
	return native;
}

function ensureNativeCapabilities(): Promise<NativeCapabilities> {
	boot ??= loadNativeCapabilities().catch((error) => {
		boot = undefined;
		throw error;
	});
	return boot;
}

function applyAccessToken(apiKey?: string): void {
	if (typeof apiKey === "string" && apiKey.trim()) {
		process.env.CURSOR_ACCESS_TOKEN = apiKey.trim();
	}
}

function errorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function wrapStream(
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions | SimpleStreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			applyAccessToken(options?.apiKey);
			const caps = await ensureNativeCapabilities();
			const inner = caps.stream(model, context, options);
			for await (const event of inner) {
				outer.push(event);
			}
			outer.end(await inner.result());
		} catch (error) {
			const message = errorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		}
	})();
	return outer;
}

/** Eagerly warm the native stream (safe to call at provider construction). */
export function warmCursorAgentStream(): void {
	void ensureNativeCapabilities().catch(() => {
		// First stream call will surface the error.
	});
}

/**
 * Live Cursor catalog via pi-cursor's GetUsableModels + AvailableModels discovery.
 * Requires a bearer access token; returns [] when discovery is unavailable.
 */
export async function discoverCursorNativeModels(
	accessToken: string,
	signal?: AbortSignal,
): Promise<Model<"cursor-native">[]> {
	applyAccessToken(accessToken);
	const caps = await ensureNativeCapabilities();
	if (!caps.refreshModels) return [];
	const rows = await caps.refreshModels({ force: true, allowNetwork: true, signal });
	const result: Model<"cursor-native">[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const id = typeof row.id === "string" ? row.id : undefined;
		if (!id) continue;
		result.push({
			id,
			name: typeof row.name === "string" ? row.name : id,
			api: "cursor-native",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: row.reasoning === true,
			input: Array.isArray(row.input)
				? (row.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image") as (
						| "text"
						| "image"
					)[])
				: ["text", "image"],
			cost:
				row.cost && typeof row.cost === "object"
					? {
							input: Number((row.cost as { input?: unknown }).input) || 0,
							output: Number((row.cost as { output?: unknown }).output) || 0,
							cacheRead: Number((row.cost as { cacheRead?: unknown }).cacheRead) || 0,
							cacheWrite: Number((row.cost as { cacheWrite?: unknown }).cacheWrite) || 0,
						}
					: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : 200_000,
			maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : 64_000,
			...(row.thinkingLevelMap && typeof row.thinkingLevelMap === "object"
				? { thinkingLevelMap: row.thinkingLevelMap as Model<"cursor-native">["thinkingLevelMap"] }
				: {}),
		});
	}
	return result;
}

export function cursorAgentApi(): ProviderStreams {
	warmCursorAgentStream();
	return {
		stream: (model, context, options) => wrapStream(model, context, options),
		streamSimple: (model, context, options) => wrapStream(model, context, options),
	};
}
