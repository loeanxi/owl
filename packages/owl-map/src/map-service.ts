import type {
	GeocodeRequest,
	MapBounds,
	MapCategory,
	MapCoordinate,
	MapDataSource,
	MapPlaceCategory,
	MapResult,
	MapSourceStatus,
	NearbyRequest,
	RealPlace,
	ReverseRequest,
} from "./types.ts";

export type * from "./types.ts";

const PHOTON_URL = "https://photon.komoot.io/";
const CATEGORY_TAGS: Record<Exclude<MapCategory, "all">, string> = {
	cafe: "amenity:cafe",
	restaurant: "amenity:restaurant",
	park: "leisure:park",
	museum: "tourism:museum",
};
const USER_AGENT = "OwlDesktop/0.1 (interactive OpenStreetMap exploration)";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 40;

export interface RealMapServiceOptions {
	fetch?: typeof fetch;
	photonBaseUrl?: string;
	/** Explicitly configured, policy-compatible server; public Nominatim and FOSSGIS are not defaults. */
	overpassEndpoint?: string;
	minimumIntervalMs?: number;
	timeoutMs?: number;
	cacheTtlMs?: number;
	now?: () => number;
	wait?: (milliseconds: number) => Promise<void>;
}

/** Manual map lookups only: one upstream request at a time, cached and rate-limited. */
export class RealMapService {
	private fetcher: typeof fetch;
	private photonBaseUrl: URL;
	private overpassEndpoint?: URL;
	private minimumIntervalMs: number;
	private timeoutMs: number;
	private cacheTtlMs: number;
	private now: () => number;
	private wait: (milliseconds: number) => Promise<void>;
	private queue: Promise<void> = Promise.resolve();
	private lastRequestAt = Number.NEGATIVE_INFINITY;
	private cooldown = new Map<string, number>();
	private cache = new Map<string, { expires: number; result: MapResult<RealPlace> }>();
	private pending = new Map<string, Promise<MapResult<RealPlace>>>();

