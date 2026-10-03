import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeviceLocationFailure, DeviceLocator } from "./device-location.ts";

interface CapturedRequest {
	success: PositionCallback;
	error?: PositionErrorCallback | null;
	options?: PositionOptions;
}

class FakeGeolocation implements Pick<Geolocation, "getCurrentPosition"> {
	readonly requests: CapturedRequest[] = [];
	private readonly nativeReceiver = true;
	throwOnRequest = false;

	getCurrentPosition(
		success: PositionCallback,
		error?: PositionErrorCallback | null,
		options?: PositionOptions,
	): void {
		assert.equal(this.nativeReceiver, true, "native method receiver must be retained");
		this.requests.push({ success, error, options });
		if (this.throwOnRequest) throw new Error("Native location provider failed");
	}
}

function position(
	latitude = 31.2304,
	longitude = 121.4737,
	accuracy = 25,
	timestamp = 1791000000000,
): GeolocationPosition {
	const coords: GeolocationCoordinates = {
		latitude,
		longitude,
		accuracy,
		altitude: null,
		altitudeAccuracy: null,
		heading: null,
		speed: null,
		toJSON() {
			return { latitude, longitude, accuracy };
		},
	};
	return {
		coords,
		timestamp,
		toJSON() {
			return { coords: coords.toJSON(), timestamp };
		},
	};
}

function failure(code: number): GeolocationPositionError {
	return { code, message: "Native failure", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

test("construction, reads and subscribe/detach remain pure with stable snapshots", () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const snapshot = locator.getState();
	let updates = 0;
	const detach = locator.subscribe(() => updates++);
	assert.equal(locator.getState(), snapshot);
	assert.deepEqual(snapshot, { phase: "idle" });
	assert.equal(native.requests.length, 0);
	detach();
	locator.cancel();
	assert.equal(locator.getState(), snapshot);
	assert.equal(updates, 0);
});

test("automatic attempts once without duplicating pending subscribers; manual requests share the exact pending promise", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const first = locator.request(true);
	assert.equal(await locator.request(true), undefined);
	assert.equal(locator.request(), first);
	assert.equal(native.requests.length, 1);
	assert.deepEqual(native.requests[0].options, {
		enableHighAccuracy: true,
		timeout: 20000,
		maximumAge: 60000,
	});
	assert.equal(locator.getState().phase, "pending");
	native.requests[0].success(position());
	assert.deepEqual(await first, {
		lat: 31.2304,
		lng: 121.4737,
		accuracyMeters: 25,
		timestamp: 1791000000000,
		source: "device",
	});
	assert.equal(locator.getState().phase, "located");
	const located = locator.getState();
	assert.equal(await locator.request(true), undefined);
	assert.equal(locator.getState(), located);
	assert.equal(native.requests.length, 1);
	const retry = locator.request();
	assert.equal(native.requests.length, 2);
	native.requests[1].success(position(30.25, 120.15));
	assert.equal((await retry)?.lat, 30.25);
});

test("a manual first request consumes future automatic requests", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const manual = locator.request();
	native.requests[0].success(position());
	await manual;
	assert.equal(await locator.request(true), undefined);
	assert.equal(native.requests.length, 1);
});

test("automatic failure stays visible and a manual request can retry", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const automatic = locator.request(true);
	native.requests[0].error?.(failure(1));
	assert.equal(await automatic, undefined);
	assert.equal(locator.getState().error, "locationDenied");
	const denied = locator.getState();
	assert.equal(await locator.request(true), undefined);
	assert.equal(locator.getState(), denied);
	const retry = locator.request();
	assert.equal(locator.getState().error, undefined);
	native.requests[1].success(position());
	assert.ok(await retry);
	assert.equal(locator.getState().phase, "located");
	assert.equal(locator.getState().error, undefined);
});

test("cancel settles pending work synchronously and blocks stale success or error from changing a new request", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const canceled = locator.request(true);
	const old = native.requests[0];
	locator.cancel();
	assert.equal(locator.getState().phase, "idle");
	assert.equal(await canceled, undefined);
	const retry = locator.request();
	const pendingSnapshot = locator.getState();
	old.success(position(1, 2));
	old.error?.(failure(1));
	assert.equal(locator.getState(), pendingSnapshot);
	assert.equal(locator.getState().phase, "pending");
	native.requests[1].success(position());
	assert.equal((await retry)?.lat, 31.2304);
	const locatedSnapshot = locator.getState();
	old.success(position(3, 4));
	assert.equal(locator.getState(), locatedSnapshot);
});

test("cancel preserves an existing device position while settling a refresh and suppresses stale updates", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const initial = locator.request();
	native.requests[0].success(position());
	const existing = await initial;
	assert.ok(existing);
	const refresh = locator.request();
	assert.equal(locator.getState().location, existing);
	locator.cancel();
	assert.equal(await refresh, undefined);
	assert.deepEqual(locator.getState(), { phase: "located", location: existing });
	const snapshot = locator.getState();
	native.requests[1].success(position(20, 100));
	native.requests[1].error?.(failure(3));
	assert.equal(locator.getState(), snapshot);
});

