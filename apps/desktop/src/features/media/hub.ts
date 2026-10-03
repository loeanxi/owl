/**
 * 媒体桥的浏览器数据层：同源 fetch 客户端 + 共享轮询器（statusHub）。
 *
 * 沿用 dsh-media-bridge 客户端的铁律：
 * - 所有表面（Rail 圆点、媒体页、后续的全局歌词条/深背景）都从同一个 hub
 *   拿状态，3s 一轮；失败保留上一次状态，绝不清空 UI。
 * - 状态只来自 /media-bridge/api/status 的权威应答；不从进程名、焦点或
 *   上一次命令结果推断。
 * - hub 惰性启动：第一个订阅者出现才开始轮询，最后一个退订即停。
 * @module features/media/hub
 */

import type { BridgeUiStatus } from "../../../../../packages/owl-media-bridge/src/bridge-runtime.ts";
import type { MediaCommand } from "../../../../../packages/owl-media-bridge/src/domain/types.ts";
import type { FavoriteEntry, ListeningEntry } from "../../../../../packages/owl-media-bridge/src/listening-memory.ts";
import type { ListeningReport } from "../../../../../packages/owl-media-bridge/src/listening-report.ts";
import type { BridgeSettingsPatch } from "../../../../../packages/owl-media-bridge/src/http.ts";
import type {
	BridgeUiDiagnostics,
} from "../../../../../packages/owl-media-bridge/src/bridge-runtime.ts";

export type { BridgeSettingsPatch, BridgeUiDiagnostics, BridgeUiStatus, MediaCommand };
export type { PlayerOption } from "../../../../../packages/owl-media-bridge/src/domain/types.ts";
export type {
	FavoriteEntry,
	ListeningEntry,
	MemorySummary,
} from "../../../../../packages/owl-media-bridge/src/listening-memory.ts";
export type {
	ListeningReport,
	ListeningReportRange,
} from "../../../../../packages/owl-media-bridge/src/listening-report.ts";

/** { ok, value } / { ok, error } 信封（HTTP 层恒 200，业务错误在 error 里）。 */
interface Envelope<T> {
	readonly ok: boolean;
	readonly value?: T;
	readonly error?: string;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const payload = (await response.json()) as Envelope<T>;
	if (!payload.ok) throw new Error(payload.error ?? "media bridge request failed");
	return payload.value as T;
}

/** 媒体桥同源 API；与 owl-media-bridge/src/http.ts 的路由一一对应。 */
export const mediaApi = {
	status: (): Promise<BridgeUiStatus> => post("/media-bridge/api/status"),
	launch: (): Promise<{ launched: boolean }> => post("/media-bridge/api/launch"),
	control: (command: MediaCommand): Promise<BridgeUiStatus> => post("/media-bridge/api/control", command),
	undo: (activityId: number): Promise<BridgeUiStatus> => post("/media-bridge/api/control/undo", { activityId }),
	fade: (volumePercent: number, durationSeconds: number): Promise<BridgeUiStatus> =>
		post("/media-bridge/api/volume/fade", { volumePercent, durationSeconds }),
	report: (range: "today" | "week"): Promise<ListeningReport> =>
		post("/media-bridge/api/listening/report", { range }),
	history: (limit = 50): Promise<{ today: readonly ListeningEntry[]; recent: readonly ListeningEntry[] }> =>
		post("/media-bridge/api/memory/history", { limit }),
	favorites: (): Promise<{ favorites: readonly FavoriteEntry[] }> => post("/media-bridge/api/memory/favorites"),
	toggleFavorite: (track?: {
		title: string;
		artist: string;
		album?: string;
		artworkUrl?: string;
		playerId?: string;
	}): Promise<BridgeUiStatus> => post("/media-bridge/api/memory/favorite/toggle", track ?? {}),
	removeFavorite: (key: string): Promise<{ removed: boolean }> =>
		post("/media-bridge/api/memory/favorite/remove", { key }),
	diagnose: (): Promise<BridgeUiDiagnostics> => post("/media-bridge/api/diagnose"),
	signal: (): Promise<unknown> => post("/media-bridge/api/signal"),
	config: (): Promise<MediaConfigView> => post("/media-bridge/api/config"),
	updateConfig: (patch: BridgeSettingsPatch): Promise<MediaConfigView> =>
		post("/media-bridge/api/config/update", patch),
};

/** GET 语义的配置视图（availablePlayers 目录 + 当前值）。 */
export interface MediaConfigView {
	readonly allowAgentControl: boolean;
	readonly deepBackground: boolean;
	readonly realWaveEnabled: boolean;
	readonly playerId: string;
	readonly softTransitions: boolean;
	readonly skipFadeOut: boolean;
	readonly preferLiveVideo: boolean;
	readonly availablePlayers: ReadonlyArray<{ id: string; displayName: string }>;
}

/** hub 的广播快照：失败时保留上一次 status，只置 error。 */
export interface MediaHubSnapshot {
	readonly status: BridgeUiStatus | undefined;
	/** 本次 status 完成抓取的时刻（Date.now），用于本地外推播放位置。 */
	readonly fetchedAt: number | undefined;
	readonly error: string | undefined;
}

type Listener = (snapshot: MediaHubSnapshot) => void;

const POLL_INTERVAL_MS = 3000;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let snapshot: MediaHubSnapshot = { status: undefined, fetchedAt: undefined, error: undefined };

function broadcast(): void {
	for (const listener of listeners) listener(snapshot);
}

async function pollOnce(): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	try {
		const status = await mediaApi.status();
		snapshot = { status, fetchedAt: Date.now(), error: undefined };
	} catch (error) {
		// 失败保留旧状态：过期的 UI 好过空白的 UI。
		snapshot = {
			status: snapshot.status,
			fetchedAt: snapshot.fetchedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		inFlight = false;
	}
	broadcast();
}

function ensurePolling(): void {
	if (timer !== undefined) return;
	void pollOnce();
	timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
	if (timer === undefined) return;
	clearInterval(timer);
	timer = undefined;
}

/** 命令完成后催一轮即时刷新（hub 未激活时是空操作）。 */
export function refreshMediaStatus(): void {
	if (timer !== undefined) void pollOnce();
}

/** 订阅共享状态流；返回退订函数。 */
export function subscribeMediaStatus(listener: Listener): () => void {
	listeners.add(listener);
	// 新订阅者立刻拿到当前快照，不用等下一轮。
	listener(snapshot);
	ensurePolling();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) stopPolling();
	};
}
