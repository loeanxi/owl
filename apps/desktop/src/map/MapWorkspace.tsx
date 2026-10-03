import { invoke } from "@tauri-apps/api/core";
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { hasTauri } from "../bridge/native.ts";
import type {
	ApprovalMode,
	MapCategory,
	MapCoordinate,
	MapResult,
	MapSourceStatus,
	QuestionAnswerPayload,
	QuestionRequest,
	RealPlace,
} from "../bridge/protocol.ts";
import { QuestionDialog } from "../components/QuestionDialog.tsx";
import { MapConversation, type MapConversationContext } from "./conversation.ts";
import { type MapCopyKey, useMapCopy } from "./copy.ts";
import { type DeviceLocation, DeviceLocator } from "./device-location.ts";
import { MapIcon, type MapIconName } from "./Icons.tsx";
import {
	addLiveHistory,
	type ConfiguredMapLocation,
	DEFAULT_CONFIGURED_LOCATION,
	type LiveSavedState,
	type LiveSearchRecord,
	MAX_LIVE_COMPARISON,
	mapDirectionsUrl,
	nearbyCategoryFromMessage,
	normalizeConfiguredLocation,
	normalizeRealPlace,
	parseCoordinates,
	RealMapClient,
	readLiveSavedState,
	safeExternalUrl,
	straightLineDistance,
	toggleLiveCompare,
	toggleLiveFavorite,
	writeLiveSavedState,
} from "./live-model.ts";
import { RealMapCanvas, type RealMapLabels } from "./RealMapCanvas.tsx";
import "./map-workspace.css";

type MapView = "home" | "results" | "saved";
const categories: readonly MapCategory[] = ["all", "cafe", "restaurant", "park", "museum"];
const categoryLabels: Record<RealPlace["category"] | "all", MapCopyKey> = {
	all: "categoryAll",
	cafe: "categoryCafe",
	restaurant: "categoryRestaurant",
	park: "categoryPark",
	museum: "categoryMuseum",
	other: "categoryOther",
};
const categoryIcons: Record<RealPlace["category"] | "all", MapIconName> = {
	all: "compass",
	cafe: "coffee",
	restaurant: "coffee",
	park: "tree",
	museum: "museum",
	other: "pin",
};

