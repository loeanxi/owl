import type { BridgeRuntime } from "./bridge-runtime.ts";
import type { MediaCommand } from "./domain/types.ts";

export interface BridgeHttpRequest {
	readonly url?: string;
	readonly method?: string;
	readonly headers: Record<string, string | string[] | undefined>;
	[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

export interface BridgeHttpResponse {
	statusCode: number;
	writeHead(status: number, headers?: Record<string, string>): void;
	end(body?: string): void;
}

export interface BridgeWebServer {
	register(route: {
		kind: "prefix";
		path: string;
		handler: (request: BridgeHttpRequest, response: BridgeHttpResponse) => void | Promise<void>;
	}): () => void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** config/update 的合法补丁面（parseConfig 的输出）。 */
export type BridgeSettingsPatch = {
	allowAgentControl?: boolean;
	deepBackground?: boolean;
	realWaveEnabled?: boolean;
	softTransitions?: boolean;
	skipFadeOut?: boolean;
	preferLiveVideo?: boolean;
	playerId?: string;
};

/** 宿主传入的选项：桌面桥把已有的来源信任判定交给媒体桥复用。 */
export interface BridgeHttpOptions {
	readonly authorizeOrigin?: (origin: string | undefined) => boolean;
	/** 配置变更的持久化钩子（owl 写 <agentDir>/media-bridge/config.json）；失败向上抛成 400。 */
	readonly onConfigChange?: (patch: BridgeSettingsPatch) => void | Promise<void>;
}

/**
 * Handle one browser request against the same-origin plugin API. Resolves
 * false when the path is not under /media-bridge/api so hosts can chain
 * handlers; every owned path is answered exactly once and never throws.
 */
/** 成功信封 + 已应答标记。 */
function writeValue(response: BridgeHttpResponse, status: number, value: unknown): true {
	write(response, status, { ok: true, value });
	return true;
}

/** 失败信封 + 已应答标记。 */
function writeError(response: BridgeHttpResponse, status: number, error: string): true {
	write(response, status, { ok: false, error });
	return true;
}

export async function handleBridgeApiRequest(
	request: BridgeHttpRequest,
	response: BridgeHttpResponse,
	runtime: BridgeRuntime,
	options: BridgeHttpOptions = {},
): Promise<boolean> {
	const path = new URL(request.url ?? "/", "http://owl.local").pathname;
	if (path !== "/media-bridge/api" && !path.startsWith("/media-bridge/api/")) return false;
	// Same-origin remains the default gate; a host-provided check wins because
	// it knows the full desktop trust story (tauri:, localhost variants).
	const originOk =
		options.authorizeOrigin !== undefined
			? options.authorizeOrigin(header(request.headers.origin))
			: isSameOrigin(request);
	if (!originOk) return writeError(response, 403, "forbidden");
	if (request.method !== "POST") return writeError(response, 405, "method-not-allowed");

	try {
		const body = await readJsonBody(request);
		if (path === "/media-bridge/api/status") return writeValue(response, 200, await runtime.statusForUi());
		if (path === "/media-bridge/api/launch") {
			await runtime.launch();
			return writeValue(response, 200, { launched: true });
		}
		if (path === "/media-bridge/api/control") {
			await runtime.controlFromUi(parseMediaCommand(body));
			return writeValue(response, 200, await runtime.statusForUi());
		}
		if (path === "/media-bridge/api/control/undo") {
			await runtime.undoControl(parseActivityId(body));
			return writeValue(response, 200, await runtime.statusForUi());
		}
		if (path === "/media-bridge/api/volume/fade") {
			const fade = parseVolumeFade(body);
			await runtime.fadeFromUi(fade.volumePercent, fade.durationSeconds);
			return writeValue(response, 200, await runtime.statusForUi());
		}
		if (path === "/media-bridge/api/listening/report") {
			return writeValue(response, 200, await runtime.listeningReport(parseReportRange(body)));
		}
		if (path === "/media-bridge/api/memory/history") {
			return writeValue(response, 200, {
				today: runtime.memoryToday(),
				recent: runtime.memoryRecent(parseHistoryLimit(body)),
			});
		}
		if (path === "/media-bridge/api/memory/favorites") {
			return writeValue(response, 200, { favorites: runtime.memoryFavorites() });
		}
		if (path === "/media-bridge/api/memory/favorite/toggle") {
			await runtime.toggleMemoryFavorite(parseFavoriteTrack(body));
			return writeValue(response, 200, await runtime.statusForUi());
		}
		if (path === "/media-bridge/api/memory/favorite/remove") {
			const removed = runtime.removeMemoryFavorite(parseFavoriteKey(body));
			return writeValue(response, 200, { removed });
		}
		if (path === "/media-bridge/api/diagnose") return writeValue(response, 200, await runtime.diagnoseForUi());
		// Browser-only waveform frames; intentionally absent from model tools.
		if (path === "/media-bridge/api/signal") return writeValue(response, 200, await runtime.signalForUi());
		if (path === "/media-bridge/api/config") return writeValue(response, 200, runtime.getConfig());
		if (path === "/media-bridge/api/config/update") {
			const patch = parseConfig(body);
			const view = runtime.updateConfig(patch);
			await options.onConfigChange?.(patch);
			return writeValue(response, 200, view);
		}
		// Browser-owned Live playback mirror. The server never controls the
		// <video>; it only keeps a fresh capability boundary for agent tools.
		if (path === "/media-bridge/api/live/state") {
			runtime.reportLiveState(parseLiveState(body));
			return writeValue(response, 200, { reported: true });
		}
		return writeError(response, 404, "not-found");
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown media bridge error.";
		return writeError(response, 400, message);
	}
}

/** DSH-host shim kept for the unit tests: register the handler on a route table. */
export function registerBridgeHttpApi(server: BridgeWebServer, runtime: BridgeRuntime): () => void {
	return server.register({
		kind: "prefix",
		path: "/media-bridge/api",
		handler: async (request, response) => {
			await handleBridgeApiRequest(request, response, runtime);
		},
	});
}

async function readJsonBody(request: BridgeHttpRequest): Promise<unknown> {
	let text = "";
	for await (const chunk of request) {
		text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		if (text.length > 8 * 1024) throw new Error("Request body is too large.");
	}
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Request body must be valid JSON.");
	}
}

function parseConfig(value: unknown): {
	allowAgentControl?: boolean;
	deepBackground?: boolean;
	realWaveEnabled?: boolean;
	softTransitions?: boolean;
	skipFadeOut?: boolean;
	preferLiveVideo?: boolean;
	playerId?: string;
} {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Configuration must be an object.");
	const record = value as Record<string, unknown>;
	const allowAgentControl = record.allowAgentControl;
	if (allowAgentControl !== undefined && typeof allowAgentControl !== "boolean")
		throw new Error("allowAgentControl must be a boolean.");
	const deepBackground = record.deepBackground;
	if (deepBackground !== undefined && typeof deepBackground !== "boolean")
		throw new Error("deepBackground must be a boolean.");
	const realWaveEnabled = record.realWaveEnabled;
	if (realWaveEnabled !== undefined && typeof realWaveEnabled !== "boolean")
		throw new Error("realWaveEnabled must be a boolean.");
	const softTransitions = record.softTransitions;
	if (softTransitions !== undefined && typeof softTransitions !== "boolean")
		throw new Error("softTransitions must be a boolean.");
	const skipFadeOut = record.skipFadeOut;
	if (skipFadeOut !== undefined && typeof skipFadeOut !== "boolean") throw new Error("skipFadeOut must be a boolean.");
	const preferLiveVideo = record.preferLiveVideo;
	if (preferLiveVideo !== undefined && typeof preferLiveVideo !== "boolean")
		throw new Error("preferLiveVideo must be a boolean.");
	const playerId = record.playerId;
	if (playerId !== undefined && typeof playerId !== "string") throw new Error("playerId must be a string.");
	return {
		allowAgentControl,
		deepBackground,
		realWaveEnabled,
		softTransitions,
		skipFadeOut,
		preferLiveVideo,
		playerId,
	};
}

/** Browser-reported Live session state; both fields optional mirrors. */
function parseLiveState(value: unknown): { active?: boolean; playing?: boolean } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Live state must be an object.");
	const record = value as Record<string, unknown>;
	const active = record.active;
	if (active !== undefined && typeof active !== "boolean") throw new Error("active must be a boolean.");
	const playing = record.playing;
	if (playing !== undefined && typeof playing !== "boolean") throw new Error("playing must be a boolean.");
	return { ...(active !== undefined ? { active } : {}), ...(playing !== undefined ? { playing } : {}) };
}

function parseVolumeFade(value: unknown): { volumePercent: number; durationSeconds: number } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Volume fade request must be an object.");
	const record = value as Record<string, unknown>;
	const volumePercent = record.volumePercent;
	if (
		typeof volumePercent !== "number" ||
		!Number.isFinite(volumePercent) ||
		volumePercent < 0 ||
		volumePercent > 100
	) {
		throw new Error("volumePercent must be a finite number from 0 to 100.");
	}
	const durationSeconds = record.durationSeconds ?? 5;
	if (
		typeof durationSeconds !== "number" ||
		!Number.isFinite(durationSeconds) ||
		durationSeconds < 0 ||
		durationSeconds > 180
	) {
		throw new Error("durationSeconds must be a finite number from 0 to 180.");
	}
	return { volumePercent, durationSeconds };
}

