import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import type { GeocodeRequest, MapResult, NearbyRequest, RealPlace, ReverseRequest } from "../src/core/maps/types.ts";
import { createMapTools } from "../src/modes/desktop/map-tools.ts";
import type { DesktopServerMessage } from "../src/modes/desktop/protocol.ts";

const place: RealPlace = {
	id: "osm:node:4771034248",
	name: "星巴克",
	lat: 30.2478308,
	lng: 120.2051344,
	address: null,
	category: "cafe",
	distanceMeters: 126,
	openingHours: null,
	phone: null,
	website: null,
	wheelchair: null,
	internetAccess: null,
	rating: null,
	price: null,
	quiet: null,
	plug: null,
	tags: { amenity: "cafe" },
	source: {
		provider: "photon",
		url: "https://www.openstreetmap.org/node/4771034248",
		fetchedAt: "2026-10-03T00:00:00.000Z",
	},
};
const result: MapResult<RealPlace> = {
	data: [place],
	sources: [{ provider: "photon", status: "ok", endpoint: "https://photon.komoot.io" }],
};
const context = {} as ExtensionToolContext;

function fixture(output = result) {
	const service = {
		geocode: vi.fn(async (_request: GeocodeRequest) => output),
		nearby: vi.fn(async (_request: NearbyRequest) => output),
		reverse: vi.fn(async (_request: ReverseRequest) => output),
	};
	const messages: DesktopServerMessage[] = [];
	const tools = createMapTools(service, "map-session", (message) => {
		messages.push(message);
	});
	const tool = (name: string) => {
		const found = tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`Missing tool ${name}`);
		return found;
	};
	return { service, messages, tools, tool };
}

