import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { handleMapHttp } from "../src/map-http.ts";
import type { GeocodeRequest, MapResult, NearbyRequest, RealPlace, ReverseRequest } from "../src/types.ts";

const result: MapResult<RealPlace> = {
	data: [],
	sources: [{ provider: "photon", status: "ok", endpoint: "https://photon.komoot.io" }],
};

async function run(check: (base: string, calls: unknown[]) => Promise<void>): Promise<void> {
	const calls: unknown[] = [];
	const server = createServer((request, response) => {
		void handleMapHttp(request, response, {
			authorizeOrigin: (origin) => !origin || origin.startsWith("http://127.0.0.1:"),
			service: {
				geocode: async (request: GeocodeRequest) => {
					calls.push(request);
					return result;
				},
				nearby: async (request: NearbyRequest) => {
					calls.push(request);
					return result;
				},
				reverse: async (request: ReverseRequest) => {
					calls.push(request);
					return result;
				},
			},
		}).then((handled) => {
			if (!handled) response.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

describe("real map HTTP integration", () => {
	it("accepts arbitrary UTF-8 cities and forwards explicit language and coordinates", async () => {
		await run(async (base, calls) => {
			const response = await fetch(
				`${base}/api/maps/search?q=${encodeURIComponent("宁波 天一广场")}&lang=en&lat=29.87&lng=121.55`,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("application/json");
			expect(await response.json()).toEqual(result);
			expect(calls).toEqual([
				{ query: "宁波 天一广场", language: "en", limit: 12, center: { lat: 29.87, lng: 121.55 } },
			]);
		});
	});
	it("nearby restaurant and reverse routes retain the caller's true coordinate axes", async () => {
		await run(async (base, calls) => {
			expect(
				(await fetch(`${base}/api/maps/nearby?lat=25.05&lng=121.52&category=restaurant&radius=2000&limit=20`))
					.status,
			).toBe(200);
			expect((await fetch(`${base}/api/maps/reverse?lat=25.05&lng=121.52`)).status).toBe(200);
			expect(calls).toEqual([
				{ center: { lat: 25.05, lng: 121.52 }, category: "restaurant", radiusMeters: 2000, limit: 20 },
				{ point: { lat: 25.05, lng: 121.52 }, language: "zh" },
			]);
		});
	});
	it("rejects malformed coordinates, unlimited radii, invalid categories and oversized queries before any source request", async () => {
		await run(async (base, calls) => {
			for (const query of [
				"lat=91&lng=120",
				"lat=30&lng=181",
				"lat=&lng=120",
				"lat=30",
				"lat=30&lng=120&radius=99999",
				"lat=30&lng=120&category=unknown",
				"lat=30&lng=120&limit=60",
				"lat=30&lng=120&limit=1.5",
			]) {
				expect((await fetch(`${base}/api/maps/nearby?${query}`)).status).toBe(400);
			}
			expect((await fetch(`${base}/api/maps/search?q=${"x".repeat(201)}`)).status).toBe(400);
			expect(calls).toEqual([]);
		});
	});
	it("does not expose a writable proxy or accept foreign browser origins", async () => {
		await run(async (base, calls) => {
			expect((await fetch(`${base}/api/maps/search?q=test`, { method: "POST" })).status).toBe(405);
			expect(
				(await fetch(`${base}/api/maps/search?q=test`, { headers: { Origin: "https://foreign.invalid" } })).status,
			).toBe(403);
			expect((await fetch(`${base}/api/maps/anything`)).status).toBe(404);
			expect(calls).toEqual([]);
		});
	});
});
