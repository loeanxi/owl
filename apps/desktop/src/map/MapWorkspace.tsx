import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { useMapCopy, type MapCopyKey } from "./copy.ts";
import { MapIcon, type MapIconName } from "./Icons.tsx";
import {
	addSearchHistory,
	DEFAULT_SEARCH,
	DEMO_PLACES,
	getFavoriteResults,
	getSearchResults,
	keepVisibleSelection,
	MAP_REGIONS,
	MAX_COMPARE_PLACES,
	MAX_QUERY_LENGTH,
	parseMapQuery,
	readMapSavedState,
	toggleCompare,
	toggleFavorite,
	writeMapSavedState,
	type MapRegion,
	type MapSavedState,
	type Place,
	type PlaceArt,
	type PlaceFilter,
	type PlaceId,
	type PlaceType,
	type SearchScope,
} from "./model.ts";
import "./map-workspace.css";

type MapView = "home" | "results" | "saved";

const artPaths: Record<PlaceArt, string> = {
	cafe1: "/maps/cafe-window.svg",
	cafe2: "/maps/cafe-bar.svg",
	cafe3: "/maps/cafe-lake.svg",
	museum: "/maps/museum.svg",
	park: "/maps/park.svg",
};
const categoryCopy: Record<PlaceType, MapCopyKey> = {
	cafe: "categoryCafe",
	park: "categoryPark",
	museum: "categoryMuseum",
};
const categoryIcons: Record<PlaceType, MapIconName> = { cafe: "coffee", park: "tree", museum: "museum" };
const categoryQueries: Record<PlaceType, MapCopyKey> = { cafe: "queryCafe", park: "queryPark", museum: "queryMuseum" };
const categoryHeadings: Record<PlaceType, MapCopyKey> = {
	cafe: "resultsCafe",
	park: "resultsPark",
	museum: "resultsMuseum",
};
const filters: readonly PlaceFilter[] = ["quiet", "plug", "budget", "lake"];

