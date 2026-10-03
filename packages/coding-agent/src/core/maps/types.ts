export type MapCategory = "all" | "cafe" | "restaurant" | "park" | "museum";
export type MapPlaceCategory = Exclude<MapCategory, "all"> | "other";

export interface MapCoordinate {
	lat: number;
	lng: number;
}

export interface MapBounds {
	south: number;
	west: number;
	north: number;
	east: number;
}

export interface MapDataSource {
	provider: "photon" | "overpass" | "user";
	url: string;
	fetchedAt: string;
}

export interface RealMapPoint extends MapCoordinate {
	id: string;
	name: string;
	address: string | null;
	bbox?: MapBounds;
	source: MapDataSource;
}

/** Unknown business details remain null; only fetched source fields may populate them. */
export interface RealPlace extends RealMapPoint {
	category: MapPlaceCategory;
	distanceMeters: number | null;
	openingHours: string | null;
	phone: string | null;
	website: string | null;
	wheelchair: string | null;
	internetAccess: string | null;
	rating: number | null;
	price: number | null;
	quiet: boolean | null;
	plug: boolean | null;
	tags: Record<string, string>;
}

export interface MapSourceStatus {
	provider: "photon" | "overpass";
	status: "ok" | "error";
	endpoint: string;
	error?: string;
}

export interface MapResult<T = RealPlace> {
	data: T[];
	sources: MapSourceStatus[];
}

export interface GeocodeRequest {
	query: string;
	limit?: number;
	center?: MapCoordinate;
	language?: "zh" | "en";
}

export interface NearbyRequest {
	center: MapCoordinate;
	category: MapCategory;
	radiusMeters?: number;
	limit?: number;
}

export interface ReverseRequest {
	point: MapCoordinate;
	language?: "zh" | "en";
}

export interface MapViewUpdate {
	action: "search" | "nearby" | "reverse";
	query?: string;
	center?: MapCoordinate;
	category?: MapCategory;
	radiusMeters?: number;
	result: MapResult<RealPlace>;
}

export interface MapResultsMessage {
	type: "map.results";
	sessionId: string;
	update: MapViewUpdate;
}
