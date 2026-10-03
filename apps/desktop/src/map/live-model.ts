import type { MapCategory, MapCoordinate, MapResult, MapSourceStatus, RealPlace } from "../bridge/protocol.ts";

export const LIVE_MAP_STORAGE_KEY = "owl.map.live.v1";
export const DEFAULT_MAP_CENTER: MapCoordinate = { lat: 30.2741, lng: 120.1551 };
export const MAX_LIVE_COMPARISON = 3;
const MAX_FAVORITES = 200;
const MAX_HISTORY = 20;

export interface LiveSearchRecord {
	id: string;
	query: string;
	center: MapCoordinate;
	locationName: string;
	category: MapCategory;
	radiusMeters: number;
	kind: "search" | "nearby";
	createdAt: string;
}

export interface LiveSavedState {
	favorites: RealPlace[];
	history: LiveSearchRecord[];
	lastCenter?: MapCoordinate;
	lastLocationName?: string;
}

export function isCoordinate(value: unknown): value is MapCoordinate {
	if (!value || typeof value !== "object") return false;
	const point = value as Record<string, unknown>;
	return typeof point.lat === "number" && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && typeof point.lng === "number" && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

/** Coordinate input is explicitly latitude, longitude; no silent axis swap. */
export function parseCoordinates(input: string): MapCoordinate | undefined {
	const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*[,，;\s]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(input);
	if (!match) return undefined;
	const point = { lat: Number(match[1]), lng: Number(match[2]) };
	return isCoordinate(point) ? point : undefined;
}

export function safeExternalUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; }
}

function optionalText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.slice(0, 4000) : null; }

/** Stored records are data, never source code or assumed-valid provider objects. */
export function normalizeRealPlace(value: unknown): RealPlace | undefined {
	if (!isCoordinate(value)) return undefined;
	const record = value as unknown as Record<string, unknown>;
	if (typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !record.source || typeof record.source !== "object") return undefined;
	const source = record.source as Record<string, unknown>;
	if (source.provider !== "photon" && source.provider !== "overpass" && source.provider !== "user") return undefined;
	const sourceUrl = typeof source.url === "string" ? safeExternalUrl(source.url) : undefined;
	if (source.provider !== "user" && !sourceUrl) return undefined;
	const category = record.category;
	if (category !== "cafe" && category !== "restaurant" && category !== "park" && category !== "museum" && category !== "other") return undefined;
	const tags = record.tags && typeof record.tags === "object" && !Array.isArray(record.tags) ? Object.fromEntries(Object.entries(record.tags).filter((entry): entry is [string, string] => typeof entry[1] === "string").slice(0, 100)) : {};
	return {
		id: record.id.slice(0, 300), name: record.name.slice(0, 500), lat: value.lat, lng: value.lng,
		address: optionalText(record.address), category,
		distanceMeters: typeof record.distanceMeters === "number" && Number.isFinite(record.distanceMeters) && record.distanceMeters >= 0 ? record.distanceMeters : null,
		openingHours: optionalText(record.openingHours), phone: optionalText(record.phone), website: optionalText(record.website), wheelchair: optionalText(record.wheelchair), internetAccess: optionalText(record.internetAccess),
		// A public map listing does not establish a rating, price, quietness or power sockets.
		rating: null, price: null, quiet: null, plug: null, tags,
		source: { provider: source.provider, url: sourceUrl ?? "", fetchedAt: typeof source.fetchedAt === "string" ? source.fetchedAt : "" },
	};
}

export function parseLiveSavedState(raw: string | null): LiveSavedState {
	const empty: LiveSavedState = { favorites: [], history: [] };
	if (!raw) return empty;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
		const record = value as Record<string, unknown>;
		if (record.version !== 1) return empty;
		const favorites = Array.isArray(record.favorites) ? record.favorites.map(normalizeRealPlace).filter((place): place is RealPlace => Boolean(place)) : [];
		const history: LiveSearchRecord[] = [];
		if (Array.isArray(record.history)) for (const entry of record.history) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			if (typeof item.id !== "string" || typeof item.query !== "string" || !isCoordinate(item.center) || typeof item.locationName !== "string" || typeof item.createdAt !== "string" || (item.kind !== "search" && item.kind !== "nearby") || !isMapCategory(item.category) || typeof item.radiusMeters !== "number" || item.radiusMeters < 100 || item.radiusMeters > 10000) continue;
			history.push({ id: item.id, query: item.query.slice(0, 1000), center: { ...item.center }, locationName: item.locationName, category: item.category, radiusMeters: item.radiusMeters, createdAt: item.createdAt, kind: item.kind });
		}
		return { favorites: [...new Map(favorites.map((place) => [place.id, place])).values()].slice(0, MAX_FAVORITES), history: history.slice(0, MAX_HISTORY), ...(isCoordinate(record.lastCenter) ? { lastCenter: { ...record.lastCenter } } : {}), ...(typeof record.lastLocationName === "string" ? { lastLocationName: record.lastLocationName } : {}) };
	} catch { return empty; }
}

