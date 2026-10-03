import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapCategory } from "../src/core/maps/types.ts";
import { distanceMeters, parseOverpass, parsePhoton, RealMapService } from "../src/modes/desktop/map-service.ts";

const center = { lat: 30.25, lng: 120.2 };
const feature = (id: number, name = "Source cafe", lat = 30.25, lng = 120.2, key = "amenity", value = "cafe") => ({
	type: "Feature",
	geometry: { type: "Point", coordinates: [lng, lat] },
	properties: { osm_type: "N", osm_id: id, name, osm_key: key, osm_value: value },
});

function fakeFetch(payload: unknown, status = 200) {
	const calls: { url: URL; init?: RequestInit }[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), init });
		return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
	};
	return { calls, fetch: fetcher };
}

beforeEach(() => {
	vi.stubEnv("OWL_MAP_PHOTON_URL", undefined);
	vi.stubEnv("OWL_MAP_OVERPASS_URL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("real map sources", () => {
	it("parses named Photon coordinates and actual metadata without inventing prices, ratings or facilities", () => {
		const valid = feature(7);
		const raw = {
			...valid,
			properties: {
				...valid.properties,
				city: "杭州市",
				street: "真实街道",
				housenumber: "8",
				extent: [120.19, 30.26, 120.21, 30.24],
				extra: {
					opening_hours: "Mo-Fr 09:00-18:00",
					internet_access: "wlan",
					website: "javascript:alert(1)",
					socket: "yes",
					stars: "5",
				},
			},
		};
		const places = parsePhoton(
			{ features: [raw, raw, feature(8, ""), feature(9, "Invalid", 91), { geometry: { type: "Point" } }] },
			1000,
			center,
		);
		expect(places).toHaveLength(1);
		expect(places[0]).toMatchObject({
			id: "osm:node:7",
			name: "Source cafe",
			lat: 30.25,
			lng: 120.2,
			category: "cafe",
			distanceMeters: 0,
			address: "杭州市 · 真实街道 · 8",
			openingHours: "Mo-Fr 09:00-18:00",
			internetAccess: "wlan",
			website: null,
			rating: null,
			price: null,
			quiet: null,
			plug: null,
			bbox: { south: 30.24, west: 120.19, north: 30.26, east: 120.21 },
			source: { provider: "photon", url: "https://www.openstreetmap.org/node/7" },
		});
		expect(places[0].source.fetchedAt).toBe("1970-01-01T00:00:01.000Z");
	});

	it("uses Overpass way centers and preserves missing address and business details as unknown", () => {
		const places = parseOverpass(
			{
				elements: [
					{
						type: "way",
						id: 10,
						center: { lat: 30.251, lon: 120.2 },
						tags: {
							name: "Source park",
							leisure: "park",
							website: "https://example.org/park",
							wheelchair: "yes",
						},
					},
					{
						type: "node",
						id: 11,
						lat: 30.25,
						lon: 120.2,
						tags: { name: "Source restaurant", amenity: "restaurant", "contact:phone": "+1 123" },
					},
					{ type: "way", id: 12, tags: { name: "No coordinates", leisure: "park" } },
				],
			},
			1000,
			center,
		);
		expect(places).toHaveLength(2);
		expect(places[0]).toMatchObject({
			id: "osm:way:10",
			category: "park",
			address: null,
			wheelchair: "yes",
			rating: null,
			price: null,
			plug: null,
		});
		expect(places[1]).toMatchObject({ category: "restaurant", phone: "+1 123" });
		expect(() => parseOverpass({ elements: [], remark: "runtime error" }, 1000)).toThrow("runtime error");
	});

	it("searches Chinese text through the approved Photon service and never public Nominatim", async () => {
		const fake = fakeFetch({ features: [feature(1, "杭州市", 30.25, 120.2, "place", "city")] });
		const service = new RealMapService({ fetch: fake.fetch, minimumIntervalMs: 0 });
		const result = await service.geocode({ query: "杭州 西湖", center, language: "zh", limit: 999 });
		expect(fake.calls[0].url.origin).toBe("https://photon.komoot.io");
		expect(fake.calls[0].url.searchParams.get("q")).toBe("杭州 西湖");
		expect(fake.calls[0].url.searchParams.get("limit")).toBe("40");
		expect(fake.calls[0].url.searchParams.has("lang")).toBe(false);
		expect(result.sources[0].status).toBe("ok");
		expect(result.data[0].category).toBe("other");
		expect(new Headers(fake.calls[0].init?.headers).get("User-Agent")).toContain("OwlDesktop/");
		expect(() => new RealMapService({ photonBaseUrl: "https://nominatim.openstreetmap.org/" })).toThrow("Nominatim");
	});

	it("uses one bounded Photon reverse request for all categories and applies the actual distance radius", async () => {
		const fake = fakeFetch({
			features: [
				feature(1, "Inside cafe"),
				feature(2, "Inside restaurant", 30.251, 120.2, "amenity", "restaurant"),
				feature(3, "Far cafe", 30.3, 120.2),
				feature(4, "Unrelated shop", 30.25, 120.2, "shop", "bakery"),
			],
		});
		const service = new RealMapService({ fetch: fake.fetch, minimumIntervalMs: 0 });
		const result = await service.nearby({ center, category: "all", radiusMeters: 1000 });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].url.pathname).toBe("/reverse");
		expect(fake.calls[0].url.searchParams.get("radius")).toBe("1");
		expect(fake.calls[0].url.searchParams.getAll("osm_tag")).toEqual([
			"amenity:cafe",
			"amenity:restaurant",
			"leisure:park",
			"tourism:museum",
		]);
		expect(fake.calls[0].url.searchParams.has("q")).toBe(false);
		expect(result.data.map((place) => place.name)).toEqual(["Inside cafe", "Inside restaurant"]);
		expect(result.data[1].distanceMeters).toBeGreaterThan(100);
		expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111194.927, 1);
	});

	it("coalesces identical requests, caches successful results and prevents callers mutating the cache", async () => {
		const fake = fakeFetch({ features: [feature(1)] });
		const service = new RealMapService({ fetch: fake.fetch, minimumIntervalMs: 0 });
		const [first, second] = await Promise.all([
			service.geocode({ query: "same" }),
			service.geocode({ query: "same" }),
		]);
		first.data[0].name = "Caller mutation";
		expect(second.data[0].name).toBe("Source cafe");
		expect((await service.geocode({ query: "same" })).data[0].name).toBe("Source cafe");
		expect(fake.calls).toHaveLength(1);
	});

	it("serializes and spaces uncached requests instead of flooding a public source", async () => {
		let now = 0;
		const times: number[] = [];
		const fetcher: typeof fetch = async () => {
			times.push(now);
			return Response.json({ features: [] });
		};
		const service = new RealMapService({
			fetch: fetcher,
			now: () => now,
			wait: async (milliseconds) => {
				now += milliseconds;
			},
		});
		await Promise.all([
			service.geocode({ query: "杭州" }),
			service.geocode({ query: "宁波" }),
			service.reverse({ point: center }),
		]);
		expect(times).toEqual([0, 1000, 2000]);
	});

	it("uses only an explicitly configured Overpass source and falls back to real Photon data on failure", async () => {
		const calls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			calls.push(url.origin);
			return url.hostname === "overpass.example.org"
				? new Response("upstream unavailable", { status: 503 })
				: Response.json({ features: [feature(1)] });
		};
		const service = new RealMapService({
			fetch: fetcher,
			minimumIntervalMs: 0,
			overpassEndpoint: "https://overpass.example.org/api/interpreter",
		});
		const result = await service.nearby({ center, category: "cafe" });
		expect(calls).toEqual(["https://overpass.example.org", "https://photon.komoot.io"]);
		expect(result.data[0].name).toBe("Source cafe");
		expect(result.sources.map((source) => source.status)).toEqual(["error", "ok"]);
		expect(result.sources[0].error).toContain("503");
	});

	it("reports malformed or unavailable source responses without demo places and respects throttling cooldown", async () => {
		const fake = fakeFetch({ message: "busy" }, 429);
		const service = new RealMapService({ fetch: fake.fetch, minimumIntervalMs: 0 });
		const first = await service.geocode({ query: "杭州" });
		const second = await service.geocode({ query: "宁波" });
		expect(first.data).toEqual([]);
		expect(first.sources[0]).toMatchObject({ status: "error" });
		expect(second.data).toEqual([]);
		expect(second.sources[0].error).toContain("30 seconds");
		expect(fake.calls).toHaveLength(1);
		const malformed = new RealMapService({ fetch: fakeFetch({ unrelated: [] }).fetch, minimumIntervalMs: 0 });
		expect((await malformed.geocode({ query: "杭州" })).sources[0].status).toBe("error");
	});

	it("rejects invalid coordinates, radii, empty queries and category injection before requesting upstream", () => {
		const fake = fakeFetch({ features: [] });
		const service = new RealMapService({ fetch: fake.fetch, minimumIntervalMs: 0 });
		expect(() => service.geocode({ query: " " })).toThrow();
		expect(() => service.reverse({ point: { lat: Number.NaN, lng: 120 } })).toThrow();
		expect(() => service.nearby({ center, category: "cafe", radiusMeters: 5001 })).toThrow();
		expect(() => service.nearby({ center, category: "__proto__" as MapCategory })).toThrow();
		expect(fake.calls).toHaveLength(0);
	});
});
