import type { MapCoordinate } from "../bridge/protocol.ts";

export interface DeviceLocation extends MapCoordinate {
	accuracyMeters: number;
	timestamp: number;
	source: "device";
}

export type DeviceLocationFailure = "locationDenied" | "locationUnavailable" | "locationTimeout" | "locationInsecure";

export interface DeviceLocationState {
	phase: "idle" | "pending" | "located" | "error";
	location?: DeviceLocation;
	error?: DeviceLocationFailure;
}

interface PendingLocation {
	id: number;
	promise: Promise<DeviceLocation | undefined>;
	resolve: (location: DeviceLocation | undefined) => void;
}

export class DeviceLocator {
	private readonly geolocation?: Pick<Geolocation, "getCurrentPosition">;
	private readonly secureContext: boolean;
	private state: DeviceLocationState = { phase: "idle" };
	private readonly listeners = new Set<() => void>();
	private automaticConsumed = false;
	private sequence = 0;
	private pending?: PendingLocation;

	/** Construction and subscriptions never access the device or start timers. */
	constructor(options: {
		geolocation?: Pick<Geolocation, "getCurrentPosition">;
		secureContext: boolean;
	}) {
		this.geolocation = options.geolocation;
		this.secureContext = options.secureContext;
	}

	getState = (): DeviceLocationState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	request(automatic = false): Promise<DeviceLocation | undefined> {
		if (automatic && this.automaticConsumed) return Promise.resolve(undefined);
		if (this.pending) return this.pending.promise;
		this.automaticConsumed = true;
		if (!this.secureContext || !this.geolocation) {
			this.setState({
				phase: "error",
				location: this.state.location,
				error: this.secureContext ? "locationUnavailable" : "locationInsecure",
			});
			return Promise.resolve(undefined);
		}

		const id = ++this.sequence;
		let resolve!: (location: DeviceLocation | undefined) => void;
		const promise = new Promise<DeviceLocation | undefined>((complete) => {
			resolve = complete;
		});
		this.pending = { id, promise, resolve };
		this.setState({ phase: "pending", location: this.state.location });
		if (this.pending?.id !== id) return promise;

		try {
			// Keep the native Geolocation object as the method receiver.
			this.geolocation.getCurrentPosition(
				(position) => {
					if (this.pending?.id !== id) return;
					try {
						const lat = position?.coords?.latitude;
						const lng = position?.coords?.longitude;
						const accuracyMeters = position?.coords?.accuracy;
						const timestamp = position?.timestamp;
						if (
							!Number.isFinite(lat) ||
							Math.abs(lat) > 90 ||
							!Number.isFinite(lng) ||
							Math.abs(lng) > 180 ||
							!Number.isFinite(accuracyMeters) ||
							accuracyMeters < 0 ||
							!Number.isFinite(timestamp) ||
							timestamp < 0 ||
							!Number.isFinite(new Date(timestamp).getTime())
						) {
							this.finish(id, undefined, "locationUnavailable");
							return;
						}
						this.finish(id, { lat, lng, accuracyMeters, timestamp, source: "device" });
					} catch {
						this.finish(id, undefined, "locationUnavailable");
					}
				},
				(error) => {
					const failure =
						error?.code === 1 ? "locationDenied" : error?.code === 3 ? "locationTimeout" : "locationUnavailable";
					this.finish(id, undefined, failure);
				},
				{ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
			);
		} catch {
			this.finish(id, undefined, "locationUnavailable");
		}
		return promise;
	}

	cancel(suppressAutomatic = false): void {
		if (suppressAutomatic) this.automaticConsumed = true;
		this.sequence++;
		const pending = this.pending;
		this.pending = undefined;
		pending?.resolve(undefined);
		if (this.state.phase === "pending" || (suppressAutomatic && this.state.phase === "error")) {
			const location = this.state.location;
			this.setState(location ? { phase: "located", location } : { phase: "idle" });
		}
	}

	private finish(id: number, location?: DeviceLocation, error?: DeviceLocationFailure): void {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		this.pending = undefined;
		pending.resolve(location);
		this.setState(
			location ? { phase: "located", location } : { phase: "error", location: this.state.location, error },
		);
	}

	private setState(state: DeviceLocationState): void {
		this.state = state;
		for (const listener of Array.from(this.listeners)) listener();
	}
}