export function readLiveSavedState(storage: Pick<Storage, "getItem">): LiveSavedState {
	try { return parseLiveSavedState(storage.getItem(LIVE_MAP_STORAGE_KEY)); } catch { return { favorites: [], history: [] }; }
}

export function writeLiveSavedState(storage: Pick<Storage, "setItem">, state: LiveSavedState): boolean {
	try { storage.setItem(LIVE_MAP_STORAGE_KEY, JSON.stringify({ version: 1, ...state, favorites: state.favorites.slice(0, MAX_FAVORITES), history: state.history.slice(0, MAX_HISTORY) })); return true; } catch { return false; }
}

export function toggleLiveFavorite(favorites: readonly RealPlace[], place: RealPlace): RealPlace[] {
	return favorites.some((entry) => entry.id === place.id) ? favorites.filter((entry) => entry.id !== place.id) : [...favorites, place].slice(-MAX_FAVORITES);
}

export function toggleLiveCompare(places: readonly RealPlace[], place: RealPlace): { places: RealPlace[]; full: boolean } {
	if (places.some((entry) => entry.id === place.id)) return { places: places.filter((entry) => entry.id !== place.id), full: false };
	if (places.length >= MAX_LIVE_COMPARISON) return { places: [...places], full: true };
	return { places: [...places, place], full: false };
}

export function addLiveHistory(history: readonly LiveSearchRecord[], entry: LiveSearchRecord): LiveSearchRecord[] {
	return [entry, ...history.filter((item) => !(item.kind === entry.kind && item.query === entry.query && item.category === entry.category && item.radiusMeters === entry.radiusMeters && Math.abs(item.center.lat - entry.center.lat) < 0.00001 && Math.abs(item.center.lng - entry.center.lng) < 0.00001))].slice(0, MAX_HISTORY);
}

export function isMapCategory(value: unknown): value is MapCategory { return value === "all" || value === "cafe" || value === "restaurant" || value === "park" || value === "museum"; }

/** Matches an explicit nearby request; normal conversation never clears or fabricates map results. */
export function nearbyCategoryFromMessage(text: string): MapCategory | undefined {
	if (!/附近|周边|这一带|这里|nearby|near me|around here|in this area/i.test(text)) return undefined;
	if (/咖啡|\bcaf[eé]s?\b|coffee/i.test(text)) return "cafe";
	if (/餐厅|饭店|吃饭|美食|\brestaurants?\b|food|dining/i.test(text)) return "restaurant";
	if (/博物|艺术馆|看展|\bmuseums?\b/i.test(text)) return "museum";
	if (/公园|散步|\bparks?\b/i.test(text)) return "park";
	if (/地点|地方|places/i.test(text)) return "all";
	return undefined;
}

export function straightLineDistance(a: MapCoordinate, b: MapCoordinate): number {
	const toRadians = Math.PI / 180;
	const deltaLat = (b.lat - a.lat) * toRadians;
	const deltaLng = (b.lng - a.lng) * toRadians;
	const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(a.lat * toRadians) * Math.cos(b.lat * toRadians) * Math.sin(deltaLng / 2) ** 2;
	return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
}

export class RealMapClient {
	private fetcher: typeof fetch;
	constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }
	search(query: string, language: "zh" | "en", signal?: AbortSignal): Promise<MapResult<RealPlace>> { return this.request("search", { q: query, language, limit: "12" }, signal); }
	nearby(center: MapCoordinate, category: MapCategory, radiusMeters: number, signal?: AbortSignal): Promise<MapResult<RealPlace>> { return this.request("nearby", { lat: String(center.lat), lng: String(center.lng), category, radius: String(radiusMeters), limit: "60" }, signal); }
	reverse(point: MapCoordinate, language: "zh" | "en", signal?: AbortSignal): Promise<MapResult<RealPlace>> { return this.request("reverse", { lat: String(point.lat), lng: String(point.lng), language }, signal); }
	private async request(path: string, parameters: Record<string, string>, signal?: AbortSignal): Promise<MapResult<RealPlace>> {
		const controller = new AbortController();
		let timedOut = false;
		const abort = () => controller.abort();
		if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
		try {
			const response = await this.fetcher(`/api/maps/${path}?${new URLSearchParams(parameters)}`, { signal: controller.signal, headers: { Accept: "application/json" } });
			const payload: unknown = await response.json();
			if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Map request failed (${response.status}).`);
			if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data) || !("sources" in payload) || !Array.isArray(payload.sources)) throw new Error("The map service returned an invalid response.");
			const data = payload.data.map(normalizeRealPlace).filter((place): place is RealPlace => Boolean(place));
			const sources: MapSourceStatus[] = payload.sources.filter((value): value is MapSourceStatus => Boolean(value && typeof value === "object" && (value.provider === "photon" || value.provider === "overpass") && (value.status === "ok" || value.status === "error") && typeof value.endpoint === "string"));
			return { data, sources };
		} catch (error) { if (timedOut) throw new Error("Map request timed out. Please try again."); throw error; }
		finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
	}
}
