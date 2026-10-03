import assert from "node:assert/strict";
import { test } from "node:test";
import type { RealPlace } from "../bridge/protocol.ts";
import {
	addLiveHistory,
	type ConfiguredMapLocation,
	DEFAULT_CONFIGURED_LOCATION,
	LIVE_MAP_STORAGE_KEY,
	type LiveSearchRecord,
	mapDirectionsUrl,
	nearbyCategoryFromMessage,
	normalizeConfiguredLocation,
	normalizeRealPlace,
	parseCoordinates,
	parseLiveSavedState,
	RealMapClient,
	readLiveSavedState,
	safeExternalUrl,
	straightLineDistance,
	toggleLiveCompare,
	toggleLiveFavorite,
	writeLiveSavedState,
} from "./live-model.ts";

const place: RealPlace = {
	id: "osm:node:123",
	name: "Test Source Place",
	lat: 48.8566,
	lng: 2.3522,
	address: "Paris",
	category: "cafe",
	distanceMeters: 100,
	openingHours: "Mo-Fr 09:00-17:00",
	phone: null,
	website: "https://example.org",
	wheelchair: null,
	internetAccess: null,
	rating: null,
	price: null,
	quiet: null,
	plug: null,
	tags: { amenity: "cafe" },
	source: { provider: "photon", url: "https://www.openstreetmap.org/node/123", fetchedAt: "2026-10-03T12:00:00Z" },
};

const seededEmpty = { favorites: [], history: [], configuredLocation: DEFAULT_CONFIGURED_LOCATION };

test("coordinate input accepts latitude, longitude and rejects invalid ranges or silent swapping", () => {
	assert.deepEqual(parseCoordinates("48.8566, 2.3522"), { lat: 48.8566, lng: 2.3522 });
	assert.deepEqual(parseCoordinates("-33.86，151.2"), { lat: -33.86, lng: 151.2 });
	assert.deepEqual(parseCoordinates("0,0"), { lat: 0, lng: 0 });
	assert.equal(parseCoordinates("120.15, 30.25"), undefined);
	assert.equal(parseCoordinates("30, 181"), undefined);
	assert.equal(parseCoordinates("Paris"), undefined);
});

test("directions preserve the real search center and destination coordinate axes", () => {
	const url = new URL(mapDirectionsUrl({ lat: 29.87, lng: 121.55 }, { lat: 29.88, lng: 121.56 }));
	assert.equal(url.origin, "https://www.openstreetmap.org");
	assert.equal(url.pathname, "/directions");
	assert.equal(url.searchParams.get("route"), "29.87,121.55;29.88,121.56");
	assert.throws(() => mapDirectionsUrl({ lat: 95, lng: 20 }, place), /Invalid/);
});

test("live storage never reads or accepts old demo favorites and keeps complete source records", () => {
	const storage = new Map<string, string>([
		["owl.map.demo.v1", JSON.stringify({ version: 1, favorites: ["liubai"], history: ["cafe"] })],
	]);
	assert.deepEqual(readLiveSavedState({ getItem: (key) => storage.get(key) ?? null }), seededEmpty);
	assert.equal(
		writeLiveSavedState(
			{
				setItem: (key, value) => {
					storage.set(key, value);
				},
			},
			{ favorites: [place], history: [], lastCenter: { lat: 48.8566, lng: 2.3522 }, lastLocationName: "Paris" },
		),
		true,
	);
	const restored = parseLiveSavedState(storage.get(LIVE_MAP_STORAGE_KEY) ?? null);
	assert.deepEqual(restored.favorites[0], place);
	assert.equal(restored.lastLocationName, "Paris");
	assert.deepEqual(parseLiveSavedState("{broken"), seededEmpty);
	assert.deepEqual(
		parseLiveSavedState(
			JSON.stringify({ version: 1, favorites: ["liubai", { ...place, lat: 300 }], history: ["old query"] }),
		),
		seededEmpty,
	);
});