describe("AI map tool and desktop result seam", () => {
	it("uses the service search result coordinates, not a model guess or the optional bias, for its typed map frame", async () => {
		const { service, messages, tool } = fixture();
		const output = await tool("map_search").execute(
			"call",
			{ query: "杭州 星巴克", lat: 30, lng: 120, limit: 5 },
			undefined,
			undefined,
			context,
		);
		expect(service.geocode).toHaveBeenCalledWith({ query: "杭州 星巴克", center: { lat: 30, lng: 120 }, limit: 5 });
		expect(messages).toEqual([
			{
				type: "map.results",
				sessionId: "map-session",
				update: { action: "search", query: "杭州 星巴克", center: { lat: place.lat, lng: place.lng }, result },
			},
		]);
		expect(output.details).toMatchObject({
			data: [place],
			sources: result.sources,
			_trust: { contentTrust: "untrusted_external_data" },
		});
		expect(output.content[0].type).toBe("text");
		if (output.content[0].type !== "text") throw new Error("Expected JSON text");
		expect(output.content[0].text).toContain('"price":null');
		expect(output.content[0].text).toContain('"plug":null');
		expect(output.isError).toBe(false);
	});

	it("nearby and reverse frames retain the requested source coordinate and route to the correct session", async () => {
		const { service, messages, tool } = fixture();
		await tool("map_nearby").execute(
			"call",
			{ lat: 29.87, lng: 121.55, category: "restaurant", radiusMeters: 1500, limit: 8 },
			undefined,
			undefined,
			context,
		);
		expect(service.nearby).toHaveBeenCalledWith({
			center: { lat: 29.87, lng: 121.55 },
			category: "restaurant",
			radiusMeters: 1500,
			limit: 8,
		});
		expect(messages[0]).toMatchObject({
			type: "map.results",
			sessionId: "map-session",
			update: {
				action: "nearby",
				center: { lat: 29.87, lng: 121.55 },
				category: "restaurant",
				radiusMeters: 1500,
				result,
			},
		});
		await tool("map_reverse").execute("call", { lat: 25.04, lng: 121.51 }, undefined, undefined, context);
		expect(service.reverse).toHaveBeenCalledWith({ point: { lat: 25.04, lng: 121.51 } });
		expect(messages[1]).toMatchObject({
			type: "map.results",
			sessionId: "map-session",
			update: { action: "reverse", center: { lat: 25.04, lng: 121.51 }, result },
		});
	});

	it("an upstream failure remains an error with original source information and cannot clear the previous map", async () => {
		const failed: MapResult<RealPlace> = {
			data: [],
			sources: [{ provider: "photon", status: "error", endpoint: "https://photon.komoot.io", error: "HTTP 503" }],
		};
		const { messages, tool } = fixture(failed);
		const output = await tool("map_nearby").execute(
			"call",
			{ lat: 30.25, lng: 120.2, category: "cafe" },
			undefined,
			undefined,
			context,
		);
		expect(output.isError).toBe(true);
		expect(output.details).toMatchObject(failed);
		expect(messages).toEqual([]);
	});

	it("a successful empty query clears only the requested result set and never supplies default demo places", async () => {
		const empty: MapResult<RealPlace> = { data: [], sources: result.sources };
		const { messages, tool } = fixture(empty);
		const output = await tool("map_search").execute(
			"call",
			{ query: "没有收录的地点" },
			undefined,
			undefined,
			context,
		);
		expect(output.isError).toBe(false);
		expect(messages).toEqual([
			{
				type: "map.results",
				sessionId: "map-session",
				update: { action: "search", query: "没有收录的地点", result: empty },
			},
		]);
	});

	it("partial source failure keeps the successful real results and warning instead of replacing them", async () => {
		const partial: MapResult<RealPlace> = {
			data: [place],
			sources: [
				{
					provider: "overpass",
					status: "error",
					endpoint: "https://configured.example/api/interpreter",
					error: "timeout",
				},
				...result.sources,
			],
		};
		const { messages, tool } = fixture(partial);
		const output = await tool("map_nearby").execute(
			"call",
			{ lat: 30.25, lng: 120.2, category: "cafe" },
			undefined,
			undefined,
			context,
		);
		expect(output.isError).toBe(false);
		expect(messages[0]).toMatchObject({ update: { result: partial, radiusMeters: 2000 } });
	});

	it("schemas bound typed arguments and an incomplete search bias does not call any source", async () => {
		const { tools, service, messages, tool } = fixture();
		expect(tools.every((candidate) => candidate.annotations?.readOnlyHint === true)).toBe(true);
		expect(Value.Check(tool("map_search").parameters, { query: "杭州" })).toBe(true);
		expect(
			Value.Check(tool("map_nearby").parameters, { lat: 30, lng: 120, category: "restaurant", radiusMeters: 1000 }),
		).toBe(true);
		expect(Value.Check(tool("map_nearby").parameters, { lat: 91, lng: 120, category: "cafe" })).toBe(false);
		expect(Value.Check(tool("map_nearby").parameters, { lat: 30, lng: 120, category: "hotel" })).toBe(false);
		expect(
			Value.Check(tool("map_nearby").parameters, { lat: 30, lng: 120, category: "cafe", radiusMeters: 5001 }),
		).toBe(false);
		expect(Value.Check(tool("map_search").parameters, { query: "杭州", apiKey: "unrequested" })).toBe(false);
		const output = await tool("map_search").execute(
			"call",
			{ query: "杭州", lat: 30 },
			undefined,
			undefined,
			context,
		);
		expect(output.isError).toBe(true);
		expect(service.geocode).not.toHaveBeenCalled();
		expect(messages).toEqual([]);
	});

	it("cancelled or throwing source lookups do not publish a late frame after the run has stopped", async () => {
		const { service, messages, tool } = fixture();
		const abort = new AbortController();
		service.geocode.mockImplementation(async () => {
			abort.abort();
			return result;
		});
		const cancelled = await tool("map_search").execute("call", { query: "杭州" }, abort.signal, undefined, context);
		expect(cancelled.isError).toBe(true);
		expect(cancelled.details).toMatchObject({ cancelled: true });
		expect(messages).toEqual([]);
		service.reverse.mockRejectedValue(new Error("Source unavailable"));
		const failed = await tool("map_reverse").execute("call", { lat: 30, lng: 120 }, undefined, undefined, context);
		expect(failed.isError).toBe(true);
		expect(failed.details).toMatchObject({ error: "Source unavailable" });
		expect(messages).toEqual([]);
	});
});