	constructor(options: RealMapServiceOptions = {}) {
		this.fetcher = options.fetch ?? globalThis.fetch;
		this.photonBaseUrl = endpointUrl(options.photonBaseUrl ?? process.env.OWL_MAP_PHOTON_URL ?? PHOTON_URL);
		const overpass = options.overpassEndpoint ?? process.env.OWL_MAP_OVERPASS_URL;
		if (overpass) this.overpassEndpoint = endpointUrl(overpass);
		this.minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 1000);
		this.timeoutMs = Math.max(100, options.timeoutMs ?? 20_000);
		this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 10 * 60_000);
		this.now = options.now ?? Date.now;
		this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	}

	geocode(request: GeocodeRequest): Promise<MapResult<RealPlace>> {
		if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 200)
			throw new Error("Search text must contain 1–200 characters.");
		if (request.center) validateCoordinate(request.center);
		const url = new URL("api/", this.photonBaseUrl);
		url.searchParams.set("q", request.query.trim());
		url.searchParams.set("limit", String(resultLimit(request.limit)));
		if (request.center) {
			url.searchParams.set("lat", String(request.center.lat));
			url.searchParams.set("lon", String(request.center.lng));
		}
		if (request.language === "en") url.searchParams.set("lang", "en");
		return this.cached(url.href, () => this.photon(url, request.center));
	}

	reverse(request: ReverseRequest): Promise<MapResult<RealPlace>> {
		validateCoordinate(request.point);
		const url = new URL("reverse", this.photonBaseUrl);
		url.searchParams.set("lat", String(request.point.lat));
		url.searchParams.set("lon", String(request.point.lng));
		url.searchParams.set("limit", "1");
		if (request.language === "en") url.searchParams.set("lang", "en");
		return this.cached(url.href, () => this.photon(url, request.point));
	}

	nearby(request: NearbyRequest): Promise<MapResult<RealPlace>> {
		validateCoordinate(request.center);
		if (request.category !== "all" && !Object.hasOwn(CATEGORY_TAGS, request.category))
			throw new Error("Unsupported place category.");
		const radius = request.radiusMeters ?? 2000;
		if (!Number.isFinite(radius) || radius < 100 || radius > 5000)
			throw new Error("Search radius must be between 100 and 5000 metres.");
		const limit = resultLimit(request.limit);
		const key = `nearby:${request.center.lat}:${request.center.lng}:${request.category}:${radius}:${limit}`;
		return this.cached(key, async () => {
			const sources: MapSourceStatus[] = [];
			let data: RealPlace[] | undefined;
			if (this.overpassEndpoint) {
				try {
					const raw = await this.json(this.overpassEndpoint, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ data: overpassQuery(request.center, request.category, radius) }),
					});
					data = parseOverpass(raw, this.now(), request.center);
					sources.push({ provider: "overpass", status: "ok", endpoint: this.overpassEndpoint.href });
				} catch (error) {
					sources.push({
						provider: "overpass",
						status: "error",
						endpoint: this.overpassEndpoint.href,
						error: errorMessage(error),
					});
				}
			}
			if (data === undefined) {
				const url = new URL("reverse", this.photonBaseUrl);
				url.searchParams.set("lat", String(request.center.lat));
				url.searchParams.set("lon", String(request.center.lng));
				url.searchParams.set("radius", String(radius / 1000));
				url.searchParams.set("limit", String(limit));
				const tags = request.category === "all" ? Object.values(CATEGORY_TAGS) : [CATEGORY_TAGS[request.category]];
				for (const tag of tags) url.searchParams.append("osm_tag", tag);
				const result = await this.photon(url, request.center);
				data = result.data;
				sources.push(...result.sources);
			}
			const allowedCategories = request.category === "all" ? Object.keys(CATEGORY_TAGS) : [request.category];
			return {
				data: data
					.filter(
						(place) =>
							allowedCategories.includes(place.category) &&
							place.distanceMeters !== null &&
							place.distanceMeters <= radius,
					)
					.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0))
					.slice(0, limit),
				sources,
			};
		});
	}

	private async photon(url: URL, center?: MapCoordinate): Promise<MapResult<RealPlace>> {
		try {
			const raw = await this.json(url);
			return {
				data: parsePhoton(raw, this.now(), center),
				sources: [{ provider: "photon", status: "ok", endpoint: url.origin }],
			};
		} catch (error) {
			return {
				data: [],
				sources: [{ provider: "photon", status: "error", endpoint: url.origin, error: errorMessage(error) }],
			};
		}
	}

	private async cached(key: string, load: () => Promise<MapResult<RealPlace>>): Promise<MapResult<RealPlace>> {
		const found = this.cache.get(key);
		if (found && found.expires > this.now()) return structuredClone(found.result);
		const active = this.pending.get(key);
		if (active) return structuredClone(await active);
		const pending = load();
		this.pending.set(key, pending);
		try {
			const result = await pending;
			const ttl = result.sources.some((source) => source.status === "error")
				? Math.min(this.cacheTtlMs, 5000)
				: this.cacheTtlMs;
			if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value ?? "");
			this.cache.set(key, { expires: this.now() + ttl, result });
			return structuredClone(result);
		} finally {
			this.pending.delete(key);
		}
	}

	private json(url: URL, init: RequestInit = {}): Promise<unknown> {
		const run = this.queue.then(async () => {
			if ((this.cooldown.get(url.origin) ?? 0) > this.now())
				throw new Error("The map source is busy. Retry after 30 seconds.");
			const delay = this.minimumIntervalMs - (this.now() - this.lastRequestAt);
			if (delay > 0) await this.wait(delay);
			this.lastRequestAt = this.now();
			const response = await this.fetcher(url, {
				...init,
				redirect: "error",
				signal: AbortSignal.timeout(this.timeoutMs),
				headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...init.headers },
			});
			if (!response.ok) {
				if (response.status === 429 || response.status === 406) this.cooldown.set(url.origin, this.now() + 30_000);
				await response.body?.cancel();
				throw new Error(`Map source returned HTTP ${response.status}.`);
			}
			if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
				await response.body?.cancel();
				throw new Error("Map source response is too large.");
			}
			const text = await response.text();
			if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Map source response is too large.");
			return JSON.parse(text) as unknown;
		});
		this.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}

