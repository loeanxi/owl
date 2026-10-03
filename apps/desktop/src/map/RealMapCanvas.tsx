import * as L from "leaflet";
import { type JSX, useEffect, useRef, useState } from "react";
import type { MapCoordinate, RealPlace } from "../bridge/protocol.ts";
import type { DeviceLocationState } from "./device-location.ts";
import { MapIcon } from "./Icons.tsx";
import "leaflet/dist/leaflet.css";
import "./real-map-canvas.css";

export interface RealMapLabels {
	mapLabel: string;
	zoomIn: string;
	zoomOut: string;
	resetMap: string;
	locate: string;
	locating: string;
	searchHere: string;
	searching: string;
	tilesLoading: string;
	tilesError: string;
	retry: string;
	locationDenied: string;
	locationUnavailable: string;
	locationTimeout: string;
	locationNoGps: string;
	searchCenter: string;
}

export interface RealMapCanvasProps {
	active: boolean;
	center: MapCoordinate;
	places: readonly RealPlace[];
	selectedId?: string;
	detailOpen: boolean;
	loading?: boolean;
	locationState: DeviceLocationState;
	labels: RealMapLabels;
	onPlaceSelect: (id: string) => void;
	onCenterChange: (point: MapCoordinate) => void;
	onPointSelect?: (point: MapCoordinate) => void;
	onSearchHere: (point: MapCoordinate) => void;
	onLocate: () => void;
	onError?: (message: string) => void;
}

const INITIAL_ZOOM = 14;
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
	'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

