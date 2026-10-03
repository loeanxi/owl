import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceLocator } from "./device-location.ts";

class FakeGps {
	readonly requests: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
	read = (): Promise<unknown> => new Promise((resolve, reject) => this.requests.push({ resolve, reject }));
}

function position(lat = 31.2304, lng = 121.4737, accuracyMeters: number | null = 25) {
	return { lat, lng, accuracyMeters, timestamp: 1791040000000, source: "gps" as const };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("construction and subscriptions do not request GPS and snapshots are stable", () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const state = locator.getState();
	const detach = locator.subscribe(() => {});
	assert.equal(locator.getState(), state);
	assert.equal(gps.requests.length, 0);
	detach();
	locator.cancel();
	assert.equal(locator.getState(), state);
});

test("GPS automatically attempts once; manual requests coalesce and can refresh", async () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const initial = locator.request(true);
	assert.equal(await locator.request(true), undefined);
	assert.equal(locator.request(), initial);
	await flush();
	assert.equal(gps.requests.length, 1);
	gps.requests[0].resolve(position());
	assert.deepEqual(await initial, position());
	assert.equal(locator.getState().phase, "located");
	assert.equal(await locator.request(true), undefined);
	const refresh = locator.request();
	await flush();
	assert.equal(gps.requests.length, 2);
	gps.requests[1].resolve(position(30.25, 120.15));
	assert.equal((await refresh)?.lat, 30.25);
});

test("a manual GPS request consumes automatic attempts without duplicating native calls", async () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const manual = locator.request();
	await flush();
	assert.equal(await locator.request(true), undefined);
	assert.equal(gps.requests.length, 1);
	gps.requests[0].resolve(position());
	assert.ok(await manual);
});

test("only an explicit GPS source is accepted; Wi-Fi, IP and mixed device results are rejected", async () => {
	for (const source of ["wifi", "ip", "device", "satellite", "unknown", undefined]) {
		const locator = new DeviceLocator({ readGps: async () => ({ ...position(), source }) });
		assert.equal(await locator.request(), undefined);
		assert.equal(locator.getState().error, "locationUnavailable");
		assert.equal(locator.getState().location, undefined);
	}
});

test("GPS accuracy may be unknown without inventing a precision value", async () => {
	const locator = new DeviceLocator({ readGps: async () => position(30.25, 120.15, null) });
	assert.deepEqual(await locator.request(), position(30.25, 120.15, null));
});

test("GPS coordinate, accuracy and timestamp validation rejects invalid provider data", async () => {
	const invalid = [
		position(91),
		position(-91),
		position(30, 181),
		position(30, -181),
		position(Number.NaN),
		position(30, 120, -1),
		position(30, 120, Number.NaN),
		{ ...position(), timestamp: -1 },
		{ ...position(), timestamp: 9e15 },
		{ ...position(), accuracyMeters: undefined },
		undefined,
	];
	for (const value of invalid) {
		const locator = new DeviceLocator({ readGps: async () => value });
		assert.equal(await locator.request(), undefined);
		assert.equal(locator.getState().error, "locationUnavailable");
	}
});

test("missing GPS reader reports no GPS device without falling back to browser geolocation", async () => {
	const locator = new DeviceLocator({});
	assert.equal(await locator.request(true), undefined);
	assert.equal(locator.getState().error, "locationNoGps");
	assert.equal(await locator.request(true), undefined);
});

test("native GPS errors produce specific hardware, permission and fix feedback", async () => {
	const cases = [
		["no-gps-device", "locationNoGps"],
		["gps-permission-denied", "locationDenied"],
		["gps-no-fix", "locationTimeout"],
		["gps-unavailable", "locationUnavailable"],
	];
	for (const [code, expected] of cases) {
		const locator = new DeviceLocator({
			readGps: async () => {
				throw { code };
			},
		});
		assert.equal(await locator.request(), undefined);
		assert.equal(locator.getState().error, expected);
	}
	const throwing = new DeviceLocator({
		readGps: () => {
			throw new Error("GPS driver failed");
		},
	});
	assert.equal(await throwing.request(), undefined);
	assert.equal(throwing.getState().error, "locationUnavailable");
});

test("manual navigation cancels a pending GPS request and ignores late results", async () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const pending = locator.request(true);
	await flush();
	locator.cancel(true);
	assert.equal(await pending, undefined);
	const state = locator.getState();
	gps.requests[0].resolve(position());
	await flush();
	assert.equal(locator.getState(), state);
	assert.equal(await locator.request(true), undefined);
});

test("a canceled GPS result cannot overwrite a newer native read", async () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const first = locator.request(true);
	await flush();
	locator.cancel();
	assert.equal(await first, undefined);
	const retry = locator.request();
	await flush();
	gps.requests[0].resolve(position(1, 2));
	await flush();
	assert.equal(locator.getState().phase, "pending");
	gps.requests[1].resolve(position(30, 120));
	assert.equal((await retry)?.lat, 30);
});

test("leaving the map preserves errors; manual navigation clears them and preserves earlier GPS facts", async () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const initial = locator.request();
	await flush();
	gps.requests[0].resolve(position());
	const previous = await initial;
	const refresh = locator.request();
	await flush();
	gps.requests[1].reject({ code: "gps-no-fix" });
	await refresh;
	const failed = locator.getState();
	locator.cancel();
	assert.equal(locator.getState(), failed);
	locator.cancel(true);
	assert.deepEqual(locator.getState(), { phase: "located", location: previous });
});

test("canceling before the native read begins prevents any GPS provider call", async () => {
	const gps = new FakeGps();
	const locator = new DeviceLocator({ readGps: gps.read });
	const pending = locator.request(true);
	locator.cancel();
	await flush();
	assert.equal(await pending, undefined);
	assert.equal(gps.requests.length, 0);
});
