import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addSearchHistory,
	DEFAULT_SEARCH,
	DEMO_PLACES,
	getFavoriteResults,
	getSearchResults,
	keepVisibleSelection,
	MAP_STORAGE_KEY,
	MAX_QUERY_LENGTH,
	MAX_SEARCH_HISTORY,
	parseMapQuery,
	parseMapSavedState,
	readMapSavedState,
	toggleCompare,
	toggleFavorite,
	writeMapSavedState,
} from "./model.ts";

test("demo search applies combined criteria and sorts without mutating the source places", () => {
	const sourceOrder = DEMO_PLACES.map((place) => place.id);
	const office = parseMapQuery("找安静、有插座、预算50元内的咖啡馆");
	assert.deepEqual(
		getSearchResults(office).map((place) => place.id),
		["liubai", "muchuang"],
	);
	assert.deepEqual(
		getSearchResults({ ...office, sort: "price" }).map((place) => place.id),
		["muchuang", "liubai"],
	);
	assert.deepEqual(
		DEMO_PLACES.map((place) => place.id),
		sourceOrder,
	);
	assert.equal(DEFAULT_SEARCH.filters.size, 0);
});

test("region boundaries include only their demo places and never treat Wulin as Xihu District", () => {
	assert.deepEqual(
		getSearchResults({ ...DEFAULT_SEARCH, region: "西湖区" }).map((place) => place.id),
		["shangu"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("武林的咖啡馆")).map((place) => place.id),
		["muchuang"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("湖滨的咖啡馆")).map((place) => place.id),
		["liubai", "qingshi"],
	);
	assert.equal(getSearchResults({ ...DEFAULT_SEARCH, region: "all" }).length, 4);
	assert.deepEqual(
		getFavoriteResults(["liubai", "muchuang", "unknown"], "湖滨").map((place) => place.id),
		["liubai"],
	);
});

test("a follow-up retains its range and filters while a new topic starts with its own criteria", () => {
	const current = parseMapQuery("武林安静的咖啡馆");
	const next = parseMapQuery("预算50元内，有插座", current);
	assert.equal(next.region, "武林");
	assert.equal(next.filters.has("quiet"), true);
	assert.deepEqual(
		getSearchResults(next).map((place) => place.id),
		["muchuang"],
	);
	const park = parseMapQuery("整个杭州沿着湖边散步", next);
	assert.equal(park.category, "park");
	assert.equal(park.region, "all");
	assert.equal(park.filters.has("plug"), false);
	assert.deepEqual(
		getSearchResults(park).map((place) => place.id),
		["park"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("看一个展览")).map((place) => place.id),
		["museum"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("湖西绿径", { ...next, region: "all" })).map((place) => place.id),
		["park"],
	);
	assert.equal(current.filters.has("budget"), false);
});

test("unknown requests and unsupported categories or cities produce an honest empty result", () => {
	for (const query of [
		"帮我修复代码",
		"找一个安静的酒店",
		"北京的咖啡馆",
		"咖啡馆预算100元",
		"Cafe budget under 100",
		"预算",
		"   ",
	]) {
		const scope = parseMapQuery(query);
		assert.equal(scope.unsupported, true, query);
		assert.deepEqual(getSearchResults(scope), [], query);
	}
	assert.deepEqual(
		getSearchResults(parseMapQuery("木窗咖啡")).map((place) => place.id),
		["muchuang"],
	);
});

test("English presets, place names and follow-ups match their localized demo conditions", () => {
	assert.deepEqual(
		getSearchResults(parseMapQuery("A cafe near West Lake to work on my laptop")).map((place) => place.id),
		["liubai"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("Find a lakeside park for a walk")).map((place) => place.id),
		["park"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("An exhibition to explore this weekend")).map((place) => place.id),
		["museum"],
	);
	assert.deepEqual(
		getSearchResults(parseMapQuery("Timber Window Cafe")).map((place) => place.id),
		["muchuang"],
	);
	const scope = parseMapQuery("Somewhere quieter with sockets and budget under ¥50", {
		...DEFAULT_SEARCH,
		region: "武林",
	});
	assert.deepEqual(
		getSearchResults(scope).map((place) => place.id),
		["muchuang"],
	);
	assert.equal(parseMapQuery("a quiet restaurant in Hangzhou").unsupported, true);
});