export function RealMapCanvas(props: RealMapCanvasProps): JSX.Element {
	const propsRef = useRef(props);
	propsRef.current = props;
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const tileRef = useRef<L.TileLayer | null>(null);
	const resizeRef = useRef<ResizeObserver | null>(null);
	const failedTiles = useRef(0);
	const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
	const [initializationAttempt, setInitializationAttempt] = useState(0);
	const [initializationFailed, setInitializationFailed] = useState(false);
	const [tileFailed, setTileFailed] = useState(false);
	const [tileLoading, setTileLoading] = useState(true);
	const locationBusy = props.locationState.phase === "pending";
	const locationError = props.locationState.error;
	const [zoom, setZoom] = useState(INITIAL_ZOOM);

	useEffect(() => {
		return () => {
			resizeRef.current?.disconnect();
			resizeRef.current = null;
			tileRef.current?.off();
			tileRef.current = null;
			mapRef.current?.off();
			mapRef.current?.remove();
			mapRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!props.active || mapRef.current || !containerRef.current) return;
		setInitializationFailed(false);
		setTileFailed(false);
		setTileLoading(true);
		failedTiles.current = 0;
		let createdMap: L.Map | undefined;
		try {
			const initialCenter = propsRef.current.center;
			createdMap = L.map(containerRef.current, {
				center: [initialCenter.lat, initialCenter.lng],
				zoom: INITIAL_ZOOM,
				minZoom: 2,
				maxZoom: 19,
				zoomControl: false,
				attributionControl: true,
				scrollWheelZoom: true,
				touchZoom: true,
				keyboard: true,
				zoomAnimation: false,
				fadeAnimation: false,
				markerZoomAnimation: false,
			});
			const map = createdMap;
			mapRef.current = map;
			map.attributionControl.setPosition("bottomright");
			map.attributionControl.setPrefix(false);
			const tiles = L.tileLayer(TILE_URL, {
				attribution: TILE_ATTRIBUTION,
				maxZoom: 19,
				maxNativeZoom: 19,
				keepBuffer: 1,
				updateWhenIdle: true,
				referrerPolicy: "strict-origin-when-cross-origin",
			});
			tileRef.current = tiles;
			tiles.on("loading", () => {
				failedTiles.current = 0;
				setTileLoading(true);
			});
			tiles.on("tileerror", () => {
				failedTiles.current++;
				setTileFailed(true);
				if (failedTiles.current === 1) propsRef.current.onError?.(propsRef.current.labels.tilesError);
			});
			tiles.on("load", () => {
				setTileLoading(false);
				setTileFailed(failedTiles.current > 0);
			});
			map.on("moveend", () => {
				if (!propsRef.current.active) return;
				const point = map.getCenter();
				propsRef.current.onCenterChange({ lat: point.lat, lng: point.lng });
			});
			map.on("zoomend", () => setZoom(map.getZoom()));
			map.on("click", (event: L.LeafletMouseEvent) => {
				if (!propsRef.current.active) return;
				propsRef.current.onPointSelect?.({ lat: event.latlng.lat, lng: event.latlng.lng });
			});
			tiles.addTo(map);
			const resize = new ResizeObserver(() => {
				if (!propsRef.current.active || !containerRef.current?.clientWidth || !containerRef.current.clientHeight)
					return;
				const preservedCenter = map.getCenter();
				map.invalidateSize({ pan: false, debounceMoveend: true });
				map.setView(preservedCenter, map.getZoom(), { animate: false });
			});
			resize.observe(containerRef.current);
			resizeRef.current = resize;
			setMapInstance(map);
		} catch {
			resizeRef.current?.disconnect();
			resizeRef.current = null;
			tileRef.current?.off();
			createdMap?.off();
			createdMap?.remove();
			mapRef.current = null;
			tileRef.current = null;
			setInitializationFailed(true);
			setTileLoading(false);
			propsRef.current.onError?.(propsRef.current.labels.tilesError);
		}
	}, [props.active, initializationAttempt]);

	useEffect(() => {
		if (!props.active) return;
		const map = mapRef.current;
		if (!map || map !== mapInstance) return;
		const animationFrame = window.requestAnimationFrame(() => {
			if (!propsRef.current.active || !containerRef.current?.clientWidth) return;
			const preservedCenter = map.getCenter();
			map.invalidateSize({ pan: false, debounceMoveend: true });
			map.setView(preservedCenter, map.getZoom(), { animate: false });
			const selected = propsRef.current.places.find((place) => place.id === propsRef.current.selectedId);
			if (selected)
				map.panInside([selected.lat, selected.lng], {
					paddingTopLeft: L.point(35, 78),
					paddingBottomRight: L.point(35, 70),
					animate: false,
				});
		});
		return () => window.cancelAnimationFrame(animationFrame);
	}, [props.active, props.detailOpen, mapInstance]);

	useEffect(() => {
		const map = mapRef.current;
		if (!map || map !== mapInstance) return;
		const current = map.getCenter();
		if (Math.abs(current.lat - props.center.lat) > 0.000001 || Math.abs(current.lng - props.center.lng) > 0.000001)
			map.setView([props.center.lat, props.center.lng], map.getZoom(), { animate: false });
	}, [props.center.lat, props.center.lng, mapInstance]);

	useEffect(() => {
		const map = mapRef.current;
		if (!map || map !== mapInstance) return;
		const group = L.layerGroup().addTo(map);
		for (const [index, place] of props.places.entries()) {
			if (
				!Number.isFinite(place.lat) ||
				!Number.isFinite(place.lng) ||
				Math.abs(place.lat) > 90 ||
				Math.abs(place.lng) > 180
			)
				continue;
			const selected = props.selectedId === place.id;
			const markerContent = document.createElement("span");
			markerContent.className = "real-map-marker-number";
			markerContent.textContent = String(index + 1);
			const icon = L.divIcon({
				html: markerContent,
				className: `owl-real-map-marker${selected ? " is-selected" : ""}`,
				iconSize: [30, 30],
				iconAnchor: [15, 15],
			});
			const marker = L.marker([place.lat, place.lng], {
				icon,
				title: place.name,
				alt: place.name,
				keyboard: true,
				bubblingMouseEvents: false,
				zIndexOffset: selected ? 1000 : 0,
			});
			const tooltipContent = document.createElement("span");
			tooltipContent.textContent = place.name;
			marker.bindTooltip(tooltipContent, {
				permanent: selected,
				direction: "top",
				offset: L.point(0, -17),
				className: "owl-real-map-tooltip",
			});
			marker.on("click", () => propsRef.current.onPlaceSelect(place.id));
			marker.addTo(group);
			marker.getElement()?.setAttribute("aria-label", place.name);
		}
		return () => {
			group.clearLayers();
			group.remove();
		};
	}, [props.places, props.selectedId, mapInstance]);

	useEffect(() => {
		const map = mapRef.current;
		if (!map || map !== mapInstance) return;
		const content = document.createElement("span");
		content.textContent = props.labels.searchCenter;
		const marker = L.circleMarker([props.center.lat, props.center.lng], {
			radius: 6,
			color: "#e0f3df",
			weight: 2,
			fillColor: "#2f9e5a",
			fillOpacity: 1,
			interactive: false,
			className: "owl-real-map-center",
		}).addTo(map);
		marker.bindTooltip(content, {
			permanent: true,
			direction: "bottom",
			offset: L.point(0, 8),
			className: "owl-real-map-center-tooltip",
		});
		return () => {
			marker.remove();
		};
	}, [props.center.lat, props.center.lng, props.labels.searchCenter, mapInstance]);

	useEffect(() => {
		const map = mapRef.current;
		if (!props.active || !map || map !== mapInstance) return;
		const selected = props.places.find((place) => place.id === props.selectedId);
		if (selected)
			map.panInside([selected.lat, selected.lng], {
				paddingTopLeft: L.point(35, 78),
				paddingBottomRight: L.point(35, 70),
				animate: false,
			});
	}, [props.selectedId, props.places, props.active, mapInstance]);

	const labels = props.labels;
	return (
		<section className={`owl-real-map-canvas${props.detailOpen ? " has-detail" : ""}`} aria-label={labels.mapLabel}>
			<div className="owl-real-map-viewport" ref={containerRef} />
			<div className="real-map-search-control">
				<button
					type="button"
					className="real-map-search-here"
					disabled={!props.active || !mapInstance || Boolean(props.loading)}
					onClick={() => {
						const point = mapRef.current?.getCenter();
						if (point) props.onSearchHere({ lat: point.lat, lng: point.lng });
					}}
				>
					<MapIcon name="search" />
					{props.loading ? labels.searching : labels.searchHere}
				</button>
			</div>
			<div className="real-map-tools">
				<div className="real-map-tool-group">
					<button
						type="button"
						aria-label={labels.zoomIn}
						title={labels.zoomIn}
						disabled={!props.active || !mapInstance || zoom >= 19}
						onClick={() => mapRef.current?.zoomIn()}
					>
						<MapIcon name="plus" />
					</button>
					<button
						type="button"
						aria-label={labels.zoomOut}
						title={labels.zoomOut}
						disabled={!props.active || !mapInstance || zoom <= 2}
						onClick={() => mapRef.current?.zoomOut()}
					>
						<span className="real-map-minus" aria-hidden="true">
							−
						</span>
					</button>
				</div>
				<div className="real-map-tool-group">
					<button
						type="button"
						aria-label={labels.resetMap}
						title={labels.resetMap}
						disabled={!props.active || !mapInstance}
						onClick={() => mapRef.current?.setView([props.center.lat, props.center.lng], INITIAL_ZOOM)}
					>
						<MapIcon name="compass" />
					</button>
					<button
						type="button"
						aria-label={locationBusy ? labels.locating : labels.locate}
						title={locationBusy ? labels.locating : labels.locate}
						disabled={!props.active || !mapInstance || locationBusy}
						onClick={props.onLocate}
						className={locationBusy ? "is-locating" : undefined}
					>
						<MapIcon name="target" />
					</button>
				</div>
			</div>
			{(initializationFailed || tileFailed) && (
				<div className="real-map-error" role="alert">
					<MapIcon name="info" />
					<span>{labels.tilesError}</span>
					<button
						type="button"
						disabled={!props.active}
						onClick={() => {
							setTileFailed(false);
							failedTiles.current = 0;
							setTileLoading(true);
							if (initializationFailed) setInitializationAttempt((value) => value + 1);
							else tileRef.current?.redraw();
						}}
					>
						{labels.retry}
					</button>
				</div>
			)}
			{locationError && (
				<div className="real-map-location-error" role="alert">
					<MapIcon name="info" />
					<span>{labels[locationError]}</span>
					<button
						type="button"
						aria-label={labels.retry}
						onClick={props.onLocate}
						disabled={locationBusy || !props.active}
					>
						{labels.retry}
					</button>
				</div>
			)}
			{(tileLoading || locationBusy) && !initializationFailed && !tileFailed && (
				<output className="real-map-loading" aria-live="polite">
					<span className="real-map-loading-dot" aria-hidden="true" />
					{locationBusy ? labels.locating : labels.tilesLoading}
				</output>
			)}
		</section>
	);
}