function endpointUrl(value: string): URL {
	const url = new URL(value);
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:")))
		throw new Error("Map source must use HTTPS, or HTTP on a local self-hosted server, without URL credentials.");
	if (url.hostname === "nominatim.openstreetmap.org") throw new Error("Public Nominatim is not supported by Owl Map.");
	return url;
}

function validateCoordinate(point: MapCoordinate): void {
	if (
		!point ||
		!Number.isFinite(point.lat) ||
		!Number.isFinite(point.lng) ||
		Math.abs(point.lat) > 90 ||
		Math.abs(point.lng) > 180
	)
		throw new Error("Invalid latitude or longitude.");
}

function resultLimit(limit = 20): number {
	if (!Number.isFinite(limit) || limit < 1) throw new Error("Result limit must be a positive number.");
	return Math.min(MAX_RESULTS, Math.floor(limit));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringTags(value: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.entries(record(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

function categoryOf(tags: Record<string, string>): MapPlaceCategory {
	if (tags.amenity === "cafe") return "cafe";
	if (tags.amenity === "restaurant") return "restaurant";
	if (tags.leisure === "park") return "park";
	if (tags.tourism === "museum") return "museum";
	return "other";
}

function osmIdentity(type: unknown, id: unknown): { id: string; url: string } | undefined {
	const normalized =
		type === "N" || type === "node"
			? "node"
			: type === "W" || type === "way"
				? "way"
				: type === "R" || type === "relation"
					? "relation"
					: undefined;
	if (
		!normalized ||
		!(
			(typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
			(typeof id === "string" && /^[1-9]\d*$/.test(id))
		)
	)
		return undefined;
	return { id: `osm:${normalized}:${id}`, url: `https://www.openstreetmap.org/${normalized}/${id}` };
}

function basePlace(
	point: MapCoordinate,
	identity: { id: string; url: string },
	name: string,
	address: string | null,
	tags: Record<string, string>,
	provider: MapDataSource["provider"],
	fetchedAt: number,
	center?: MapCoordinate,
): RealPlace {
	return {
		...point,
		id: identity.id,
		name,
		address,
		category: categoryOf(tags),
		distanceMeters: center ? Math.round(distanceMeters(center, point)) : null,
		openingHours: text(tags.opening_hours),
		phone: text(tags["contact:phone"] ?? tags.phone),
		website: websiteUrl(tags["contact:website"] ?? tags.website),
		wheelchair: text(tags.wheelchair),
		internetAccess: text(tags.internet_access),
		rating: null,
		price: null,
		quiet: null,
		plug: null,
		tags,
		source: { provider, url: identity.url, fetchedAt: new Date(fetchedAt).toISOString() },
	};
}

function websiteUrl(value: unknown): string | null {
	const candidate = text(value);
	if (!candidate) return null;
	try {
		const url = new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

export function distanceMeters(a: MapCoordinate, b: MapCoordinate): number {
	const lat = ((b.lat - a.lat) * Math.PI) / 180;
	const lng = ((b.lng - a.lng) * Math.PI) / 180;
	const chord =
		Math.sin(lat / 2) ** 2 +
		Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(lng / 2) ** 2;
	return 6_371_000 * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(Math.max(0, 1 - chord)));
}

export function parsePhoton(value: unknown, fetchedAt: number, center?: MapCoordinate): RealPlace[] {
	const envelope = record(value);
	if (!Array.isArray(envelope?.features)) throw new Error("Map source returned an invalid GeoJSON response.");
	const places = new Map<string, RealPlace>();
	for (const item of envelope.features) {
		const feature = record(item);
		const properties = record(feature?.properties);
		const geometry = record(feature?.geometry);
		const coordinates = geometry?.coordinates;
		if (!properties || geometry?.type !== "Point" || !Array.isArray(coordinates)) continue;
		const lat: unknown = coordinates[1];
		const lng: unknown = coordinates[0];
		if (
			typeof lat !== "number" ||
			typeof lng !== "number" ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lng) ||
			Math.abs(lat) > 90 ||
			Math.abs(lng) > 180
		)
			continue;
		const point = { lat, lng };
		const identity = osmIdentity(properties.osm_type, properties.osm_id);
		const name = text(properties.name);
		if (!identity || !name) continue;
		const tags = stringTags(properties.extra);
		if (typeof properties.osm_key === "string" && typeof properties.osm_value === "string")
			tags[properties.osm_key] = properties.osm_value;
		const address =
			[
				...new Set(
					[
						properties.country,
						properties.state,
						properties.city,
						properties.district,
						properties.street,
						properties.housenumber,
					]
						.map(text)
						.filter((part): part is string => part !== null),
				),
			].join(" · ") || null;
		const place = basePlace(point, identity, name, address, tags, "photon", fetchedAt, center);
		const extent = properties.extent;
		if (
			Array.isArray(extent) &&
			extent.length === 4 &&
			extent.every((bound) => typeof bound === "number" && Number.isFinite(bound))
		) {
			const bbox: MapBounds = { west: extent[0], north: extent[1], east: extent[2], south: extent[3] };
			if (
				bbox.west <= bbox.east &&
				bbox.south <= bbox.north &&
				Math.abs(bbox.west) <= 180 &&
				Math.abs(bbox.east) <= 180 &&
				Math.abs(bbox.south) <= 90 &&
				Math.abs(bbox.north) <= 90
			)
				place.bbox = bbox;
		}
		places.set(place.id, place);
	}
	return [...places.values()];
}

export function parseOverpass(value: unknown, fetchedAt: number, center?: MapCoordinate): RealPlace[] {
	const envelope = record(value);
	if (!Array.isArray(envelope?.elements) || text(envelope.remark))
		throw new Error(text(envelope?.remark) ?? "Map source returned an invalid OSM response.");
	const places = new Map<string, RealPlace>();
	for (const item of envelope.elements) {
		const element = record(item);
		if (!element) continue;
		const location = record(element.center) ?? element;
		const lat = location.lat;
		const lng = location.lon;
		if (
			typeof lat !== "number" ||
			typeof lng !== "number" ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lng) ||
			Math.abs(lat) > 90 ||
			Math.abs(lng) > 180
		)
			continue;
		const point = { lat, lng };
		const tags = stringTags(element.tags);
		const name = text(tags.name ?? tags["name:zh"] ?? tags["name:en"]);
		const identity = osmIdentity(element.type, element.id);
		if (!name || !identity) continue;
		const address =
			text(tags["addr:full"]) ??
			([tags["addr:city"], tags["addr:district"], tags["addr:street"], tags["addr:housenumber"]]
				.map(text)
				.filter(Boolean)
				.join(" · ") ||
				null);
		places.set(identity.id, basePlace(point, identity, name, address, tags, "overpass", fetchedAt, center));
	}
	return [...places.values()];
}

function overpassQuery(center: MapCoordinate, category: MapCategory, radius: number): string {
	const tags = category === "all" ? Object.values(CATEGORY_TAGS) : [CATEGORY_TAGS[category]];
	const selectors = tags
		.map((tag) => {
			const [key, value] = tag.split(":");
			return `nwr[${key}=${value}](around:${radius},${center.lat},${center.lng});`;
		})
		.join("");
	return `[out:json][timeout:15];(${selectors});out center tags 200;`;
}