function parseHistoryLimit(value: unknown): number {
	if (value === undefined || value === null) return 50;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("History request must be an object.");
	const limit = (value as Record<string, unknown>).limit;
	if (limit === undefined) return 50;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 400)
		throw new Error("limit must be an integer from 1 to 400.");
	return limit;
}

/** Track identity for favorite toggling; omitted fields mean "the current track". */
function parseFavoriteTrack(
	value: unknown,
): { playerId: string; title: string; artist: string; album?: string; artworkUrl?: string } | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Favorite request must be an object.");
	const record = value as Record<string, unknown>;
	if (
		record.title === undefined &&
		record.artist === undefined &&
		record.playerId === undefined &&
		record.album === undefined &&
		record.artworkUrl === undefined
	)
		return undefined;
	if (typeof record.title !== "string" || typeof record.artist !== "string")
		throw new Error("title and artist must be strings when toggling an explicit track.");
	if (record.title.trim() === "" || record.artist.trim() === "")
		throw new Error("title and artist must not be empty.");
	if (record.playerId !== undefined && typeof record.playerId !== "string")
		throw new Error("playerId must be a string.");
	if (record.album !== undefined && typeof record.album !== "string") throw new Error("album must be a string.");
	if (record.artworkUrl !== undefined && typeof record.artworkUrl !== "string")
		throw new Error("artworkUrl must be a string.");
	return {
		playerId:
			typeof record.playerId === "string" && record.playerId.trim() !== "" ? record.playerId : "unknown-player",
		title: record.title,
		artist: record.artist,
		...(record.album !== undefined ? { album: record.album } : {}),
		...(record.artworkUrl !== undefined ? { artworkUrl: record.artworkUrl } : {}),
	};
}