test("storage validates external links and cannot turn unknown facilities into fabricated facts", () => {
	assert.equal(safeExternalUrl("javascript:alert(1)"), undefined);
	assert.equal(safeExternalUrl("data:text/html,<script></script>"), undefined);
	assert.equal(safeExternalUrl("https://www.openstreetmap.org/node/123"), "https://www.openstreetmap.org/node/123");
	const normalized = normalizeRealPlace({ ...place, rating: 4.9, price: 50, quiet: true, plug: true });
	assert.equal(normalized?.rating, null);
	assert.equal(normalized?.price, null);
	assert.equal(normalized?.quiet, null);
	assert.equal(normalized?.plug, null);
	assert.equal(normalizeRealPlace({ ...place, source: { ...place.source, url: "javascript:alert(1)" } }), undefined);
});

test("favorites toggle complete records and comparisons enforce a unique three-place limit", () => {
	assert.deepEqual(toggleLiveFavorite([], place), [place]);
	assert.deepEqual(toggleLiveFavorite([place], place), []);
	const second = { ...place, id: "osm:node:124" },
		third = { ...place, id: "osm:node:125" },
		fourth = { ...place, id: "osm:node:126" };
	assert.deepEqual(toggleLiveCompare([place, second, third], fourth), { places: [place, second, third], full: true });
	assert.deepEqual(toggleLiveCompare([place, second], place), { places: [second], full: false });
});

test("search history retains the selected city, coordinates, radius and category", () => {
	const history: LiveSearchRecord = {
		id: "a",
		query: "Paris",
		center: { lat: 48.8566, lng: 2.3522 },
		locationName: "Paris",
		category: "museum",
		radiusMeters: 2000,
		kind: "nearby",
		createdAt: "2026-10-03T12:00:00Z",
	};
	const replacement = { ...history, id: "b" };
	assert.deepEqual(addLiveHistory([history], replacement), [replacement]);
	assert.equal(addLiveHistory([history], { ...replacement, center: { lat: 25.0478, lng: 121.517 } }).length, 2);
	const restored = parseLiveSavedState(JSON.stringify({ version: 1, favorites: [], history: [history] }));
	assert.deepEqual(restored.history, [history]);
});

test("only explicit nearby intents request a category; ordinary conversation leaves the map alone", () => {
	assert.equal(nearbyCategoryFromMessage("你好"), undefined);
	assert.equal(nearbyCategoryFromMessage("解释一下你用的模型"), undefined);
	assert.equal(nearbyCategoryFromMessage("附近有什么餐厅"), "restaurant");
	assert.equal(nearbyCategoryFromMessage("Show museums around here"), "museum");
	assert.equal(nearbyCategoryFromMessage("附近咖啡馆"), "cafe");
	assert.equal(nearbyCategoryFromMessage("公园历史是什么"), undefined);
});

