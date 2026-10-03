import assert from "node:assert/strict";
import { test } from "node:test";
import type { RealPlace } from "../bridge/protocol.ts";
import { addLiveHistory, LIVE_MAP_STORAGE_KEY, nearbyCategoryFromMessage, normalizeRealPlace, parseCoordinates, parseLiveSavedState, readLiveSavedState, RealMapClient, safeExternalUrl, straightLineDistance, toggleLiveCompare, toggleLiveFavorite, writeLiveSavedState, type LiveSearchRecord } from "./live-model.ts";

const place: RealPlace = {
	id: "osm:node:123", name: "Test Source Place", lat: 48.8566, lng: 2.3522, address: "Paris", category: "cafe", distanceMeters: 100,
	openingHours: "Mo-Fr 09:00-17:00", phone: null, website: "https://example.org", wheelchair: null, internetAccess: null,
	rating: null, price: null, quiet: null, plug: null, tags: { amenity: "cafe" }, source: { provider: "photon", url: "https://www.openstreetmap.org/node/123", fetchedAt: "2026-10-03T12:00:00Z" },
};

test("coordinate input accepts latitude, longitude and rejects invalid ranges or silent swapping", () => {
	assert.deepEqual(parseCoordinates("48.8566, 2.3522"), { lat: 48.8566, lng: 2.3522 });
	assert.deepEqual(parseCoordinates("-33.86，151.2"), { lat: -33.86, lng: 151.2 });
	assert.deepEqual(parseCoordinates("0,0"), { lat: 0, lng: 0 });
	assert.equal(parseCoordinates("120.15, 30.25"), undefined);
	assert.equal(parseCoordinates("30, 181"), undefined);
	assert.equal(parseCoordinates("Paris"), undefined);
});

test("live storage never reads or accepts old demo favorites and keeps complete source records", () => {
	const storage = new Map<string, string>([["owl.map.demo.v1", JSON.stringify({ version: 1, favorites: ["liubai"], history: ["cafe"] })]]);
	assert.deepEqual(readLiveSavedState({ getItem: (key) => storage.get(key) ?? null }), { favorites: [], history: [] });
	assert.equal(writeLiveSavedState({ setItem: (key, value) => { storage.set(key, value); } }, { favorites: [place], history: [], lastCenter: { lat: 48.8566, lng: 2.3522 }, lastLocationName: "Paris" }), true);
	const restored = parseLiveSavedState(storage.get(LIVE_MAP_STORAGE_KEY) ?? null);
	assert.deepEqual(restored.favorites[0], place);
	assert.equal(restored.lastLocationName, "Paris");
	assert.deepEqual(parseLiveSavedState("{broken"), { favorites: [], history: [] });
	assert.deepEqual(parseLiveSavedState(JSON.stringify({ version: 1, favorites: ["liubai", { ...place, lat: 300 }], history: ["old query"] })), { favorites: [], history: [] });
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
	const second = { ...place, id: "osm:node:124" }, third = { ...place, id: "osm:node:125" }, fourth = { ...place, id: "osm:node:126" };
	assert.deepEqual(toggleLiveCompare([place, second, third], fourth), { places: [place, second, third], full: true });
	assert.deepEqual(toggleLiveCompare([place, second], place), { places: [second], full: false });
});

test("search history retains the selected city, coordinates, radius and category", () => {
	const history: LiveSearchRecord = { id: "a", query: "Paris", center: { lat: 48.8566, lng: 2.3522 }, locationName: "Paris", category: "museum", radiusMeters: 2000, kind: "nearby", createdAt: "2026-10-03T12:00:00Z" };
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
	const fakeFetch: typeof fetch = async (input) => { urls.push(String(input)); return new Response(JSON.stringify({ data: [place], sources: [{ provider: "photon", status: "ok", endpoint: "https://photon.komoot.io/api/" }] }), { headers: { "Content-Type": "application/json" } }); };
	const client = new RealMapClient(fakeFetch);
	const query = "巴黎 " + "address ".repeat(100);
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
	const failure: typeof fetch = async () => new Response(JSON.stringify({ error: "Source temporarily unavailable" }), { status: 503 });
	await assert.rejects(() => new RealMapClient(failure).search("Taipei", "en"), /Source temporarily unavailable/);
	const malformed: typeof fetch = async () => new Response(JSON.stringify({ places: [place] }));
	await assert.rejects(() => new RealMapClient(malformed).search("Taipei", "en"), /invalid response/);
});
