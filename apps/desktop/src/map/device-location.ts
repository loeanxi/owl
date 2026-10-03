import type { MapCoordinate } from "../bridge/protocol.ts";

export interface DeviceLocation extends MapCoordinate {
	accuracyMeters: number | null;
	timestamp: number;
	source: "gps";
}

export type DeviceLocationFailure = "locationDenied" | "locationUnavailable" | "locationTimeout" | "locationNoGps";

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
	private readonly readGps?: () => Promise<unknown>;
	private state: DeviceLocationState = { phase: "idle" };
	private readonly listeners = new Set<() => void>();
	private automaticConsumed = false;
	private sequence = 0;
	private pending?: PendingLocation;

	/** Construction and subscriptions never access the device or start timers. */
	constructor(options: { readGps?: () => Promise<unknown> }) {
		this.readGps = options.readGps;
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
		if (!this.readGps) {
			this.setState({
				phase: "error",
				location: this.state.location,
				error: "locationNoGps",
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

		void Promise.resolve()
			.then(() => (this.pending?.id === id ? this.readGps?.() : undefined))
			.then((value) => {
				if (this.pending?.id !== id) return;
				if (!value || typeof value !== "object") {
					this.finish(id, undefined, "locationUnavailable");
					return;
				}
				const position = value as Record<string, unknown>;
				const { lat, lng, accuracyMeters, timestamp, source } = position;
				if (
					source !== "gps" ||
					typeof lat !== "number" ||
					!Number.isFinite(lat) ||
					Math.abs(lat) > 90 ||
					typeof lng !== "number" ||
					!Number.isFinite(lng) ||
					Math.abs(lng) > 180 ||
					(accuracyMeters !== null &&
						(typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters < 0)) ||
					typeof timestamp !== "number" ||
					!Number.isFinite(timestamp) ||
					timestamp < 0 ||
					!Number.isFinite(new Date(timestamp).getTime())
				) {
					this.finish(id, undefined, "locationUnavailable");
					return;
				}
				this.finish(id, { lat, lng, accuracyMeters, timestamp, source: "gps" });
			})
			.catch((error: unknown) => {
				const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
				const failure: DeviceLocationFailure =
					code === "no-gps-device"
						? "locationNoGps"
						: code === "gps-permission-denied"
							? "locationDenied"
							: code === "gps-no-fix"
								? "locationTimeout"
								: "locationUnavailable";
				this.finish(id, undefined, failure);
			});
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