function parseFavoriteKey(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Favorite removal must be an object.");
	const key = (value as Record<string, unknown>).key;
	if (typeof key !== "string" || key.trim() === "") throw new Error("key must be a non-empty string.");
	return key;
}

function parseReportRange(value: unknown): "today" | "week" {
	if (
		value === undefined ||
		value === null ||
		(typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).range === undefined)
	) {
		return "week";
	}
	const range = (value as Record<string, unknown>).range;
	if (range !== "today" && range !== "week") throw new Error('range must be "today" or "week".');
	return range;
}

export function parseMediaCommand(value: unknown): MediaCommand {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Command must be an object.");
	const record = value as Record<string, unknown>;
	if (record.kind === "play-pause" || record.kind === "next" || record.kind === "previous")
		return { kind: record.kind };
	if (record.kind === "seek" && typeof record.positionSeconds === "number")
		return { kind: "seek", positionSeconds: record.positionSeconds };
	if (
		record.kind === "set-volume" &&
		typeof record.volumePercent === "number" &&
		Number.isFinite(record.volumePercent) &&
		record.volumePercent >= 0 &&
		record.volumePercent <= 100
	) {
		return { kind: "set-volume", volumePercent: record.volumePercent };
	}
	throw new Error("Unsupported media command.");
}

function parseActivityId(value: unknown): number {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Undo request must be an object.");
	const activityId = (value as Record<string, unknown>).activityId;
	if (typeof activityId !== "number" || !Number.isInteger(activityId) || activityId <= 0)
		throw new Error("activityId must be a positive integer.");
	return activityId;
}

function isSameOrigin(request: BridgeHttpRequest): boolean {
	const origin = header(request.headers.origin);
	const host = header(request.headers.host);
	// Host is required to establish which local origin this request targeted.
	// Origin may be absent on same-origin browser requests, but accepting a
	// request with neither header makes the control route unauthenticated.
	if (host === undefined || host.trim() === "") return false;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

function header(value: string | string[] | undefined): string | undefined {
	return typeof value === "string" ? value : value?.[0];
}

function write(response: BridgeHttpResponse, status: number, body: unknown): void {
	response.statusCode = status;
	response.writeHead(status, JSON_HEADERS);
	response.end(JSON.stringify(body));
}