export function MapWorkspace({
	sidebarCollapsed = false,
	active = true,
	client,
	connected,
	cwd,
	model,
	modelName,
	thinkingLevel,
	approvalMode,
	questions,
	onAnswerQuestion,
}: {
	sidebarCollapsed?: boolean;
	active?: boolean;
	client: BridgeClient;
	connected: boolean;
	cwd: string;
	model: string;
	modelName?: string;
	thinkingLevel: string;
	approvalMode: ApprovalMode;
	questions: readonly QuestionRequest[];
	onAnswerQuestion: (requestId: string, answers: QuestionAnswerPayload[], cancelled: boolean) => void;
}): JSX.Element {
	const copy = useMapCopy();
	const m = copy.text;
	const modelSeparator = model.indexOf("/");
	const provider = modelSeparator > 0 ? model.slice(0, modelSeparator) : undefined;
	const modelId = modelSeparator > 0 ? model.slice(modelSeparator + 1) : model;
	const conversation = useMemo(
		() =>
			new MapConversation(
				client,
				{ cwd, provider, model: modelId || undefined, thinkingLevel, approvalMode },
				connected,
			),
		[client],
	);
	const conversationState = useSyncExternalStore(conversation.subscribe, conversation.getState, conversation.getState);
	const deviceLocator = useMemo(
		() => new DeviceLocator({ readGps: hasTauri() ? () => invoke<unknown>("gps_location") : undefined }),
		[],
	);
	const deviceLocationState = useSyncExternalStore(
		deviceLocator.subscribe,
		deviceLocator.getState,
		deviceLocator.getState,
	);
	const activeRef = useRef(active);
	activeRef.current = active;
	const applyDeviceLocationRef = useRef<(location: DeviceLocation) => void>(() => {});
	const mapQuestions = questions.filter((question) => question.sessionId === conversationState.sessionId);
	const activeMapQuestion = mapQuestions[0];
	const mapQuestionDockRef = useRef<HTMLDivElement>(null);
	const maps = useMemo(() => new RealMapClient(), []);
	const [savedState, setSavedState] = useState<LiveSavedState>(() => {
		try {
			return readLiveSavedState(window.localStorage);
		} catch {
			return { favorites: [], history: [], configuredLocation: { ...DEFAULT_CONFIGURED_LOCATION } };
		}
	});
	const configuredLocation = savedState.configuredLocation ?? DEFAULT_CONFIGURED_LOCATION;
	const [center, setCenter] = useState<MapCoordinate>(() => ({
		lat: configuredLocation.lat,
		lng: configuredLocation.lng,
	}));
	const [locationName, setLocationName] = useState(() => configuredLocation.name);
	const [category, setCategory] = useState<MapCategory>("all");
	const [radius, setRadius] = useState(2000);
	const [places, setPlaces] = useState<RealPlace[]>([]);
	const [sources, setSources] = useState<MapSourceStatus[]>([]);
	const [view, setView] = useState<MapView>("home");
	const [resultKind, setResultKind] = useState<"search" | "nearby">("search");
	const [resultQuery, setResultQuery] = useState("");
	const [sort, setSort] = useState<"distance" | "name">("distance");
	const [mapLoading, setMapLoading] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [mapError, setMapError] = useState<string>();
	const [centerChanged, setCenterChanged] = useState(false);
	const [selectedId, setSelectedId] = useState<string>();
	const [detailId, setDetailId] = useState<string>();
	const [comparisonPlaces, setComparisonPlaces] = useState<RealPlace[]>([]);
	const [comparisonOpen, setComparisonOpen] = useState(false);
	const [locationOpen, setLocationOpen] = useState(false);
	const [locationInput, setLocationInput] = useState("");
	const [locationCandidates, setLocationCandidates] = useState<RealPlace[]>([]);
	const [positionSettingsOpen, setPositionSettingsOpen] = useState(false);
	const [settingsInput, setSettingsInput] = useState("");
	const [settingsDraft, setSettingsDraft] = useState<ConfiguredMapLocation>();
	const [settingsCandidates, setSettingsCandidates] = useState<RealPlace[]>([]);
	const [settingsBusy, setSettingsBusy] = useState(false);
	const [settingsError, setSettingsError] = useState<string>();
	const positionSettingsRef = useRef<HTMLDialogElement>(null);
	const positionSettingsButtonRef = useRef<HTMLButtonElement>(null);
	const positionSettingsInputRef = useRef<HTMLInputElement>(null);
	const settingsAbort = useRef<AbortController | undefined>(undefined);
	const settingsEpoch = useRef(0);
	const initialPositionApplied = useRef(false);
	const [homeInput, setHomeInput] = useState("");
	const [sideInput, setSideInput] = useState("");
	const [followInput, setFollowInput] = useState("");
	const [followContext, setFollowContext] = useState<RealPlace>();
	const [stopped, setStopped] = useState(false);
	const [aborting, setAborting] = useState(false);
	const [preparingMessage, setPreparingMessage] = useState(false);
	const [conversationError, setConversationError] = useState<string>();
	const [toast, setToast] = useState("");
	const workspaceRef = useRef<HTMLDivElement>(null);
	const panelScrollRef = useRef<HTMLDivElement>(null);
	const followInputRef = useRef<HTMLInputElement>(null);
	const locationRef = useRef<HTMLDivElement>(null);
	const locationTriggerRef = useRef<HTMLButtonElement>(null);
	const locationInputRef = useRef<HTMLInputElement>(null);
	const detailCloseRef = useRef<HTMLButtonElement>(null);
	const comparisonRef = useRef<HTMLElement>(null);
	const comparisonCloseRef = useRef<HTMLButtonElement>(null);
	const newExploreRef = useRef<HTMLButtonElement>(null);
	const detailReturnRef = useRef<HTMLElement | null>(null);
	const comparisonReturnRef = useRef<HTMLElement | null>(null);
	const cardRefs = useRef(new Map<string, HTMLElement>());
	const conversationScrollRef = useRef<HTMLDivElement>(null);
	const conversationPinned = useRef(true);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const storageInitialized = useRef(false);
	const queryAbort = useRef<AbortController | undefined>(undefined);
	const queryEpoch = useRef(0);
	const lastLookup = useRef<
		| {
				action: "search" | "nearby" | "reverse";
				query?: string;
				point?: MapCoordinate;
				category?: MapCategory;
				radius?: number;
				locationPanel?: boolean;
				searchNearby?: boolean;
		  }
		| undefined
	>(undefined);
	const sendEpoch = useRef(0);
	const sendPending = useRef(false);
	const pendingMessage = useRef("");
	const lastModelMapUpdate = useRef<{ controller: MapConversation; revision: number } | undefined>(undefined);
	const centerRef = useRef(center);
	centerRef.current = center;
	const busy = conversationState.busy || preparingMessage;
	const unavailable = !connected ? m("chatDisconnected") : undefined;
	const sendDisabled = !active || Boolean(unavailable) || busy;
	const displayedModel = modelName || modelId || m("defaultModel");
	const rows = [...(view === "saved" ? savedState.favorites : places)].sort((a, b) =>
		sort === "name"
			? a.name.localeCompare(b.name, copy.language)
			: straightLineDistance(center, a) - straightLineDistance(center, b),
	);
	const selectedPlace = rows.find((place) => place.id === selectedId);
	const detailPlace = rows.find((place) => place.id === detailId);
	const hasDetail = Boolean(detailPlace);
	const centerLabel = locationName || m("mapCenter");
	const partialResults =
		sources.some((source) => source.status === "error") &&
		sources.some((source) => source.status === "ok") &&
		rows.length > 0;
	const labels: RealMapLabels = {
		mapLabel: m("mapLabel"),
		zoomIn: m("zoomIn"),
		zoomOut: m("zoomOut"),
		resetMap: m("resetMap"),
		locate: m("locate"),
		locating: m("locating"),
		searchHere: m("searchHere"),
		searching: m("searching"),
		tilesLoading: m("tilesLoading"),
		tilesError: m("tilesError"),
		retry: m("retry"),
		locationDenied: m("locationDenied"),
		locationUnavailable: m("locationUnavailable"),
		locationTimeout: m("locationTimeout"),
		locationNoGps: m("locationNoGps"),
		searchCenter: m("searchCenter"),
	};
	applyDeviceLocationRef.current = (location) => {
		centerOn(location, m("myLocation"));
		setView("results");
		void nearbyPlaces(location, category, radius, m("myLocation"));
	};
	useEffect(() => {
		if (!active) {
			deviceLocator.cancel();
			return;
		}
		const frame = requestAnimationFrame(() => {
			if (initialPositionApplied.current) return;
			initialPositionApplied.current = true;
			deviceLocator.cancel(true);
			centerOn(configuredLocation, configuredLocation.name);
			void nearbyPlaces(configuredLocation, category, radius, configuredLocation.name);
		});
		return () => {
			cancelAnimationFrame(frame);
			deviceLocator.cancel();
		};
	}, [active, deviceLocator]);
	useEffect(() => {
		const dialog = positionSettingsRef.current;
		if (!active && positionSettingsOpen) {
			closePositionSettings();
			return;
		}
		if (!dialog || !positionSettingsOpen || !active) return;
		dialog.showModal();
		positionSettingsInputRef.current?.focus();
		return () => {
			settingsEpoch.current++;
			settingsAbort.current?.abort();
			dialog.close();
		};
	}, [active, positionSettingsOpen]);

	useEffect(() => {
		sendEpoch.current++;
		sendPending.current = false;
		setPreparingMessage(false);
	}, [conversation, cwd]);
	useEffect(() => {
		conversation.setConfig({ cwd, provider, model: modelId || undefined, thinkingLevel, approvalMode });
	}, [conversation, cwd, provider, modelId, thinkingLevel, approvalMode]);
	useEffect(() => {
		conversation.setConnected(connected);
	}, [conversation, connected]);
	useEffect(() => {
		if (!active || !activeMapQuestion) return;
		setView((current) => (current === "home" ? "results" : current));
		setDetailId(undefined);
		setComparisonOpen(false);
		setLocationOpen(false);
		const frame = requestAnimationFrame(() => {
			mapQuestionDockRef.current
				?.querySelector<HTMLElement>(
					".map-question-column:not([hidden]) [role='radio'], .map-question-column:not([hidden]) [role='checkbox'], .map-question-column:not([hidden]) input, .map-question-column:not([hidden]) button",
				)
				?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, activeMapQuestion?.requestId]);
	useEffect(() => {
		const frame = conversationState.mapUpdate;
		if (
			!frame ||
			(lastModelMapUpdate.current?.controller === conversation &&
				lastModelMapUpdate.current.revision >= frame.revision)
		)
			return;
		lastModelMapUpdate.current = { controller: conversation, revision: frame.revision };
		queryEpoch.current++;
		queryAbort.current?.abort();
		setMapLoading(false);
		const update = frame.update;
		if (!update.result.sources.some((source) => source.status === "ok")) {
			setSources(update.result.sources);
			setMapError(update.result.sources.find((source) => source.error)?.error || m("mapUnavailable"));
			return;
		}
		const data = update.result.data.map(normalizeRealPlace).filter((place): place is RealPlace => Boolean(place));
		const nextCenter = update.center ?? (update.action !== "nearby" ? data[0] : undefined) ?? centerRef.current;
		const nextName =
			update.action !== "nearby" && data[0]
				? placeName(data[0])
				: straightLineDistance(nextCenter, centerRef.current) > 100
					? pointLabel(nextCenter)
					: centerLabel;
		const nextCategory = update.category ?? category;
		const nextRadius = update.radiusMeters ?? radius;
		deviceLocator.cancel(true);
		centerOn(nextCenter, nextName);
		setCategory(nextCategory);
		setRadius(nextRadius);
		setMapError(undefined);
		setHasSearched(true);
		setFollowContext(undefined);
		setLocationOpen(false);
		setLocationCandidates(update.action === "search" ? data : []);
		applyResult(
			{ data, sources: update.result.sources },
			update.query || (update.action === "reverse" ? pointLabel(nextCenter) : ""),
			update.action === "nearby" ? "nearby" : "search",
		);
		setSelectedId(update.action === "nearby" ? undefined : data[0]?.id);
		recordSearch(
			update.query || (update.action === "nearby" ? m(categoryLabels[nextCategory]) : pointLabel(nextCenter)),
			nextCenter,
			nextName,
			update.action === "nearby" ? "nearby" : "search",
			nextCategory,
			nextRadius,
		);
	}, [conversation, conversationState.mapUpdate]);
	useEffect(() => {
		if (active && conversationPinned.current && conversationScrollRef.current)
			conversationScrollRef.current.scrollTop = conversationScrollRef.current.scrollHeight;
	}, [active, conversationState.entries, conversationState.busy]);
	useEffect(
		() => () => {
			clearTimeout(toastTimer.current);
			queryAbort.current?.abort();
			queryEpoch.current++;
			sendEpoch.current++;
		},
		[],
	);
	useEffect(() => {
		if (!storageInitialized.current) {
			storageInitialized.current = true;
			return;
		}
		try {
			if (!writeLiveSavedState(window.localStorage, savedState)) showToast(m("storageUnavailable"));
		} catch {
			showToast(m("storageUnavailable"));
		}
	}, [savedState]);
	useEffect(() => {
		if (!active) return;
		if (comparisonOpen) comparisonCloseRef.current?.focus();
		else if (detailId) detailCloseRef.current?.focus();
		else if (locationOpen) locationInputRef.current?.focus();
	}, [active, comparisonOpen, detailId, locationOpen]);
	useEffect(() => {
		if (!active) return;
		function handleKey(event: KeyboardEvent): void {
			if (event.key === "Escape") {
				if (comparisonOpen) {
					event.preventDefault();
					closeComparison();
				} else if (detailId) {
					event.preventDefault();
					closeDetail();
				} else if (locationOpen) {
					event.preventDefault();
					setLocationOpen(false);
					locationTriggerRef.current?.focus();
				}
			} else if (event.key === "Tab" && comparisonOpen && comparisonRef.current) {
				const elements = Array.from(
					comparisonRef.current.querySelectorAll<HTMLElement>(
						"button:not(:disabled), input, select, textarea, a[href], [tabindex='0']",
					),
				).filter((el) => el.getClientRects().length > 0);
				const first = elements[0],
					last = elements[elements.length - 1];
				if (
					event.shiftKey &&
					(document.activeElement === first || !comparisonRef.current.contains(document.activeElement))
				) {
					event.preventDefault();
					last?.focus();
				} else if (
					!event.shiftKey &&
					(document.activeElement === last || !comparisonRef.current.contains(document.activeElement))
				) {
					event.preventDefault();
					first?.focus();
				}
			}
		}
		function handlePointer(event: PointerEvent): void {
			if (!(event.target instanceof Node)) return;
			if (
				comparisonOpen &&
				workspaceRef.current?.contains(event.target) &&
				!comparisonRef.current?.contains(event.target)
			)
				closeComparison();
			if (locationOpen && !locationRef.current?.contains(event.target)) setLocationOpen(false);
		}
		document.addEventListener("keydown", handleKey);
		document.addEventListener("pointerdown", handlePointer);
		return () => {
			document.removeEventListener("keydown", handleKey);
			document.removeEventListener("pointerdown", handlePointer);
		};
	}, [active, comparisonOpen, detailId, locationOpen]);

	function showToast(message: string): void {
		setToast(message);
		clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(""), 4000);
	}
	function restoreFocus(target: HTMLElement | null): void {
		requestAnimationFrame(() => {
			if (!active) return;
			if (target?.isConnected && target.getClientRects().length) target.focus();
			else newExploreRef.current?.focus();
		});
	}
	function closeDetail(): void {
		setDetailId(undefined);
		restoreFocus(detailReturnRef.current);
	}
	function closeComparison(): void {
		setComparisonOpen(false);
		restoreFocus(comparisonReturnRef.current);
	}
	function pointLabel(point: MapCoordinate): string {
		return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
	}
	function placeName(place: RealPlace): string {
		return place.name || m("unknownName");
	}
	function distance(place: RealPlace): string {
		const value = straightLineDistance(center, place);
		return value < 1000
			? m("distanceMeters", { n: Math.round(value) })
			: m("distanceKm", { n: Number((value / 1000).toFixed(1)) });
	}
	function fetched(place: RealPlace): string {
		const date = new Date(place.source.fetchedAt);
		return Number.isNaN(date.getTime())
			? m("notProvided")
			: new Intl.DateTimeFormat(copy.language === "en" ? "en" : "zh-CN", {
					timeZone: "Asia/Taipei",
					dateStyle: "short",
					timeStyle: "short",
				}).format(date);
	}
	function centerOn(point: MapCoordinate, name: string): void {
		const coordinate = { lat: point.lat, lng: point.lng };
		// An earlier place selection must not pan the renderer back while a new area's results load.
		setSelectedId(undefined);
		centerRef.current = coordinate;
		setCenter(coordinate);
		setLocationName(name);
		setCenterChanged(false);
		setDetailId(undefined);
		setSavedState((current) => ({ ...current, lastCenter: coordinate, lastLocationName: name }));
	}
	function locateDevice(automatic = false): void {
		void deviceLocator.request(automatic).then((location) => {
			if (location && activeRef.current) applyDeviceLocationRef.current(location);
		});
	}
	function openPositionSettings(): void {
		deviceLocator.cancel(true);
		setComparisonOpen(false);
		setDetailId(undefined);
		setLocationOpen(false);
		setSettingsInput(configuredLocation.name);
		setSettingsDraft({ ...configuredLocation });
		setSettingsCandidates([]);
		setSettingsError(undefined);
		setSettingsBusy(false);
		setPositionSettingsOpen(true);
	}
	function closePositionSettings(): void {
		settingsEpoch.current++;
		settingsAbort.current?.abort();
		positionSettingsRef.current?.close();
		setSettingsBusy(false);
		setPositionSettingsOpen(false);
		positionSettingsButtonRef.current?.focus();
	}
	async function searchConfiguredLocation(): Promise<void> {
		const query = settingsInput.trim();
		if (!query) return;
		settingsAbort.current?.abort();
		const controller = new AbortController();
		settingsAbort.current = controller;
		const epoch = ++settingsEpoch.current;
		setSettingsError(undefined);
		setSettingsCandidates([]);
		setSettingsDraft(undefined);
		const point = parseCoordinates(query);
		if (point) {
			setSettingsDraft({
				...point,
				name: query,
				source: "user",
				precision: "point",
				updatedAt: new Date().toISOString(),
			});
			return;
		}
		if (/^[+-]?\d+(?:\.\d+)?\s*[,，;]\s*[+-]?\d/.test(query)) {
			setSettingsError(m("coordinateInvalid"));
			return;
		}
		setSettingsBusy(true);
		try {
			const result = await maps.search(query, copy.language, controller.signal);
			if (epoch !== settingsEpoch.current) return;
			if (!result.sources.some((source) => source.status === "ok"))
				throw new Error(result.sources.find((source) => source.error)?.error || m("mapUnavailable"));
			setSettingsCandidates(result.data);
			if (!result.data.length) setSettingsError(m("noResultsHint"));
		} catch (error) {
			if (epoch === settingsEpoch.current && !controller.signal.aborted)
				setSettingsError(error instanceof Error ? error.message : m("mapUnavailable"));
		} finally {
			if (epoch === settingsEpoch.current) setSettingsBusy(false);
		}
	}
	function saveConfiguredLocation(): void {
		const next = normalizeConfiguredLocation({ ...settingsDraft, updatedAt: new Date().toISOString() });
		if (!next || settingsBusy) return;
		const nextSaved = {
			...savedState,
			configuredLocation: next,
			lastCenter: { lat: next.lat, lng: next.lng },
			lastLocationName: next.name,
		};
		if (!writeLiveSavedState(window.localStorage, nextSaved)) {
			setSettingsError(m("storageUnavailable"));
			return;
		}
		deviceLocator.cancel(true);
		setSavedState(nextSaved);
		centerOn(next, next.name);
		closePositionSettings();
		showToast(m("positionSaved"));
		void nearbyPlaces(next, category, radius, next.name);
	}
	function beginQuery(): { epoch: number; signal: AbortSignal } {
		queryAbort.current?.abort();
		const controller = new AbortController();
		queryAbort.current = controller;
		const epoch = ++queryEpoch.current;
		setMapLoading(true);
		setHasSearched(true);
		if (view === "home") setView("results");
		setMapError(undefined);
		setSources([]);
		setDetailId(undefined);
		setFollowContext(undefined);
		return { epoch, signal: controller.signal };
	}
	function applyResult(
		result: MapResult<RealPlace>,
		query: string,
		kind: "search" | "nearby",
		origin?: MapCoordinate,
	): boolean {
		setSources(result.sources);
		if (!result.sources.some((source) => source.status === "ok")) {
			setMapError(result.sources.find((source) => source.status === "error")?.error || m("mapUnavailable"));
			return false;
		}
		setMapError(undefined);
		setPlaces(result.data);
		setSelectedId(undefined);
		setResultKind(kind);
		setResultQuery(query);
		setView("results");
		setCenterChanged(origin ? straightLineDistance(origin, centerRef.current) > 1 : false);
		requestAnimationFrame(() => {
			if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
		});
		return true;
	}
	function recordSearch(
		query: string,
		point: MapCoordinate,
		name: string,
		kind: "search" | "nearby",
		selectedCategory = category,
		selectedRadius = radius,
	): void {
		const entry: LiveSearchRecord = {
			id: crypto.randomUUID(),
			query,
			center: { lat: point.lat, lng: point.lng },
			locationName: name,
			category: selectedCategory,
			radiusMeters: selectedRadius,
			kind,
			createdAt: new Date().toISOString(),
		};
		setSavedState((current) => ({
			...current,
			history: addLiveHistory(current.history, entry),
			lastCenter: point,
			lastLocationName: name,
		}));
	}
	async function searchPlaces(raw: string, inLocationPanel = false): Promise<void> {
		const query = raw.trim();
		if (!query) return;
		deviceLocator.cancel(true);
		const point = parseCoordinates(query);
		if (point) {
			if (await selectCoordinate(point)) {
				setLocationOpen(false);
				setSideInput("");
			}
			return;
		}
		if (/^[+-]?\d+(?:\.\d+)?\s*[,，;]\s*[+-]?\d/.test(query)) {
			setMapError(m("coordinateInvalid"));
			return;
		}
		lastLookup.current = { action: "search", query, locationPanel: inLocationPanel };
		const request = beginQuery();
		try {
			const result = await maps.search(query, copy.language, request.signal);
			if (request.epoch !== queryEpoch.current) return;
			if (!applyResult(result, query, "search")) return;
			setLocationCandidates(result.data);
			const first = result.data[0];
			if (first && !inLocationPanel) {
				centerOn(first, placeName(first));
				setSelectedId(first.id);
			}
			recordSearch(query, first ?? centerRef.current, first ? placeName(first) : centerLabel, "search");
			if (!inLocationPanel) {
				setLocationOpen(false);
				setSideInput("");
			}
		} catch (error) {
			if (request.epoch === queryEpoch.current && !request.signal.aborted)
				setMapError(error instanceof Error ? error.message : m("mapUnavailable"));
		} finally {
			if (request.epoch === queryEpoch.current) setMapLoading(false);
		}
	}
	async function nearbyPlaces(
		point = centerRef.current,
		selectedCategory = category,
		selectedRadius = radius,
		locationLabel?: string,
	): Promise<MapResult<RealPlace> | undefined> {
		lastLookup.current = {
			action: "nearby",
			point: { ...point },
			category: selectedCategory,
			radius: selectedRadius,
		};
		const startingCenter = { ...centerRef.current };
		const lookupLocationName =
			locationLabel ??
			(straightLineDistance(point, startingCenter) > 100 ? pointLabel(point) : locationName || pointLabel(point));
		const request = beginQuery();
		setCategory(selectedCategory);
		setRadius(selectedRadius);
		try {
			const result = await maps.nearby(point, selectedCategory, selectedRadius, request.signal);
			if (request.epoch !== queryEpoch.current) return undefined;
			if (!applyResult(result, "", "nearby", point)) return undefined;
			if (straightLineDistance(startingCenter, centerRef.current) < 1) {
				centerRef.current = { lat: point.lat, lng: point.lng };
				setCenter(centerRef.current);
				setLocationName(lookupLocationName);
				setCenterChanged(false);
			}
			recordSearch(
				m(categoryLabels[selectedCategory]),
				point,
				lookupLocationName,
				"nearby",
				selectedCategory,
				selectedRadius,
			);
			return result;
		} catch (error) {
			if (request.epoch === queryEpoch.current && !request.signal.aborted)
				setMapError(error instanceof Error ? error.message : m("mapUnavailable"));
			return undefined;
		} finally {
			if (request.epoch === queryEpoch.current) setMapLoading(false);
		}
	}
	async function selectCoordinate(point: MapCoordinate, searchNearby = false): Promise<boolean> {
		deviceLocator.cancel(true);
		lastLookup.current = { action: "reverse", point: { ...point }, searchNearby };
		const request = beginQuery();
		const manual: RealPlace = {
			id: `user:${point.lat},${point.lng}`,
			...point,
			name: pointLabel(point),
			address: null,
			category: "other",
			distanceMeters: 0,
			openingHours: null,
			phone: null,
			website: null,
			wheelchair: null,
			internetAccess: null,
			rating: null,
			price: null,
			quiet: null,
			plug: null,
			tags: {},
			source: {
				provider: "user",
				url: `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=16/${point.lat}/${point.lng}`,
				fetchedAt: new Date().toISOString(),
			},
		};
		try {
			const result = await maps.reverse(point, copy.language, request.signal);
			if (request.epoch !== queryEpoch.current) return false;
			if (
				!applyResult(
					{ data: [manual, ...result.data.filter((place) => place.id !== manual.id)], sources: result.sources },
					pointLabel(point),
					"search",
				)
			)
				return false;
			const match = result.data[0];
			centerOn(point, match ? placeName(match) : pointLabel(point));
			setLocationCandidates([]);
			setSelectedId(manual.id);
			recordSearch(pointLabel(point), point, match ? placeName(match) : pointLabel(point), "search");
			return true;
		} catch (error) {
			if (request.epoch === queryEpoch.current && !request.signal.aborted)
				setMapError(error instanceof Error ? error.message : m("mapUnavailable"));
			return false;
		} finally {
			if (request.epoch === queryEpoch.current) {
				setMapLoading(false);
				if (searchNearby) void nearbyPlaces(point);
			}
		}
	}
	function retryLookup(): void {
		const request = lastLookup.current;
		if (!request) return;
		if (request.action === "search") void searchPlaces(request.query ?? "", request.locationPanel);
		else if (request.action === "nearby")
			void nearbyPlaces(request.point ?? centerRef.current, request.category ?? category, request.radius ?? radius);
		else if (request.point) void selectCoordinate(request.point, request.searchNearby);
	}
	function chooseLocation(place: RealPlace): void {
		deviceLocator.cancel(true);
		centerOn(place, placeName(place));
		setSelectedId(place.id);
		setLocationOpen(false);
		setLocationInput("");
		locationTriggerRef.current?.focus();
	}
	function movedCenter(point: MapCoordinate): void {
		// Leaflet aligns views to screen pixels; a few metres of rounding must not replace a chosen city name.
		if (straightLineDistance(point, centerRef.current) < 5) return;
		deviceLocator.cancel(true);
		centerRef.current = point;
		setCenter(point);
		setLocationName(pointLabel(point));
		setCenterChanged(true);
	}
	function replaySearch(entry: LiveSearchRecord): void {
		deviceLocator.cancel(true);
		centerOn(entry.center, entry.locationName);
		setCategory(entry.category);
		setRadius(entry.radiusMeters);
		if (entry.kind === "nearby") void nearbyPlaces(entry.center, entry.category, entry.radiusMeters);
		else void searchPlaces(entry.query);
	}
	async function submitQuery(text: string): Promise<void> {
		if (!text.trim()) {
			showToast(m("emptyQuery"));
			return;
		}
		if (unavailable || conversation.getState().busy || sendPending.current) return;
		const epoch = ++sendEpoch.current;
		sendPending.current = true;
		pendingMessage.current = text;
		setStopped(false);
		setConversationError(undefined);
		if (view === "home") setView("results");
		setDetailId(undefined);
		setLocationOpen(false);
		conversationPinned.current = true;
		let visiblePlaces = rows;
		let contextLocationName = centerLabel;
		const requestedCategory = nearbyCategoryFromMessage(text);
		try {
			if (requestedCategory) {
				setPreparingMessage(true);
				if (deviceLocator.getState().phase === "pending") {
					await deviceLocator.request();
					if (epoch !== sendEpoch.current) return;
				}
				const nearUser = /我(?:的)?(?:附近|周围|身边)|离我|near me|around me/i.test(text);
				if (nearUser) {
					deviceLocator.cancel(true);
					centerOn(configuredLocation, configuredLocation.name);
					contextLocationName = configuredLocation.name;
				}
				const result = await nearbyPlaces(
					nearUser ? configuredLocation : centerRef.current,
					requestedCategory,
					radius,
					nearUser ? configuredLocation.name : undefined,
				);
				if (epoch !== sendEpoch.current) return;
				visiblePlaces = result?.data ?? [];
			}
			const context: MapConversationContext = {
				center: { ...centerRef.current },
				locationName: contextLocationName,
				deviceLocation: deviceLocator.getState().location,
				userLocation: configuredLocation,
				radiusMeters: radius,
				category: requestedCategory ?? category,
				selectedPlace: followContext ?? (requestedCategory ? undefined : selectedPlace),
				visiblePlaces,
				comparisonPlaces,
			};
			requestAnimationFrame(() => {
				if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
				followInputRef.current?.focus();
			});
			const sent = await conversation.send(text, context);
			if (epoch !== sendEpoch.current) return;
			if (!sent) {
				setFollowInput(text);
				return;
			}
			setHomeInput((current) => (current === text ? "" : current));
			setFollowInput((current) => (current === text ? "" : current));
			pendingMessage.current = "";
		} catch (error) {
			if (epoch === sendEpoch.current) {
				setConversationError(error instanceof Error ? error.message : m("chatError"));
				setFollowInput(text);
			}
		} finally {
			if (epoch === sendEpoch.current) {
				sendPending.current = false;
				setPreparingMessage(false);
			}
		}
	}
	async function stopReply(): Promise<void> {
		if (aborting) return;
		setAborting(true);
		try {
			if (preparingMessage && !conversationState.busy) {
				sendEpoch.current++;
				sendPending.current = false;
				queryEpoch.current++;
				queryAbort.current?.abort();
				setPreparingMessage(false);
				setMapLoading(false);
				setFollowInput(pendingMessage.current);
				setStopped(true);
			} else if (await conversation.abort()) setStopped(true);
		} catch (error) {
			setConversationError(error instanceof Error ? error.message : m("chatError"));
		} finally {
			setAborting(false);
		}
	}
	function newExploration(): void {
		if (conversation.getState().busy || sendPending.current || mapQuestions.length > 0) return;
		sendEpoch.current++;
		queryEpoch.current++;
		queryAbort.current?.abort();
		conversation.newThread();
		setStopped(false);
		setConversationError(undefined);
		setView("home");
		setPlaces([]);
		setSources([]);
		setSelectedId(undefined);
		setDetailId(undefined);
		setComparisonOpen(false);
		setLocationOpen(false);
		setLocationCandidates([]);
		setLocationInput("");
		setSideInput("");
		setMapError(undefined);
		setMapLoading(false);
		setHasSearched(false);
		setHomeInput("");
		setFollowInput("");
		setFollowContext(undefined);
		setCenterChanged(false);
	}
	function savePlace(place: RealPlace): void {
		const removing = savedState.favorites.some((entry) => entry.id === place.id);
		setSavedState((current) => ({ ...current, favorites: toggleLiveFavorite(current.favorites, place) }));
		if (view === "saved" && removing) {
			if (detailId === place.id) closeDetail();
			if (selectedId === place.id) setSelectedId(undefined);
			if (followContext?.id === place.id) setFollowContext(undefined);
		}
		showToast(m(removing ? "toastUnfavorite" : "toastFavorite", { name: placeName(place) }));
	}
	function comparePlace(place: RealPlace): void {
		const result = toggleLiveCompare(comparisonPlaces, place);
		if (result.full) {
			showToast(m("compareFull"));
			return;
		}
		setComparisonPlaces(result.places);
		if (result.places.length < 2) setComparisonOpen(false);
	}
	function selectPin(id: string): void {
		setSelectedId(id);
		setDetailId(undefined);
		requestAnimationFrame(() => {
			const panel = panelScrollRef.current,
				card = cardRefs.current.get(id);
			if (panel && card)
				panel.scrollTo({
					top: Math.max(
						0,
						card.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 10,
					),
					behavior: "smooth",
				});
		});
	}
	function openDetail(place: RealPlace, target: HTMLElement): void {
		detailReturnRef.current = target;
		setSelectedId(place.id);
		setDetailId(place.id);
		setLocationOpen(false);
	}
	function askPlace(place: RealPlace): void {
		setSelectedId(place.id);
		setDetailId(undefined);
		setFollowContext(place);
		setFollowInput(m("placePrompt"));
		if (view === "home") setView("results");
		requestAnimationFrame(() => followInputRef.current?.focus());
	}
	function providedFields(place: RealPlace): { key: MapCopyKey; value: string }[] {
		return (
			[
				["openingHours", place.openingHours],
				["phone", place.phone],
				["wheelchair", place.wheelchair],
				["internetAccess", place.internetAccess],
				["cuisine", place.tags.cuisine],
			] as const
		)
			.filter(
				(
					entry,
				): entry is readonly ["openingHours" | "phone" | "wheelchair" | "internetAccess" | "cuisine", string] =>
					Boolean(entry[1]),
			)
			.map(([key, value]) => ({ key, value }));
	}
	function sourceLinks(place: RealPlace): JSX.Element {
		const source = safeExternalUrl(place.source.url),
			website = safeExternalUrl(place.website);
		return (
			<div className="live-source-links">
				{source && (
					<a href={source} target="_blank" rel="noopener noreferrer">
						{m("sourceLink")}
					</a>
				)}
				{website && (
					<a href={website} target="_blank" rel="noopener noreferrer">
						{m("openWebsite")}
					</a>
				)}
			</div>
		);
	}
	function renderPlaceCard(place: RealPlace, index: number): JSX.Element {
		const favorite = savedState.favorites.some((entry) => entry.id === place.id),
			compared = comparisonPlaces.some((entry) => entry.id === place.id);
		return (
			<article
				key={place.id}
				className={`place-card live-place-card${selectedId === place.id ? " selected" : ""}`}
				data-place={place.id}
				ref={(node) => {
					if (node) cardRefs.current.set(place.id, node);
					else cardRefs.current.delete(place.id);
				}}
			>
				<button
					type="button"
					className="place-open"
					aria-label={m("viewDetail", { name: placeName(place) })}
					onClick={(event) => openDetail(place, event.currentTarget)}
				>
					<div className="place-text">
						<div className="place-heading">
							<span className="number-disc">{index + 1}</span>
							<strong>{placeName(place)}</strong>
						</div>
						<span className="place-category">
							{m(categoryLabels[place.category])} · {distance(place)}
						</span>
						<p className="live-place-address">{place.address || pointLabel(place)}</p>
						<div className="place-tags">
							{providedFields(place)
								.slice(0, 2)
								.map((field) => (
									<span className="place-tag" key={field.key}>
										{m(field.key)}: {field.value}
									</span>
								))}
						</div>
					</div>
				</button>
				<button
					type="button"
					className={`bookmark${favorite ? " saved" : ""}`}
					aria-label={m(favorite ? "unfavoritePlace" : "favoritePlace", { name: placeName(place) })}
					aria-pressed={favorite}
					onClick={() => savePlace(place)}
				>
					<MapIcon name="bookmark" />
				</button>
				<div className="live-card-source">
					{m(place.source.provider === "user" ? "sourceUser" : "sourceMap")}
					{sourceLinks(place)}
				</div>
				<div className="card-actions">
					<button
						type="button"
						className={compared ? "in-compare" : ""}
						aria-pressed={compared}
						onClick={() => comparePlace(place)}
					>
						<MapIcon name="compare" />
						{m(compared ? "inCompare" : "addCompare")}
					</button>
					<button type="button" onClick={() => askPlace(place)}>
						<MapIcon name="chat" />
						{m("askPlace")}
					</button>
				</div>
			</article>
		);
	}
	function locationControl(): JSX.Element {
		return (
			<div className="location-control" ref={locationRef}>
				<div className="map-current-location">
					<span>
						<MapIcon name="pin" />
						{configuredLocation.name}
					</span>
					<button
						type="button"
						className="map-location-config-button"
						ref={positionSettingsButtonRef}
						aria-label={m("positionSettings")}
						title={m("positionSettings")}
						onClick={openPositionSettings}
					>
						<MapIcon name="settings" />
					</button>
				</div>
				<p className="map-device-location-status">
					{m(configuredLocation.precision === "area" ? "positionAreaNote" : "positionPointNote")}
				</p>
				<button
					type="button"
					className="location-pill"
					ref={locationTriggerRef}
					aria-label={m("location")}
					aria-expanded={locationOpen}
					aria-controls="owl-map-location-menu"
					onClick={() => setLocationOpen(!locationOpen)}
				>
					<MapIcon name="pin" />
					<span>{m("browseCenter", { name: centerLabel })}</span>
					<span className="chev" aria-hidden="true">
						⌄
					</span>
				</button>
				{deviceLocationState.phase === "pending" && (
					<output className="map-device-location-status" aria-live="polite">
						{m("locating")}
					</output>
				)}
				{deviceLocationState.location && (
					<p className="map-device-location-status">
						{deviceLocationState.location.accuracyMeters === null
							? m("gpsAccuracyUnknown")
							: m("deviceAccuracy", { n: Math.ceil(deviceLocationState.location.accuracyMeters) })}
					</p>
				)}
				{locationOpen && (
					<div className="location-menu live-location-menu" id="owl-map-location-menu">
						<div className="live-location-head">
							<strong>{m("location")}</strong>
							<button
								type="button"
								aria-label={m("closeLocation")}
								onClick={() => {
									setLocationOpen(false);
									locationTriggerRef.current?.focus();
								}}
							>
								<MapIcon name="close" />
							</button>
						</div>
						<form
							className="live-place-search"
							onSubmit={(event) => {
								event.preventDefault();
								void searchPlaces(locationInput, true);
							}}
						>
							<input
								ref={locationInputRef}
								aria-label={m("locationSearch")}
								placeholder={m("locationPlaceholder")}
								value={locationInput}
								onChange={(event) => setLocationInput(event.target.value)}
							/>
							<button type="submit" disabled={mapLoading || !locationInput.trim()}>
								{m("locationSubmit")}
							</button>
						</form>
						<small>{m("locationNote")}</small>
						<small>{m("coordinatesHint")}</small>
						{mapLoading && <output className="live-map-status">{m("searching")}</output>}
						{mapError && (
							<p className="map-conversation-error" role="alert">
								{mapError}
							</p>
						)}
						<section className="live-location-results" aria-label={m("locationCandidates")}>
							{locationCandidates.map((place) => (
								<button key={place.id} type="button" onClick={() => chooseLocation(place)}>
									<strong>{placeName(place)}</strong>
									<small>{place.address || pointLabel(place)}</small>
								</button>
							))}
						</section>
					</div>
				)}
			</div>
		);
	}
	function nearbyControls(): JSX.Element {
		return (
			<section className="live-nearby-controls" aria-label={m("nearby")}>
				<div className="filter-row">
					{categories.map((value) => (
						<button
							key={value}
							type="button"
							className={`filter-chip${category === value ? " active" : ""}`}
							aria-pressed={category === value}
							onClick={() => void nearbyPlaces(centerRef.current, value)}
						>
							<MapIcon name={categoryIcons[value]} />
							{m(categoryLabels[value])}
						</button>
					))}
				</div>
				<div className="live-nearby-radius">
					<label>
						{m("radius")}
						<select
							aria-label={m("radius")}
							value={radius}
							onChange={(event) => setRadius(Number(event.target.value))}
						>
							{[...new Set([500, 1000, 2000, 5000, radius])]
								.sort((a, b) => a - b)
								.map((value) => (
									<option key={value} value={value}>
										{value < 1000 ? m("radiusMeters", { n: value }) : m("radiusKm", { n: value / 1000 })}
									</option>
								))}
						</select>
					</label>
					<button type="button" disabled={mapLoading} onClick={() => void nearbyPlaces()}>
						{m("nearbySubmit")}
					</button>
				</div>
			</section>
		);
	}
	function followupPanel(): JSX.Element {
		return (
			<section className="followup-box">
				<div className="followup-context">
					<MapIcon name="pin" />
					<span>
						{followContext
							? m("discussing", { name: placeName(followContext) })
							: m("followContext", { name: centerLabel })}
					</span>
					{followContext && (
						<button
							type="button"
							aria-label={m("cancel")}
							onClick={() => {
								setFollowContext(undefined);
								setFollowInput("");
							}}
						>
							<MapIcon name="close" />
						</button>
					)}
				</div>
				<form
					className="followup-input"
					onSubmit={(event) => {
						event.preventDefault();
						void submitQuery(followInput);
					}}
				>
					<input
						ref={followInputRef}
						aria-label={m("followLabel")}
						placeholder={m("followPlaceholder")}
						value={followInput}
						onChange={(event) => setFollowInput(event.target.value)}
					/>
					{busy ? (
						<button
							type="button"
							className="map-stop-btn"
							disabled={aborting}
							aria-label={m("chatStop")}
							onClick={() => void stopReply()}
						>
							<MapIcon name="close" />
						</button>
					) : (
						<button
							type="submit"
							className="send-btn"
							disabled={sendDisabled || !followInput.trim()}
							aria-label={m("sendFollowup")}
						>
							<MapIcon name="arrow" />
						</button>
					)}
				</form>
				{composerStatus()}
				<div className="followup-footer">
					<span>{m("chatFooter")}</span>
					<span>{m("enterSend")}</span>
				</div>
			</section>
		);
	}
	function composerStatus(): JSX.Element {
		return (
			<div className="map-composer-model">
				<span>{modelName || modelId ? `${m("currentModel")} · ${displayedModel}` : displayedModel}</span>
				<span className="map-thinking-level">{m("currentThinking", { level: thinkingLevel })}</span>
				{unavailable && <p className="map-composer-status">{unavailable}</p>}
				{busy && (
					<p className="map-composer-status" aria-live="polite">
						{m(aborting ? "chatStopping" : conversationState.submitting ? "chatSubmitting" : "chatGenerating")}
					</p>
				)}
			</div>
		);
	}

	function conversationPanel(): JSX.Element {
		return (
			<section className="map-conversation" aria-label={m("conversation")}>
				<div className="map-conversation-head">
					<h2>{m("conversation")}</h2>
					<span className="map-conversation-model" title={model}>
						{displayedModel}
					</span>
				</div>
				<p className="map-model-reuse">{m("currentModel")}</p>
				<div
					className="map-conversation-messages"
					ref={conversationScrollRef}
					role="log"
					aria-live="polite"
					aria-busy={busy}
					onScroll={(event) => {
						const el = event.currentTarget;
						conversationPinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
					}}
				>
					{conversationState.entries.map((entry, index) => {
						const messageId = `${index}:${entry.kind}`;
						return (
							<article
								key={messageId}
								className={`map-message map-message-${entry.kind === "user" ? "user" : "assistant"}`}
							>
								<div className="map-message-role">
									{m(entry.kind === "user" ? "conversationYou" : "conversationOwl")}
								</div>
								{entry.kind === "toolResult" ? (
									<div className="map-message-tools">
										{entry.toolName} · {entry.brief}
									</div>
								) : (
									<>
										{entry.kind === "assistant" && entry.thinking && (
											<details className="map-message-thinking">
												<summary>{m("chatThinking")}</summary>
												<div className="map-message-text">{entry.thinking}</div>
											</details>
										)}
										{entry.text && <div className="map-message-text">{entry.text}</div>}
										{entry.kind === "assistant" && entry.tools.length > 0 && (
											<div className="map-message-tools">
												{entry.tools.map((tool) => (
													<p key={tool.id}>
														{tool.summary || tool.name} ·{" "}
														{m(
															tool.status === "ok"
																? "chatToolCompleted"
																: tool.status === "error"
																	? "chatToolError"
																	: tool.status === "cancelled"
																		? "chatToolCancelled"
																		: "chatTool",
														)}
													</p>
												))}
											</div>
										)}
										{entry.kind === "assistant" && entry.error && (
											<p className="map-conversation-error">{entry.error}</p>
										)}
									</>
								)}
							</article>
						);
					})}
					{conversationState.entries.length === 0 && (
						<p className="map-conversation-empty">{m("conversationEmpty")}</p>
					)}
				</div>
				{busy && (
					<output className="map-conversation-status is-generating">
						{m(aborting ? "chatStopping" : conversationState.submitting ? "chatSubmitting" : "chatGenerating")}
					</output>
				)}
				{stopped && !busy && <output className="map-conversation-status is-stopped">{m("chatStopped")}</output>}
				{(conversationState.error || conversationError) && (
					<div className="map-conversation-error" role="alert">
						<strong>{m("chatError")}</strong>
						<p>{conversationState.error || conversationError}</p>
					</div>
				)}
				{unavailable && <p className="map-composer-status">{unavailable}</p>}
			</section>
		);
	}

	const comparisonDimensions: readonly { label: MapCopyKey; value: (place: RealPlace) => ReactNode }[] = [
		{ label: "straightDistance", value: distance },
		{ label: "categoryOther", value: (place) => m(categoryLabels[place.category]) },
		{ label: "address", value: (place) => place.address || m("notProvided") },
		{ label: "openingHours", value: (place) => place.openingHours || m("notProvided") },
		{ label: "wheelchair", value: (place) => place.wheelchair || m("notProvided") },
		{ label: "internetAccess", value: (place) => place.internetAccess || m("notProvided") },
		{ label: "source", value: sourceLinks },
	];
	return (
		<div className={`owl-map-workspace${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`} ref={workspaceRef}>
			{positionSettingsOpen && (
				<dialog
					className="map-position-settings"
					ref={positionSettingsRef}
					aria-labelledby="owl-position-settings-title"
					onCancel={(event) => {
						event.preventDefault();
						closePositionSettings();
					}}
				>
					<header>
						<h2 id="owl-position-settings-title">{m("positionSettingsTitle")}</h2>
						<button type="button" aria-label={m("closePositionSettings")} onClick={closePositionSettings}>
							<MapIcon name="close" />
						</button>
					</header>
					<p>{m("positionSettingsDescription")}</p>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void searchConfiguredLocation();
						}}
					>
						<input
							ref={positionSettingsInputRef}
							aria-label={m("positionSearch")}
							placeholder={m("locationPlaceholder")}
							value={settingsInput}
							onChange={(event) => {
								settingsEpoch.current++;
								settingsAbort.current?.abort();
								setSettingsInput(event.target.value);
								setSettingsDraft(undefined);
								setSettingsCandidates([]);
								setSettingsError(undefined);
								setSettingsBusy(false);
							}}
						/>
						<button type="submit" disabled={settingsBusy || !settingsInput.trim()}>
							{m("locationSubmit")}
						</button>
					</form>
					<small>{m("coordinatesHint")}</small>
					{settingsBusy && <output aria-live="polite">{m("searching")}</output>}
					{settingsError && (
						<p className="map-conversation-error" role="alert">
							{settingsError}
						</p>
					)}
					<div className="map-position-candidates">
						{settingsCandidates.map((place) => (
							<button
								key={place.id}
								type="button"
								aria-pressed={settingsDraft?.lat === place.lat && settingsDraft?.lng === place.lng}
								onClick={() =>
									setSettingsDraft({
										lat: place.lat,
										lng: place.lng,
										name: place.name,
										source: "user",
										precision: place.tags.admin_level || place.tags.place ? "area" : "point",
										updatedAt: new Date().toISOString(),
									})
								}
							>
								<strong>{placeName(place)}</strong>
								<small>{place.address || pointLabel(place)}</small>
							</button>
						))}
					</div>
					{settingsDraft && (
						<p className="map-position-selection">
							<MapIcon name="check" />
							{settingsDraft.name}
							<small>{m(settingsDraft.precision === "area" ? "positionAreaNote" : "positionPointNote")}</small>
						</p>
					)}
					<footer>
						<button type="button" onClick={closePositionSettings}>
							{m("cancel")}
						</button>
						<button
							type="button"
							className="primary"
							disabled={!settingsDraft || settingsBusy}
							onClick={saveConfiguredLocation}
						>
							{m("savePosition")}
						</button>
					</footer>
				</dialog>
			)}
			<aside className="map-sidebar" id="owl-map-sidebar" aria-label={m("map")} inert={comparisonOpen}>
				<div className="sidebar-brand">
					<strong>owl</strong>
					<span className="local">{m("local")}</span>
				</div>
				<form
					className="sidebar-search"
					onSubmit={(event) => {
						event.preventDefault();
						void searchPlaces(sideInput);
					}}
				>
					<MapIcon name="search" />
					<input
						aria-label={m("sideSearch")}
						placeholder={m("sideSearch")}
						value={sideInput}
						onChange={(event) => setSideInput(event.target.value)}
					/>
				</form>
				<button type="button" className="side-new" disabled={busy} onClick={newExploration}>
					<MapIcon name="plus" />
					{m("newExplore")}
				</button>
				<button
					type="button"
					className={`side-item${view !== "saved" ? " active" : ""}`}
					disabled={busy}
					aria-current={view !== "saved" ? "page" : undefined}
					onClick={newExploration}
				>
					<MapIcon name="compass" />
					{m("explore")}
				</button>
				<button
					type="button"
					className={`side-item${view === "saved" ? " active" : ""}`}
					aria-current={view === "saved" ? "page" : undefined}
					onClick={() => {
						setView("saved");
						setDetailId(undefined);
						setSelectedId(undefined);
						setFollowContext(undefined);
					}}
				>
					<MapIcon name="bookmark" />
					{m("favorites")}
					<span className="count">{savedState.favorites.length || ""}</span>
				</button>
				<div className="map-sidebar-scroll">
					<p className="side-section-label">
						{m("recent")}
						<button
							type="button"
							aria-label={m("clearHistory")}
							disabled={!savedState.history.length}
							onClick={() => setSavedState((current) => ({ ...current, history: [] }))}
						>
							<MapIcon name="close" />
						</button>
					</p>
					{savedState.history.length ? (
						savedState.history.slice(0, 8).map((entry) => (
							<button key={entry.id} type="button" className="recent-entry" onClick={() => replaySearch(entry)}>
								<MapIcon name="clock" />
								<span>
									{entry.query || entry.locationName}
									<small>
										{entry.locationName} · {m(categoryLabels[entry.category])}
									</small>
								</span>
							</button>
						))
					) : (
						<p className="live-history-empty">{m("historyEmpty")}</p>
					)}
				</div>
				<div className="side-tip">
					<MapIcon name="sparkle" />
					{m("sideTip")}
				</div>
				<div className="side-account">
					<span className="circle" aria-hidden="true">
						L
					</span>
					<div>
						<strong>{m("localSpace")}</strong>
						<small>{m("localSaved")}</small>
					</div>
				</div>
			</aside>
			<main className="owl-map-frame">
				<div className="map-workspace-body" style={{ display: "contents" }} inert={comparisonOpen}>
					<header className="map-header">
						<h1>
							<MapIcon name="map" />
							{m("map")}
						</h1>
						<span className="header-divider" aria-hidden="true" />
						<span className="subtitle">{m("subtitle")}</span>
						<span className="map-source-badge">{m("mapBadge")}</span>
						<div className="spacer" />
						<button
							type="button"
							className="header-action"
							ref={newExploreRef}
							disabled={busy}
							onClick={newExploration}
						>
							<MapIcon name="plus" />
							{m("newExplore")}
						</button>
						<button
							type="button"
							className="header-action"
							onClick={() => {
								setView("saved");
								setDetailId(undefined);
								setSelectedId(undefined);
								setFollowContext(undefined);
							}}
						>
							<MapIcon name="bookmark" />
							{m("favorites")}
							{savedState.favorites.length ? ` · ${savedState.favorites.length}` : ""}
						</button>
					</header>
					<div className={`map-content${hasDetail ? " has-detail" : ""}`}>
						<section className="explore-panel" aria-label={m(view === "saved" ? "favorites" : "explore")}>
							<div className="panel-scroll" ref={panelScrollRef}>
								{view !== "home" && conversationPanel()}
								{locationControl()}
								{view === "home" && mapError && (
									<p className="map-conversation-error" role="alert">
										{mapError}
									</p>
								)}
								{view === "home" ? (
									<>
										<h2 className="home-heading" style={{ whiteSpace: "pre-line" }}>
											{m("homeTitle")}
										</h2>
										<p className="home-description" style={{ whiteSpace: "pre-line" }}>
											{m("homeDescription")}
										</p>
										<button
											type="button"
											className="live-choose-location"
											onClick={() => setLocationOpen(true)}
										>
											<MapIcon name="search" />
											{m("location")}
										</button>
										<form
											className="home-query"
											onSubmit={(event) => {
												event.preventDefault();
												void submitQuery(homeInput);
											}}
										>
											<textarea
												aria-label={m("queryLabel")}
												placeholder={m("homePlaceholder")}
												value={homeInput}
												onChange={(event) => setHomeInput(event.target.value)}
											/>
											<div className="query-bottom">
												<MapIcon name="sparkle" />
												{m("idea")}
												<button
													type="submit"
													className="send-btn"
													aria-label={m("start")}
													disabled={sendDisabled || !homeInput.trim()}
												>
													<MapIcon name="arrow" />
												</button>
											</div>
										</form>
										{composerStatus()}
										<p className="example-label">{m("exampleLabel")}</p>
										{nearbyControls()}
										<p className="home-foot">
											<MapIcon name="info" />
											{m("sourceNote")}
										</p>
									</>
								) : (
									<>
										<h2 className="results-title">
											{m(
												view === "saved"
													? "savedTitle"
													: resultKind === "nearby" || !hasSearched
														? "nearbyTitle"
														: "searchTitle",
											)}
										</h2>
										<p className="ai-summary">{m("selectedCenter", { name: centerLabel })}</p>
										{resultQuery && view !== "saved" && (
											<p className="search-query-label">{m("searchQuery", { query: resultQuery })}</p>
										)}
										{view !== "saved" && nearbyControls()}
										{centerChanged && <p className="live-map-notice">{m("centerChanged")}</p>}
										{mapLoading && <output className="live-map-status">{m("searching")}</output>}
										{mapError && (
											<div className="map-conversation-error" role="alert">
												<p>{mapError}</p>
												<button type="button" onClick={retryLookup}>
													{m("retry")}
												</button>
											</div>
										)}
										{partialResults && <p className="live-map-notice">{m("partialResults")}</p>}
										<div className="result-meta">
											<span aria-live="polite">
												{m(view === "saved" ? "savedCount" : "resultsCount", { n: rows.length })}
											</span>
											<select
												aria-label={m("sort")}
												value={sort}
												onChange={(event) => setSort(event.target.value === "name" ? "name" : "distance")}
											>
												<option value="distance">{m("distanceSort")}</option>
												<option value="name">{m("nameSort")}</option>
											</select>
										</div>
										<div className="place-list">
											{rows.length
												? rows.map(renderPlaceCard)
												: !mapLoading &&
													!mapError &&
													(hasSearched || view === "saved") && (
														<div className="empty-results">
															<MapIcon name={view === "saved" ? "bookmark" : "search"} />
															<strong>{m(view === "saved" ? "noSaved" : "noResults")}</strong>
															<p>{m(view === "saved" ? "noSavedHint" : "noResultsHint")}</p>
															<button type="button" onClick={() => setLocationOpen(true)}>
																{m("location")}
															</button>
														</div>
													)}
										</div>
									</>
								)}
							</div>
							<div className="map-question-dock" ref={mapQuestionDockRef} hidden={!activeMapQuestion}>
								{mapQuestions.map((request) => (
									<div
										key={request.requestId}
										className="map-question-column"
										hidden={request.requestId !== activeMapQuestion?.requestId}
									>
										<QuestionDialog
											request={request}
											onAnswer={(answers, cancelled) =>
												onAnswerQuestion(request.requestId, answers, cancelled)
											}
										/>
									</div>
								))}
							</div>
							{view !== "home" && followupPanel()}
						</section>
						<section
							className={`map-stage live-map-stage${hasDetail ? " has-detail" : ""}`}
							aria-label={m("mapLabel")}
						>
							<RealMapCanvas
								active={active}
								center={center}
								places={rows}
								selectedId={selectedId}
								detailOpen={hasDetail}
								loading={mapLoading}
								locationState={deviceLocationState}
								labels={labels}
								onPlaceSelect={selectPin}
								onCenterChange={movedCenter}
								onPointSelect={(point) => void selectCoordinate(point)}
								onSearchHere={(point) => {
									deviceLocator.cancel(true);
									void nearbyPlaces(point);
								}}
								onLocate={() => locateDevice()}
								onError={(message) => setMapError(message)}
							/>
							{selectedPlace && !hasDetail && (
								<div className="map-floating-place live-floating-place">
									<MapIcon name={categoryIcons[selectedPlace.category]} />
									<div>
										<strong>{placeName(selectedPlace)}</strong>
										<small>
											{m(categoryLabels[selectedPlace.category])} · {distance(selectedPlace)}
										</small>
									</div>
									<button
										type="button"
										className="open-floating"
										aria-label={m("viewDetail", { name: placeName(selectedPlace) })}
										onClick={(event) => openDetail(selectedPlace, event.currentTarget)}
									>
										{m("detail")}
										<MapIcon name="chevron" />
									</button>
								</div>
							)}
							{comparisonPlaces.length > 0 && !hasDetail && (
								<div className="compare-tray">
									<MapIcon name="compare" />
									<small>{m("comparePlaces")}</small>
									{comparisonPlaces.map((place, index) => (
										<button
											key={place.id}
											type="button"
											className="compare-slot"
											title={placeName(place)}
											aria-label={m("removeComparePlace", { name: placeName(place) })}
											onClick={() => comparePlace(place)}
										>
											{index + 1}
										</button>
									))}
									<small>
										{comparisonPlaces.length} / {MAX_LIVE_COMPARISON}
									</small>
									<button
										type="button"
										className="compare-btn"
										disabled={comparisonPlaces.length < 2}
										title={comparisonPlaces.length < 2 ? m("compareNeedTwo") : undefined}
										onClick={(event) => {
											comparisonReturnRef.current = event.currentTarget;
											setComparisonOpen(true);
										}}
									>
										{m("startCompare")}
									</button>
								</div>
							)}
							{detailPlace && (
								<aside
									className="detail-drawer map-drawer"
									aria-label={m("detailLabel", { name: placeName(detailPlace) })}
								>
									<div className="detail-scroll">
										<div className="live-detail-hero">
											<MapIcon name={categoryIcons[detailPlace.category]} />
											<button
												type="button"
												className="detail-close"
												ref={detailCloseRef}
												aria-label={m("closeDetail")}
												onClick={closeDetail}
											>
												<MapIcon name="close" />
											</button>
										</div>
										<div className="detail-content">
											<h2 className="detail-title">{placeName(detailPlace)}</h2>
											<p className="detail-sub">
												{m(categoryLabels[detailPlace.category])} · {distance(detailPlace)}
											</p>
											<div className="detail-section">
												<h3>{m("information")}</h3>
												<div className="detail-info">
													<MapIcon name="pin" />
													<span>
														<b>{detailPlace.address || m("notProvided")}</b>
														{pointLabel(detailPlace)}
													</span>
												</div>
												{providedFields(detailPlace).map((field) => (
													<div className="detail-info" key={field.key}>
														<MapIcon
															name={
																field.key === "phone"
																	? "info"
																	: field.key === "openingHours"
																		? "clock"
																		: "check"
															}
														/>
														<span>
															<b>{m(field.key)}</b>
															{field.value}
														</span>
													</div>
												))}
												{!providedFields(detailPlace).length && (
													<p className="detail-note">{m("noExtraInformation")}</p>
												)}
											</div>
											<div className="detail-section">
												<h3>{m("sourceDetails")}</h3>
												<p className="detail-note">
													{m(detailPlace.source.provider === "user" ? "sourceUser" : "sourceMap")} ·{" "}
													{m("fetched")}: {fetched(detailPlace)}
												</p>
												{sourceLinks(detailPlace)}
												<p className="detail-note">{m("sourceNote")}</p>
											</div>
											<button type="button" className="detail-ask" onClick={() => askPlace(detailPlace)}>
												<MapIcon name="chat" />
												{m("detailAsk")}
												<span className="spacer" />
												<MapIcon name="chevron" />
											</button>
											<a
												className="detail-ask"
												href={mapDirectionsUrl(center, detailPlace)}
												target="_blank"
												rel="noopener noreferrer"
												onClick={(event) => {
													event.preventDefault();
													void client
														.request({
															type: "open.external",
															action: "url",
															target: mapDirectionsUrl(center, detailPlace),
														})
														.then((reply) => {
															if (!reply.ok) showToast(reply.error || m("mapUnavailable"));
														})
														.catch((error: unknown) =>
															showToast(error instanceof Error ? error.message : m("mapUnavailable")),
														);
												}}
											>
												<MapIcon name="compass" />
												{m("viewRoute")}
												<span className="spacer" />
												<MapIcon name="chevron" />
											</a>
											<p className="detail-note">{m("routeOrigin", { name: centerLabel })}</p>
										</div>
									</div>
									<div className="detail-actions">
										<button
											type="button"
											aria-pressed={savedState.favorites.some((place) => place.id === detailPlace.id)}
											onClick={() => savePlace(detailPlace)}
										>
											<MapIcon name="bookmark" />
											{m(
												savedState.favorites.some((place) => place.id === detailPlace.id)
													? "saved"
													: "save",
											)}
										</button>
										<button
											type="button"
											className="primary"
											aria-pressed={comparisonPlaces.some((place) => place.id === detailPlace.id)}
											onClick={() => comparePlace(detailPlace)}
										>
											<MapIcon name="compare" />
											{m(
												comparisonPlaces.some((place) => place.id === detailPlace.id)
													? "removeCompare"
													: "addCompare",
											)}
										</button>
									</div>
								</aside>
							)}
						</section>
					</div>
				</div>
				{comparisonOpen && (
					<div className="compare-overlay">
						<section
							ref={comparisonRef}
							className="compare-dialog"
							role="dialog"
							aria-modal="true"
							aria-labelledby="owl-map-comparison-title"
						>
							<div className="dialog-head">
								<h2 id="owl-map-comparison-title">{m("compareTitle")}</h2>
								<button
									type="button"
									ref={comparisonCloseRef}
									aria-label={m("closeCompare")}
									onClick={closeComparison}
								>
									<MapIcon name="close" />
								</button>
							</div>
							<div className="comparison-scroll">
								<table className="compare-table">
									<thead>
										<tr>
											<th scope="col">{m("compareDimension")}</th>
											{comparisonPlaces.map((place) => (
												<th scope="col" key={place.id}>
													{placeName(place)}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{comparisonDimensions.map((dimension) => (
											<tr key={dimension.label}>
												<th scope="row">{m(dimension.label)}</th>
												{comparisonPlaces.map((place) => (
													<td key={place.id}>{dimension.value(place)}</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
								<p className="detail-note">{m("compareNote")}</p>
							</div>
							<div className="dialog-footer">
								<button type="button" onClick={closeComparison}>
									{m("continueBrowse")}
								</button>
								<button
									type="button"
									className="primary"
									disabled={sendDisabled}
									onClick={() => {
										closeComparison();
										void submitQuery(m("comparePrompt"));
									}}
								>
									{m("compareDiscuss")}
								</button>
							</div>
						</section>
					</div>
				)}
			</main>
			{toast && active && <output className="owl-product-toast">{toast}</output>}
		</div>
	);
}