export function MapWorkspace({
	sidebarCollapsed = false,
	active = true,
}: {
	sidebarCollapsed?: boolean;
	active?: boolean;
}): JSX.Element {
	const copy = useMapCopy();
	const m = copy.text;
	const [view, setView] = useState<MapView>("home");
	const [scope, setScope] = useState<SearchScope>(DEFAULT_SEARCH);
	const [savedState, setSavedState] = useState<MapSavedState>(() => {
		try {
			return readMapSavedState(window.localStorage);
		} catch {
			return { favorites: [], history: [] };
		}
	});
	const [comparisonIds, setComparisonIds] = useState<PlaceId[]>([]);
	const [selectedId, setSelectedId] = useState<PlaceId>();
	const [detailId, setDetailId] = useState<PlaceId>();
	const [comparisonOpen, setComparisonOpen] = useState(false);
	const [locationOpen, setLocationOpen] = useState(false);
	const [homeInput, setHomeInput] = useState("");
	const [sideInput, setSideInput] = useState("");
	const [followInput, setFollowInput] = useState("");
	const [followContext, setFollowContext] = useState<PlaceId>();
	const [followAnswerId, setFollowAnswerId] = useState<PlaceId>();
	const [zoom, setZoom] = useState(1);
	const [toast, setToast] = useState("");
	const workspaceRef = useRef<HTMLDivElement>(null);
	const panelScrollRef = useRef<HTMLDivElement>(null);
	const followInputRef = useRef<HTMLInputElement>(null);
	const locationRef = useRef<HTMLDivElement>(null);
	const locationTriggerRef = useRef<HTMLButtonElement>(null);
	const detailCloseRef = useRef<HTMLButtonElement>(null);
	const comparisonRef = useRef<HTMLElement>(null);
	const comparisonCloseRef = useRef<HTMLButtonElement>(null);
	const newExploreRef = useRef<HTMLButtonElement>(null);
	const detailReturnRef = useRef<HTMLElement | null>(null);
	const comparisonReturnRef = useRef<HTMLElement | null>(null);
	const cardRefs = useRef(new Map<PlaceId, HTMLElement>());
	const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const storageInitialized = useRef(false);

	const rows = view === "saved" ? getFavoriteResults(savedState.favorites, scope.region) : getSearchResults(scope);
	if (view === "saved" && scope.sort === "price") rows.sort((a, b) => a.price - b.price);
	const homeRows = DEMO_PLACES.filter(
		(p) => (scope.region === "all" || p.area === scope.region) && ["liubai", "museum", "park"].includes(p.id),
	);
	const mapRows = view === "home" ? homeRows : rows;
	const selectedPlace = mapRows.find((p) => p.id === selectedId);
	const detailPlace = mapRows.find((p) => p.id === detailId);
	const comparisonPlaces = DEMO_PLACES.filter((p) => comparisonIds.includes(p.id));
	const regionLabel = scope.region === "all" ? m("hangzhou") : `${m("hangzhou")} · ${copy.region(scope.region)}`;
	const contextPlace = DEMO_PLACES.find((p) => p.id === followContext);
	const answerPlace = DEMO_PLACES.find((p) => p.id === followAnswerId);
	const hasDetail = Boolean(detailPlace);

	function showToast(message: string): void {
		setToast(message);
		clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(""), 4000);
	}

	useEffect(() => () => clearTimeout(toastTimer.current), []);
	useEffect(() => {
		if (!storageInitialized.current) {
			storageInitialized.current = true;
			return;
		}
		try {
			if (!writeMapSavedState(window.localStorage, savedState)) showToast(m("storageUnavailable"));
		} catch {
			showToast(m("storageUnavailable"));
		}
	}, [savedState]);

	useEffect(() => {
		if (!active) return;
		if (comparisonOpen) comparisonCloseRef.current?.focus();
		else if (detailId) detailCloseRef.current?.focus();
	}, [active, comparisonOpen, detailId]);

	function restoreFocus(target: HTMLElement | null): void {
		requestAnimationFrame(() => {
			if (!active) return;
			if (target?.isConnected && target.getClientRects().length > 0) target.focus();
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
				const candidates = comparisonRef.current.querySelectorAll<HTMLElement>(
					"button:not(:disabled), input, select, textarea, a[href], [tabindex='0']",
				);
				const focusable = Array.from(candidates).filter((el) => el.getClientRects().length > 0);
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
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
			if (locationOpen && event.target instanceof Node && !locationRef.current?.contains(event.target))
				setLocationOpen(false);
		}
		document.addEventListener("keydown", handleKey);
		document.addEventListener("pointerdown", handlePointer);
		return () => {
			document.removeEventListener("keydown", handleKey);
			document.removeEventListener("pointerdown", handlePointer);
		};
	}, [active, comparisonOpen, detailId, locationOpen]);

	function updateScope(next: SearchScope, nextView: MapView = "results"): void {
		setScope(next);
		setView(nextView);
		setDetailId(undefined);
		setLocationOpen(false);
		setFollowContext(undefined);
		setFollowAnswerId(undefined);
		const nextRows =
			nextView === "saved" ? getFavoriteResults(savedState.favorites, next.region) : getSearchResults(next);
		setSelectedId(keepVisibleSelection(nextRows, selectedId));
		requestAnimationFrame(() => {
			if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
		});
	}

	function submitQuery(text: string, follow = false): void {
		const query = text.trim();
		if (!query) {
			showToast(m("emptyQuery"));
			return;
		}
		if (follow && contextPlace) {
			setFollowAnswerId(contextPlace.id);
			setFollowInput("");
			return;
		}
		const next = parseMapQuery(query, follow ? scope : { ...DEFAULT_SEARCH, region: scope.region });
		updateScope(next);
		setSavedState((current) => ({ ...current, history: addSearchHistory(current.history, next.query) }));
		setHomeInput("");
		setFollowInput("");
		setSideInput("");
	}

	function chooseCategory(category: PlaceType): void {
		const query = m(categoryQueries[category]);
		const next = { ...DEFAULT_SEARCH, region: scope.region, category, query };
		updateScope(next);
		setSavedState((current) => ({ ...current, history: addSearchHistory(current.history, query) }));
	}

	function newExploration(): void {
		setView("home");
		setScope({ ...DEFAULT_SEARCH, region: scope.region });
		setSelectedId(undefined);
		setDetailId(undefined);
		setComparisonOpen(false);
		setLocationOpen(false);
		setHomeInput("");
		setFollowInput("");
		setFollowContext(undefined);
		setFollowAnswerId(undefined);
		setZoom(1);
		requestAnimationFrame(() => {
			if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
		});
	}

	function showSaved(): void {
		updateScope({ ...DEFAULT_SEARCH, region: scope.region }, "saved");
		setComparisonOpen(false);
	}

	function changeRegion(region: MapRegion): void {
		const next = { ...scope, region };
		updateScope(next, view);
	}

	function changeFilter(filter: PlaceFilter, addOnly = false): void {
		const nextFilters = new Set(scope.filters);
		if (nextFilters.has(filter) && !addOnly) nextFilters.delete(filter);
		else nextFilters.add(filter);
		updateScope(
			{
				...scope,
				category: view === "saved" ? (selectedPlace?.type ?? scope.category) : scope.category,
				filters: nextFilters,
				placeId: undefined,
			},
			"results",
		);
	}

	function savePlace(id: PlaceId): void {
		const removing = savedState.favorites.includes(id);
		const favorites = toggleFavorite(savedState.favorites, id);
		setSavedState((current) => ({ ...current, favorites }));
		if (view === "saved" && removing) {
			const remaining = getFavoriteResults(favorites, scope.region);
			if (detailId === id) {
				setDetailId(undefined);
				restoreFocus(detailReturnRef.current);
			}
			if (selectedId === id) setSelectedId(undefined);
			if (followContext === id) {
				setFollowContext(undefined);
				setFollowAnswerId(undefined);
			}
			if (!remaining.length) setSelectedId(undefined);
		}
		showToast(m(removing ? "toastUnfavorite" : "toastFavorite", { name: copy.place(id).name }));
	}

	function comparePlace(id: PlaceId): void {
		const next = toggleCompare(comparisonIds, id);
		if (next.status === "full") {
			showToast(m("compareFull"));
			return;
		}
		setComparisonIds(next.ids);
		if (next.ids.length < 2) setComparisonOpen(false);
	}

	function selectPin(place: Place): void {
		if (view === "home")
			updateScope({
				...DEFAULT_SEARCH,
				category: place.type,
				region: scope.region,
				query: m(categoryQueries[place.type]),
			});
		setSelectedId(place.id);
		setDetailId(undefined);
		requestAnimationFrame(() => {
			const panel = panelScrollRef.current;
			const card = cardRefs.current.get(place.id);
			if (panel && card) {
				const top = card.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
				panel.scrollTo({ top: Math.max(0, top - 10), behavior: "smooth" });
			}
		});
	}

	function openDetail(place: Place, target: HTMLElement): void {
		detailReturnRef.current = target;
		setSelectedId(place.id);
		setDetailId(place.id);
		setLocationOpen(false);
	}

	function askPlace(place: Place): void {
		setSelectedId(place.id);
		setDetailId(undefined);
		setFollowContext(place.id);
		setFollowAnswerId(undefined);
		setFollowInput(m("placePrompt"));
		requestAnimationFrame(() => followInputRef.current?.focus());
	}

	function price(place: Place): string {
		return place.price ? m("referencePrice", { n: place.price }) : m("free");
	}

	function art(place: Place): JSX.Element {
		return <img src={artPaths[place.art]} alt="" draggable={false} />;
	}

	function locationControl(): JSX.Element {
		return (
			<div className="location-control" ref={locationRef}>
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
					<span>{regionLabel}</span>
					<span className="chev" aria-hidden="true">
						⌄
					</span>
				</button>
				{locationOpen && (
					<div className="location-menu" id="owl-map-location-menu">
						<strong>{m("location")}</strong>
						{MAP_REGIONS.map((region) => (
							<button
								key={region}
								type="button"
								aria-pressed={scope.region === region}
								onClick={() => {
									changeRegion(region);
									locationTriggerRef.current?.focus();
								}}
							>
								{scope.region === region ? "✓ " : ""}
								{copy.region(region)}
							</button>
						))}
						<small>{m("locationNote")}</small>
					</div>
				)}
			</div>
		);
	}

	function renderPlaceCard(place: Place, index: number): JSX.Element {
		const content = copy.place(place.id);
		const favorite = savedState.favorites.includes(place.id);
		const compared = comparisonIds.includes(place.id);
		return (
			<article
				key={place.id}
				className={`place-card${selectedId === place.id ? " selected" : ""}`}
				data-place={place.id}
				ref={(node) => {
					if (node) cardRefs.current.set(place.id, node);
					else cardRefs.current.delete(place.id);
				}}
			>
				<button
					type="button"
					className="place-open"
					aria-label={m("viewDetail", { name: content.name })}
					onClick={(event) => openDetail(place, event.currentTarget)}
				>
					<div className="place-photo">
						{art(place)}
						{index === 0 && (
							<span className="photo-badge">
								<MapIcon name="sparkle" />
								{m("priority")}
							</span>
						)}
					</div>
					<div className="place-text">
						<div className="place-heading">
							<span className="number-disc">{index + 1}</span>
							<strong>{content.name}</strong>
							<span className="price">{price(place)}</span>
						</div>
						<span className="place-category">
							{m(categoryCopy[place.type])} · {m("area", { region: copy.region(place.area) })}
						</span>
						<div className="place-tags">
							{content.tags.map((tag) => (
								<span className="place-tag" key={tag}>
									{tag}
								</span>
							))}
						</div>
					</div>
				</button>
				<button
					type="button"
					className={`bookmark${favorite ? " saved" : ""}`}
					aria-label={m(favorite ? "unfavoritePlace" : "favoritePlace", { name: content.name })}
					aria-pressed={favorite}
					onClick={() => savePlace(place.id)}
				>
					<MapIcon name="bookmark" />
				</button>
				<p className="place-reason">
					<strong>{m("sampleReason")}</strong>
					{content.reason}
				</p>
				<div className="card-actions">
					<button
						type="button"
						className={compared ? "in-compare" : ""}
						aria-pressed={compared}
						onClick={() => comparePlace(place.id)}
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

	function followupPanel(): JSX.Element {
		const answer = answerPlace ? copy.place(answerPlace.id) : undefined;
		return (
			<section className="followup-box">
				<div className="followup-context">
					<MapIcon name="pin" />
					<span>
						{contextPlace
							? m("discussing", { name: copy.place(contextPlace.id).name })
							: m("followContext", { region: regionLabel })}
					</span>
					{contextPlace && (
						<button
							type="button"
							aria-label={m("cancel")}
							onClick={() => {
								setFollowContext(undefined);
								setFollowAnswerId(undefined);
								setFollowInput("");
							}}
						>
							<MapIcon name="close" />
						</button>
					)}
				</div>
				{answer && answerPlace && (
					<div className="followup-answer" role="status">
						<strong>{m("followAnswerTitle")}</strong>
						<button type="button" aria-label={m("closeAnswer")} onClick={() => setFollowAnswerId(undefined)}>
							<MapIcon name="close" />
						</button>
						<p>
							{m("placeAnswer", {
								name: answer.name,
								facilities: m(answerPlace.plug ? "facilitiesPlug" : "facilitiesUnknown"),
								budget: price(answerPlace),
								hours: answer.hours,
							})}
						</p>
					</div>
				)}
				<div className="followup-chips">
					{(
						[
							["quiet", "followQuiet"],
							["budget", "followBudget"],
							["lake", "followLake"],
						] as const
					).map(([filter, label]) => (
						<button key={filter} type="button" onClick={() => changeFilter(filter, true)}>
							{m(label)}
						</button>
					))}
				</div>
				<form
					className="followup-input"
					onSubmit={(event) => {
						event.preventDefault();
						submitQuery(followInput, true);
					}}
				>
					<input
						ref={followInputRef}
						aria-label={m("followLabel")}
						placeholder={m("followPlaceholder")}
						value={followInput}
						onChange={(event) => setFollowInput(event.target.value)}
						maxLength={MAX_QUERY_LENGTH}
					/>
					<button className="send-btn" type="submit" aria-label={m("sendFollowup")}>
						<MapIcon name="arrow" />
					</button>
				</form>
				<div className="followup-footer">
					<span>{m("followFooter")}</span>
					<span>{m("enterSend")}</span>
				</div>
			</section>
		);
	}

	const topics: readonly {
		category: PlaceType;
		title: MapCopyKey;
		description: MapCopyKey;
		art: PlaceArt;
		inspiration: MapCopyKey;
		caption: MapCopyKey;
	}[] = [
		{
			category: "cafe",
			title: "cafeTitle",
			description: "cafeDescription",
			art: "cafe1",
			inspiration: "inspirationCafe",
			caption: "inspirationCafeSub",
		},
		{
			category: "park",
			title: "parkTitle",
			description: "parkDescription",
			art: "park",
			inspiration: "inspirationPark",
			caption: "inspirationParkSub",
		},
		{
			category: "museum",
			title: "museumTitle",
			description: "museumDescription",
			art: "museum",
			inspiration: "inspirationMuseum",
			caption: "inspirationMuseumSub",
		},
	];

	function comparisonAdvice(): string {
		const options = comparisonPlaces.filter((place) => place.plug && place.price <= 50);
		return options.length
			? m("compareAdvice", {
					names: options.map((place) => copy.place(place.id).name).join(copy.language === "en" ? ", " : "、"),
				})
			: m("compareAdviceGeneral");
	}
	const comparisonDimensions: readonly { label: MapCopyKey; value: (place: Place) => ReactNode }[] = [
		{ label: "referenceBudget", value: price },
		{ label: "environment", value: (place) => copy.place(place.id).environment },
		{ label: "sockets", value: (place) => m(place.plug ? "plugDemo" : "plugUnknown") },
		{ label: "position", value: (place) => copy.place(place.id).address },
		{ label: "hours", value: (place) => copy.place(place.id).hours },
		{
			label: "suitableFor",
			value: (place) =>
				m(
					place.plug
						? "suitableWork"
						: place.type === "cafe"
							? "suitableCafe"
							: place.type === "park"
								? "suitablePark"
								: "suitableMuseum",
				),
		},
	];

	return (
		<div className={`owl-map-workspace${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`} ref={workspaceRef}>
			<aside className="map-sidebar" id="owl-map-sidebar" aria-label={m("map")} inert={comparisonOpen}>
				<div className="sidebar-brand">
					<strong>owl</strong>
					<span className="local">{m("local")}</span>
				</div>
				<form
					className="sidebar-search"
					onSubmit={(event) => {
						event.preventDefault();
						submitQuery(sideInput);
					}}
				>
					<MapIcon name="search" />
					<input
						aria-label={m("sideSearch")}
						placeholder={m("sideSearch")}
						value={sideInput}
						maxLength={MAX_QUERY_LENGTH}
						onChange={(event) => setSideInput(event.target.value)}
					/>
				</form>
				<button type="button" className="side-new" onClick={newExploration}>
					<MapIcon name="plus" />
					{m("newExplore")}
				</button>
				<button
					type="button"
					className={`side-item${view !== "saved" ? " active" : ""}`}
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
					onClick={showSaved}
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
						savedState.history.slice(0, 6).map((query) => (
							<button key={query} type="button" className="recent-entry" onClick={() => submitQuery(query)}>
								<MapIcon name="clock" />
								<span>
									{query}
									<small>{m("hangzhou")}</small>
								</span>
							</button>
						))
					) : (
						<p className="map-demo-label">{m("historyEmpty")}</p>
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
						<span className="demo-note">{m("demoBadge")}</span>
						<div className="spacer" />
						<button type="button" className="header-action" ref={newExploreRef} onClick={newExploration}>
							<MapIcon name="plus" />
							{m("newExplore")}
						</button>
						<button type="button" className="header-action" onClick={showSaved}>
							<MapIcon name="bookmark" />
							{m("favorites")}
							{savedState.favorites.length ? ` · ${savedState.favorites.length}` : ""}
						</button>
					</header>
					<div className={`map-content${hasDetail ? " has-detail" : ""}`}>
						<section
							className="explore-panel"
							aria-label={
								view === "home"
									? m("explore")
									: m(view === "saved" ? "favorites" : categoryHeadings[scope.category])
							}
						>
							<div className="panel-scroll" ref={panelScrollRef}>
								{locationControl()}
								{view === "home" ? (
									<>
										<p className="intro-eyebrow">{m("eyebrow")}</p>
										<h2 className="home-heading" style={{ whiteSpace: "pre-line" }}>
											{m("homeTitle")}
										</h2>
										<p className="home-description" style={{ whiteSpace: "pre-line" }}>
											{m("homeDescription")}
										</p>
										<form
											className="home-query"
											onSubmit={(event) => {
												event.preventDefault();
												submitQuery(homeInput);
											}}
										>
											<textarea
												aria-label={m("queryLabel")}
												placeholder={m("homePlaceholder")}
												value={homeInput}
												maxLength={MAX_QUERY_LENGTH}
												onChange={(event) => setHomeInput(event.target.value)}
											/>
											<div className="query-bottom">
												<MapIcon name="sparkle" />
												{m("idea")}
												<button className="send-btn" type="submit" aria-label={m("start")}>
													<MapIcon name="arrow" />
												</button>
											</div>
										</form>
										<p className="example-label">{m("exampleLabel")}</p>
										{topics.map((topic) => (
											<button
												key={topic.category}
												type="button"
												className="discovery-option"
												onClick={() => chooseCategory(topic.category)}
											>
												<span className="tile-icon">
													<MapIcon name={categoryIcons[topic.category]} />
												</span>
												<span>
													<strong>{m(topic.title)}</strong>
													<small>{m(topic.description)}</small>
												</span>
												<span className="arrow">
													<MapIcon name="chevron" />
												</span>
											</button>
										))}
										<p className="home-foot">
											<MapIcon name="info" />
											{m("offlineNote")}
										</p>
									</>
								) : (
									<>
										<h2 className="results-title">
											{m(view === "saved" ? "resultsSaved" : categoryHeadings[scope.category])}
										</h2>
										<p className="ai-summary">
											{view === "saved"
												? m("savedSummary")
												: scope.unsupported
													? m("unsupportedSummary")
													: m("resultsSummary", { region: regionLabel, n: rows.length })}
											{scope.filters.size > 0 && view !== "saved" && (
												<>
													<br />
													{m("filterSummary")}
												</>
											)}
										</p>
										{view !== "saved" && scope.query && (
											<p className="search-query-label">{m("currentQuery", { query: scope.query })}</p>
										)}
										{view !== "saved" && (
											<div className="filter-row">
												{filters.map((filter) => (
													<button
														key={filter}
														type="button"
														className={`filter-chip${scope.filters.has(filter) ? " active" : ""}`}
														aria-pressed={scope.filters.has(filter)}
														onClick={() => changeFilter(filter)}
													>
														{scope.filters.has(filter) && <MapIcon name="check" />}
														{m(filter)}
													</button>
												))}
											</div>
										)}
										<div className="result-meta">
											<span aria-live="polite">
												{m(view === "saved" ? "savedCount" : "resultsCount", { n: rows.length })}
											</span>
											<select
												aria-label={m("sort")}
												value={scope.sort}
												onChange={(event) =>
													setScope((current) => ({
														...current,
														sort: event.target.value === "price" ? "price" : "recommended",
													}))
												}
											>
												<option value="recommended">{m("recommended")}</option>
												<option value="price">{m("priceSort")}</option>
											</select>
										</div>
										<div className="place-list">
											{rows.length ? (
												rows.map(renderPlaceCard)
											) : (
												<div className="empty-results">
													<MapIcon name={view === "saved" ? "bookmark" : "search"} />
													<strong>{m(view === "saved" ? "emptySavedTitle" : "emptyTitle")}</strong>
													<p>
														{m(
															view === "saved"
																? "emptySavedDescription"
																: scope.unsupported
																	? "emptyUnsupported"
																	: "emptyDescription",
														)}
													</p>
													<button
														type="button"
														onClick={() =>
															view === "saved" || scope.unsupported
																? chooseCategory("cafe")
																: updateScope({ ...scope, filters: new Set() })
														}
													>
														{m(view === "saved" || scope.unsupported ? "discoverCafe" : "clearFilters")}
													</button>
												</div>
											)}
										</div>
									</>
								)}
							</div>
							{view !== "home" && followupPanel()}
						</section>
						<section
							className={`map-stage map-surface${hasDetail ? " has-detail" : ""}`}
							aria-label={m("mapLabel")}
						>
							<div
								className="map-art map-world"
								style={{ transform: `scale(${zoom})`, transformOrigin: "50% 50%" }}
							>
								<img className="map-art-dark" src="/maps/hangzhou.svg" alt="" draggable={false} />
								<img className="map-art-light" src="/maps/hangzhou-light.svg" alt="" draggable={false} />
								{mapRows.map((place, index) => (
									<button
										key={place.id}
										type="button"
										className={`map-pin${selectedId === place.id ? " selected" : ""}`}
										style={{ left: `${place.x}%`, top: `${place.y}%` }}
										aria-label={m("markerSelect", { name: copy.place(place.id).name })}
										aria-pressed={selectedId === place.id}
										onClick={() => selectPin(place)}
									>
										<span className="pin-body">
											<span className="pin-num">
												{view === "home" ? <MapIcon name={categoryIcons[place.type]} /> : index + 1}
											</span>
											<span className="pin-label">{copy.place(place.id).name}</span>
										</span>
									</button>
								))}
								<div
									className="map-dot"
									style={{ left: "71%", top: "48%" }}
									title={m("searchCenter")}
									aria-hidden="true"
								/>
							</div>
							<div className="map-shade" />
							<div className="map-topline">
								<div className="map-scope">
									<MapIcon name="pin" />
									{regionLabel}
									<span className="muted">
										{view === "home"
											? m("mapHomeScope")
											: m(view === "saved" ? "mapSavedScope" : "mapScope", { n: mapRows.length })}
									</span>
								</div>
								<div className="map-pill">
									<MapIcon name="compass" />
									{m("mapExplore")}
								</div>
							</div>
							<div className="map-tools">
								<div className="tool-group">
									<button
										type="button"
										aria-label={m("zoomIn")}
										disabled={zoom >= 1.45}
										onClick={() => setZoom((current) => Math.min(1.45, Number((current + 0.1).toFixed(2))))}
									>
										+
									</button>
									<button
										type="button"
										aria-label={m("zoomOut")}
										disabled={zoom <= 0.85}
										onClick={() => setZoom((current) => Math.max(0.85, Number((current - 0.1).toFixed(2))))}
									>
										−
									</button>
								</div>
								<div className="tool-group">
									<button type="button" aria-label={m("resetMap")} onClick={() => setZoom(1)}>
										<MapIcon name="target" />
									</button>
								</div>
							</div>
							<div className="map-footer">
								<span className="map-scale">{m("scale")}</span>
								<span className="map-demo">{m("mapDemo")}</span>
							</div>
							{view === "home" ? (
								<div className="map-inspiration">
									<div className="inspiration-top">
										<strong>{m("inspirationTitle")}</strong>
										<span>{m("inspirationDescription")}</span>
									</div>
									<div className="inspiration-cards">
										{topics.map((topic) => (
											<button
												key={topic.category}
												type="button"
												className="inspiration-card"
												onClick={() => chooseCategory(topic.category)}
											>
												<img src={artPaths[topic.art]} alt="" draggable={false} />
												<span className="caption">
													{m(topic.inspiration)}
													<small>{m(topic.caption)}</small>
												</span>
											</button>
										))}
									</div>
								</div>
							) : (
								selectedPlace &&
								!hasDetail && (
									<div className="map-floating-place">
										<div className="floating-art">{art(selectedPlace)}</div>
										<div>
											<strong>{copy.place(selectedPlace.id).name}</strong>
											<small>{copy.place(selectedPlace.id).tags.slice(0, 2).join(" · ")}</small>
										</div>
										<button
											type="button"
											className="open-floating"
											aria-label={m("viewDetail", { name: copy.place(selectedPlace.id).name })}
											onClick={(event) => openDetail(selectedPlace, event.currentTarget)}
										>
											{m("detail")}
											<MapIcon name="chevron" />
										</button>
									</div>
								)
							)}
							{comparisonIds.length > 0 && !hasDetail && (
								<div className="compare-tray">
									<MapIcon name="compare" />
									<small>{m("comparePlaces")}</small>
									{comparisonIds.map((id, index) => (
										<button
											key={id}
											type="button"
											className="compare-slot"
											aria-label={m("removeComparePlace", { name: copy.place(id).name })}
											title={copy.place(id).name}
											onClick={() => comparePlace(id)}
										>
											{index + 1}
										</button>
									))}
									<small>
										{comparisonIds.length} / {MAX_COMPARE_PLACES}
									</small>
									<button
										type="button"
										className="compare-btn"
										disabled={comparisonIds.length < 2}
										title={comparisonIds.length < 2 ? m("compareNeedTwo") : undefined}
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
									aria-label={m("detailLabel", { name: copy.place(detailPlace.id).name })}
								>
									<div className="detail-scroll">
										<div className="detail-art">
											{art(detailPlace)}
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
											<p className="detail-eyebrow">{m("detailEyebrow")}</p>
											<h2 className="detail-title">{copy.place(detailPlace.id).name}</h2>
											<p className="detail-sub">
												{m(categoryCopy[detailPlace.type])} · {copy.region(detailPlace.area)} ·{" "}
												{price(detailPlace)}
											</p>
											<div className="place-tags">
												{copy.place(detailPlace.id).tags.map((tag) => (
													<span key={tag} className="place-tag">
														{tag}
													</span>
												))}
											</div>
											<div className="detail-why">
												<strong>
													<MapIcon name="sparkle" />
													{m("why")}
												</strong>
												<p>{copy.place(detailPlace.id).why}</p>
											</div>
											<div className="detail-section">
												<h3>{m("understand")}</h3>
												<div className="detail-info">
													<MapIcon name="pin" />
													<span>
														<b>{copy.place(detailPlace.id).address}</b>
														{m("positionDemo")}
													</span>
												</div>
												<div className="detail-info">
													<MapIcon name="wallet" />
													<span>
														<b>{copy.place(detailPlace.id).budget}</b>
														{m("budgetDemo")}
													</span>
												</div>
												<div className="detail-info">
													<MapIcon name={detailPlace.plug ? "plug" : "tree"} />
													<span>
														<b>{copy.place(detailPlace.id).seat}</b>
														{m(detailPlace.plug ? "plugDemo" : "plugUnknown")}
													</span>
												</div>
												<div className="detail-info">
													<MapIcon name="clock" />
													<span>
														<b>
															{m("hours")} · {copy.place(detailPlace.id).hours}
														</b>
														{m("hoursDemo")}
													</span>
												</div>
											</div>
											<button type="button" className="detail-ask" onClick={() => askPlace(detailPlace)}>
												<MapIcon name="chat" />
												{m("detailAsk")}
												<span className="spacer" />
												<MapIcon name="chevron" />
											</button>
											<p className="detail-note">{m("detailNote")}</p>
										</div>
									</div>
									<div className="detail-actions">
										<button
											type="button"
											aria-pressed={savedState.favorites.includes(detailPlace.id)}
											onClick={() => savePlace(detailPlace.id)}
										>
											<MapIcon name="bookmark" />
											{m(savedState.favorites.includes(detailPlace.id) ? "saved" : "save")}
										</button>
										<button
											type="button"
											className="primary"
											aria-pressed={comparisonIds.includes(detailPlace.id)}
											onClick={() => comparePlace(detailPlace.id)}
										>
											<MapIcon name="compare" />
											{m(comparisonIds.includes(detailPlace.id) ? "removeCompare" : "addCompare")}
										</button>
									</div>
								</aside>
							)}
						</section>
					</div>
				</div>
				{comparisonOpen && (
					<div
						className="compare-overlay"
						onClick={(event) => {
							if (event.currentTarget === event.target) closeComparison();
						}}
					>
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
													<div className="mini-art">{art(place)}</div>
													{copy.place(place.id).name}
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
								<p className="compare-advice">
									<b>{m("compareAdviceTitle")}</b>
									<br />
									{comparisonAdvice()}
								</p>
								<p className="detail-note">{m("detailNote")}</p>
							</div>
							<div className="dialog-footer">
								<button type="button" onClick={closeComparison}>
									{m("continueBrowse")}
								</button>
								<button
									type="button"
									className="primary"
									onClick={() => {
										closeComparison();
										showToast(comparisonAdvice());
									}}
								>
									{m("chooseDemo")}
								</button>
							</div>
						</section>
					</div>
				)}
			</main>
			{toast && active && (
				<div className="owl-product-toast" role="status">
					{toast}
				</div>
			)}
		</div>
	);
}