test("the distance is coordinate-based and explicitly a straight line, not travel time", () => {
	assert.equal(straightLineDistance(place, place), 0);
	assert.ok(Math.abs(straightLineDistance({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111195) < 1);
});

test("map requests send arbitrary cities and use the same-origin real service without truncation", async () => {
	const urls: string[] = [];
	const fakeFetch: typeof fetch = async (input) => {
		urls.push(String(input));
		return new Response(
			JSON.stringify({
				data: [place],
				sources: [{ provider: "photon", status: "ok", endpoint: "https://photon.komoot.io/api/" }],
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	};
	const client = new RealMapClient(fakeFetch);
	const query = `巴黎 ${"address ".repeat(100)}`;
	assert.deepEqual((await client.search(query, "zh")).data, [place]);
	assert.equal(new URL(urls[0], "http://localhost").searchParams.get("q"), query);
	await client.nearby({ lat: 25.0478, lng: 121.517 }, "restaurant", 5000);
	const nearbyUrl = new URL(urls[1], "http://localhost");
	assert.equal(nearbyUrl.pathname, "/api/maps/nearby");
	assert.equal(nearbyUrl.searchParams.get("category"), "restaurant");
	assert.equal(nearbyUrl.searchParams.get("radius"), "5000");
	await client.reverse({ lat: 40.7, lng: -74 }, "en");
	assert.equal(new URL(urls[2], "http://localhost").pathname, "/api/maps/reverse");
});

test("upstream failure is an explicit error and never returns demo fallback data", async () => {
	const failure: typeof fetch = async () =>
		new Response(JSON.stringify({ error: "Source temporarily unavailable" }), { status: 503 });
	await assert.rejects(() => new RealMapClient(failure).search("Taipei", "en"), /Source temporarily unavailable/);
	const malformed: typeof fetch = async () => new Response(JSON.stringify({ places: [place] }));
	await assert.rejects(() => new RealMapClient(malformed).search("Taipei", "en"), /invalid response/);
});

test("cancelling a map lookup aborts its fetch and releases the pending wait", async () => {
	const fakeFetch: typeof fetch = async (_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
				once: true,
			});
		});
	const abort = new AbortController();
	const pending = new RealMapClient(fakeFetch).search("Tokyo", "en", abort.signal);
	abort.abort();
	await assert.rejects(pending, { name: "AbortError" });
});

test("browser fetch keeps its global receiver and uses the server's language and result bounds", async () => {
	const urls: URL[] = [];
	const fetcher: typeof fetch = async function (this: unknown, input) {
		assert.equal(this, globalThis, "Window.fetch cannot be called with a map client as its receiver");
		urls.push(new URL(String(input), "http://localhost"));
		return new Response(
			JSON.stringify({
				data: [place],
				sources: [{ provider: "photon", status: "ok", endpoint: "https://photon.komoot.io" }],
			}),
		);
	};
	const client = new RealMapClient(fetcher);
	await client.search("宁波", "en");
	await client.nearby({ lat: 29.87, lng: 121.55 }, "cafe", 2000);
	await client.reverse({ lat: 29.87, lng: 121.55 }, "en");
	assert.equal(urls[0].searchParams.get("lang"), "en");
	assert.ok(Number(urls[1].searchParams.get("limit")) <= 30);
	assert.equal(urls[2].searchParams.get("lang"), "en");
});

test("missing or older live state seeds only the user-confirmed district and ignores legacy view centers", () => {
	assert.deepEqual(parseLiveSavedState(null), seededEmpty);
	assert.deepEqual(parseLiveSavedState("null"), seededEmpty);
	assert.deepEqual(parseLiveSavedState(JSON.stringify({ version: 9 })), seededEmpty);
	const restored = parseLiveSavedState(
		JSON.stringify({
			version: 1,
			favorites: [place],
			history: [],
			lastCenter: { lat: 30.2741, lng: 120.1551 },
			lastLocationName: "杭州",
		}),
	);
	assert.deepEqual(restored.configuredLocation, DEFAULT_CONFIGURED_LOCATION);
	assert.equal(restored.configuredLocation?.name, "南京市雨花台区");
	assert.equal(restored.configuredLocation?.precision, "area");
	assert.equal(restored.configuredLocation?.source, "user");
	assert.deepEqual(restored.lastCenter, { lat: 30.2741, lng: 120.1551 });
	assert.deepEqual(restored.favorites, [place]);
});

test("configured user locations survive writes and reloads without being replaced by a browsing center", () => {
	let raw: string | undefined;
	const configured: ConfiguredMapLocation = {
		lat: 48.8566,
		lng: 2.3522,
		name: "Test configured point",
		source: "user",
		precision: "point",
		updatedAt: "2026-10-04T02:00:00.000Z",
	};
	assert.equal(
		writeLiveSavedState(
			{
				setItem: (_key, value) => {
					raw = value;
				},
			},
			{ favorites: [place], history: [], configuredLocation: configured, lastCenter: DEFAULT_CONFIGURED_LOCATION },
		),
		true,
	);
	const restored = readLiveSavedState({ getItem: () => raw ?? null });
	assert.deepEqual(restored.configuredLocation, configured);
	assert.deepEqual(restored.favorites, [place]);
	assert.equal(restored.lastCenter?.lat, DEFAULT_CONFIGURED_LOCATION.lat);
});

test("the first save persists the seeded district configuration even when prior state had no setting", () => {
	let raw: string | undefined;
	assert.equal(
		writeLiveSavedState(
			{
				setItem: (_key, value) => {
					raw = value;
				},
			},
			{ favorites: [], history: [] },
		),
		true,
	);
	assert.deepEqual(parseLiveSavedState(raw ?? null).configuredLocation, DEFAULT_CONFIGURED_LOCATION);
});

test("damaged configurations and GPS or network provenance return the confirmed district seed", () => {
	const malformed = [
		null,
		[],
		{ ...DEFAULT_CONFIGURED_LOCATION, source: "gps" },
		{ ...DEFAULT_CONFIGURED_LOCATION, source: "device" },
		{ ...DEFAULT_CONFIGURED_LOCATION, source: "network" },
		{ ...DEFAULT_CONFIGURED_LOCATION, lat: 91 },
		{ ...DEFAULT_CONFIGURED_LOCATION, lng: 181 },
		{ ...DEFAULT_CONFIGURED_LOCATION, lat: "31.99" },
		{ ...DEFAULT_CONFIGURED_LOCATION, name: "   " },
		{ ...DEFAULT_CONFIGURED_LOCATION, name: "x".repeat(501) },
		{ ...DEFAULT_CONFIGURED_LOCATION, name: "City\nDistrict" },
		{ ...DEFAULT_CONFIGURED_LOCATION, precision: "gps" },
		{ ...DEFAULT_CONFIGURED_LOCATION, updatedAt: "not a date" },
		{ ...DEFAULT_CONFIGURED_LOCATION, updatedAt: "2026-02-30T02:00:00.000Z" },
		{ ...DEFAULT_CONFIGURED_LOCATION, updatedAt: "2026-10-04T24:00:00.000Z" },
		{ ...DEFAULT_CONFIGURED_LOCATION, updatedAt: "2026-10-04" },
	];
	for (const configuredLocation of malformed) {
		assert.equal(normalizeConfiguredLocation(configuredLocation), undefined);
		const restored = parseLiveSavedState(
			JSON.stringify({ version: 1, favorites: [place], history: [], configuredLocation }),
		);
		assert.deepEqual(restored.configuredLocation, DEFAULT_CONFIGURED_LOCATION);
		assert.deepEqual(restored.favorites, [place]);
	}
	assert.equal(normalizeConfiguredLocation({ ...DEFAULT_CONFIGURED_LOCATION, lat: Number.NaN }), undefined);
	assert.equal(
		normalizeConfiguredLocation({ ...DEFAULT_CONFIGURED_LOCATION, lng: Number.POSITIVE_INFINITY }),
		undefined,
	);
});

test("configuration names and explicit ISO offsets normalize without inventing a device source", () => {
	const configured = normalizeConfiguredLocation({
		...DEFAULT_CONFIGURED_LOCATION,
		name: "  南京市雨花台区  ",
		updatedAt: "2026-10-04T02:50:00+08:00",
	});
	assert.deepEqual(configured, DEFAULT_CONFIGURED_LOCATION);
	assert.equal(
		normalizeConfiguredLocation({ ...DEFAULT_CONFIGURED_LOCATION, updatedAt: "2026-02-30T02:50:00+08:00" }),
		undefined,
	);
});

test("untrusted configuration writes are rejected before touching persistent storage", () => {
	let writes = 0;
	const storage = {
		setItem: () => {
			writes++;
		},
	};
	const badConfigured = { ...DEFAULT_CONFIGURED_LOCATION, source: "gps" } as unknown as ConfiguredMapLocation;
	assert.equal(writeLiveSavedState(storage, { favorites: [], history: [], configuredLocation: badConfigured }), false);
	assert.equal(writes, 0);
	const badCoordinates = { ...DEFAULT_CONFIGURED_LOCATION, lat: Number.NaN };
	assert.equal(
		writeLiveSavedState(storage, { favorites: [], history: [], configuredLocation: badCoordinates }),
		false,
	);
	assert.equal(writes, 0);
});

test("storage failures return an isolated district seed and callers cannot mutate the default", () => {
	const restored = readLiveSavedState({
		getItem: () => {
			throw new Error("Storage unavailable");
		},
	});
	assert.deepEqual(restored, seededEmpty);
	assert.notEqual(restored.configuredLocation, DEFAULT_CONFIGURED_LOCATION);
	if (restored.configuredLocation) restored.configuredLocation.name = "A changed local copy";
	assert.equal(parseLiveSavedState(null).configuredLocation?.name, "南京市雨花台区");
	assert.equal(
		writeLiveSavedState(
			{
				setItem: () => {
					throw new Error("Quota");
				},
			},
			restored,
		),
		false,
	);
});