test("cancel can suppress automatic positioning before it starts, while allowing later manual attempts", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	locator.cancel(true);
	assert.equal(await locator.request(true), undefined);
	assert.equal(native.requests.length, 0);
	const manual = locator.request();
	native.requests[0].success(position());
	assert.ok(await manual);
	assert.equal(native.requests.length, 1);
});

test("subscription detach never cancels an in-flight native request or loses its result", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	let updates = 0;
	const detach = locator.subscribe(() => updates++);
	const pending = locator.request(true);
	assert.equal(updates, 1);
	detach();
	native.requests[0].success(position());
	assert.ok(await pending);
	assert.equal(locator.getState().phase, "located");
	assert.equal(updates, 1);
});

test("invalid coordinates, accuracy or timestamps produce locationUnavailable rather than poisoning state", async () => {
	const invalid = [
		position(91),
		position(-91),
		position(30, 181),
		position(30, -181),
		position(Number.NaN),
		position(30, Number.POSITIVE_INFINITY),
		position(30, 120, -1),
		position(30, 120, Number.NaN),
		position(30, 120, Number.POSITIVE_INFINITY),
		position(30, 120, 5, -1),
		position(30, 120, 5, Number.NaN),
		position(30, 120, 5, Number.POSITIVE_INFINITY),
		position(30, 120, 5, 9e15),
	];
	for (const invalidPosition of invalid) {
		const native = new FakeGeolocation();
		const locator = new DeviceLocator({ geolocation: native, secureContext: true });
		const result = locator.request();
		native.requests[0].success(invalidPosition);
		assert.equal(await result, undefined);
		assert.equal(locator.getState().phase, "error");
		assert.equal(locator.getState().error, "locationUnavailable");
		assert.equal(locator.getState().location, undefined);
	}
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const boundary = locator.request();
	native.requests[0].success(position(90, -180, 0, 0));
	assert.deepEqual(await boundary, { lat: 90, lng: -180, accuracyMeters: 0, timestamp: 0, source: "device" });
});

test("native failure codes map to localized error keys and unknown codes remain unavailable", async () => {
	const codes: [number, DeviceLocationFailure][] = [
		[1, "locationDenied"],
		[2, "locationUnavailable"],
		[3, "locationTimeout"],
		[99, "locationUnavailable"],
	];
	for (const [code, key] of codes) {
		const native = new FakeGeolocation();
		const locator = new DeviceLocator({ geolocation: native, secureContext: true });
		const result = locator.request();
		native.requests[0].error?.(failure(code));
		assert.equal(await result, undefined);
		assert.equal(locator.getState().error, key);
	}
});

test("missing APIs, insecure contexts and synchronous native failures do not throw", async () => {
	const missing = new DeviceLocator({ secureContext: true });
	assert.equal(await missing.request(true), undefined);
	assert.equal(missing.getState().error, "locationUnavailable");
	const native = new FakeGeolocation();
	const insecure = new DeviceLocator({ geolocation: native, secureContext: false });
	assert.equal(await insecure.request(true), undefined);
	assert.equal(insecure.getState().error, "locationInsecure");
	assert.equal(native.requests.length, 0);
	native.throwOnRequest = true;
	const throwing = new DeviceLocator({ geolocation: native, secureContext: true });
	assert.equal(await throwing.request(true), undefined);
	assert.equal(throwing.getState().error, "locationUnavailable");
	const snapshot = throwing.getState();
	native.requests[0].success(position());
	assert.equal(throwing.getState(), snapshot);
});

test("synchronous success retains native method binding and settles its exact pending promise", async () => {
	const geolocation: Pick<Geolocation, "getCurrentPosition"> = {
		getCurrentPosition(success) {
			assert.equal(this, geolocation);
			success(position());
		},
	};
	const locator = new DeviceLocator({ geolocation, secureContext: true });
	assert.ok(await locator.request());
	assert.equal(locator.getState().phase, "located");
});

test("leaving the map preserves failure feedback; explicit manual navigation clears it and retains device facts", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const initial = locator.request();
	native.requests[0].success(position());
	const existing = await initial;
	const refresh = locator.request();
	native.requests[1].error?.(failure(2));
	await refresh;
	assert.equal(locator.getState().phase, "error");
	assert.equal(locator.getState().location, existing);
	const failed = locator.getState();
	locator.cancel();
	assert.equal(locator.getState(), failed);
	locator.cancel(true);
	assert.deepEqual(locator.getState(), { phase: "located", location: existing });
});

test("a listener may cancel pending work before the native call starts", async () => {
	const native = new FakeGeolocation();
	const locator = new DeviceLocator({ geolocation: native, secureContext: true });
	const detach = locator.subscribe(() => {
		if (locator.getState().phase === "pending") locator.cancel();
	});
	assert.equal(await locator.request(), undefined);
	assert.equal(native.requests.length, 0);
	assert.equal(locator.getState().phase, "idle");
	detach();
});