test("selection stays visible after filtering and disappears with zero results", () => {
	const all = getSearchResults(DEFAULT_SEARCH);
	assert.equal(keepVisibleSelection(all, "muchuang"), "muchuang");
	const lakeside = getSearchResults(parseMapQuery("只看湖边的咖啡馆"));
	assert.equal(keepVisibleSelection(lakeside, "muchuang"), "liubai");
	const empty = getSearchResults({ ...parseMapQuery("武林的咖啡馆"), filters: new Set(["lake"]) });
	assert.equal(empty.length, 0);
	assert.equal(keepVisibleSelection(empty, "muchuang"), undefined);
});

test("favorites and comparison remain separate and comparison enforces its three-place limit", () => {
	const favorites = toggleFavorite(["liubai", "invalid", "liubai"], "muchuang");
	assert.deepEqual(favorites, ["liubai", "muchuang"]);
	const compared = ["liubai", "muchuang", "qingshi"];
	assert.deepEqual(toggleCompare(compared, "shangu"), { ids: compared, status: "full" });
	assert.deepEqual(toggleCompare(compared, "muchuang"), { ids: ["liubai", "qingshi"], status: "removed" });
	assert.deepEqual(toggleCompare(["liubai", "liubai", "invalid"], "park"), {
		ids: ["liubai", "park"],
		status: "added",
	});
	assert.deepEqual(toggleCompare(["liubai"], "invalid"), { ids: ["liubai"], status: "invalid" });
	assert.deepEqual(toggleFavorite(favorites, "liubai"), ["muchuang"]);
	assert.deepEqual(compared, ["liubai", "muchuang", "qingshi"]);
});

test("saved state rejects corrupt or old envelopes and validates dirty arrays", () => {
	for (const raw of [null, "{", "null", "[]", '{"version":0,"favorites":["liubai"]}', '{"favorites":["liubai"]}']) {
		assert.deepEqual(parseMapSavedState(raw), { favorites: [], history: [] });
	}
	const saved = parseMapSavedState(
		JSON.stringify({
			version: 1,
			favorites: ["liubai", null, "invalid", "liubai", "park"],
			history: ["  咖啡馆 ", null, 12, "", "咖啡馆", "沿湖散步"],
		}),
	);
	assert.deepEqual(saved, { favorites: ["liubai", "park"], history: ["咖啡馆", "沿湖散步"] });
	assert.deepEqual(parseMapSavedState('{"version":1,"favorites":{},"history":true}'), { favorites: [], history: [] });
});

test("history is bounded, deduplicated and moves a repeated query to the front", () => {
	const history = Array.from({ length: MAX_SEARCH_HISTORY + 5 }, (_, index) => `地点 ${index}`);
	const next = addSearchHistory(history, "  地点 3  ");
	assert.equal(next.length, MAX_SEARCH_HISTORY);
	assert.equal(next[0], "地点 3");
	assert.equal(next.filter((entry) => entry === "地点 3").length, 1);
	assert.equal(addSearchHistory([], "x".repeat(MAX_QUERY_LENGTH + 30))[0].length, MAX_QUERY_LENGTH);
	assert.deepEqual(addSearchHistory(["", "   ", "咖啡馆"], "   "), ["咖啡馆"]);
});

test("saving is scoped to demo storage and denied access does not lose in-memory state", () => {
	const entries = new Map<string, string>([["owl.model", "existing-chat-model"]]);
	const storage = {
		getItem: (key: string): string | null => entries.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			entries.set(key, value);
		},
	};
	const state = { favorites: toggleFavorite([], "liubai"), history: ["咖啡馆"] };
	assert.equal(writeMapSavedState(storage, state), true);
	assert.deepEqual(readMapSavedState(storage), state);
	assert.equal(entries.get("owl.model"), "existing-chat-model");
	assert.ok(entries.has(MAP_STORAGE_KEY));
	assert.equal(
		writeMapSavedState(
			{
				setItem: () => {
					throw new Error("quota exceeded");
				},
			},
			state,
		),
		false,
	);
	assert.deepEqual(
		readMapSavedState({
			getItem: () => {
				throw new Error("storage denied");
			},
		}),
		{ favorites: [], history: [] },
	);
	assert.deepEqual(state, { favorites: ["liubai"], history: ["咖啡馆"] });
});
