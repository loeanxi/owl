export type PlaceId = "liubai" | "muchuang" | "qingshi" | "shangu" | "museum" | "park";
export type PlaceType = "cafe" | "park" | "museum";
export type PlaceArt = "cafe1" | "cafe2" | "cafe3" | "museum" | "park";
export type MapRegion = "all" | "西湖区" | "湖滨" | "武林";
export type PlaceFilter = "quiet" | "plug" | "budget" | "lake";
export type PlaceSort = "recommended" | "price";

/** Fictional places for the local map experience; these are not verified business listings. */
export interface Place {
	id: PlaceId;
	name: string;
	type: PlaceType;
	art: PlaceArt;
	area: Exclude<MapRegion, "all">;
	price: number;
	quiet: boolean;
	plug: boolean;
	lake: boolean;
	tags: readonly string[];
	x: number;
	y: number;
	reason: string;
	address: string;
	env: string;
	hours: string;
	seat: string;
	budget: string;
	why: string;
	fictional: true;
}

export const DEMO_PLACES: readonly Place[] = [
	{
		id: "liubai",
		name: "湖畔留白",
		type: "cafe",
		art: "cafe1",
		area: "湖滨",
		price: 42,
		tags: ["安静座位", "有插座", "靠近西湖"],
		quiet: true,
		plug: true,
		lake: true,
		x: 61,
		y: 42,
		reason: "窗边桌面宽敞，适合带电脑坐一下午。",
		address: "杭州 · 湖滨片区",
		env: "明亮窗边 · 较安静",
		hours: "10:00–20:00",
		seat: "窗边长桌与双人桌",
		budget: "咖啡 ¥32–48",
		why: "窗边长桌、有插座座位和适中的示例预算，适合带电脑停留。",
		fictional: true,
	},
	{
		id: "muchuang",
		name: "木窗咖啡",
		type: "cafe",
		art: "cafe2",
		area: "武林",
		price: 36,
		tags: ["安静座位", "有插座", "木质空间"],
		quiet: true,
		plug: true,
		lake: false,
		x: 78,
		y: 26,
		reason: "木质空间与独立桌位，适合专注一会儿。",
		address: "杭州 · 武林片区",
		env: "木质暖光 · 安静",
		hours: "09:30–21:00",
		seat: "独立小桌与吧台",
		budget: "咖啡 ¥28–42",
		why: "独立桌位便于专注，示例预算较低，但它距离湖边更远。",
		fictional: true,
	},
	{
		id: "qingshi",
		name: "青石慢焙",
		type: "cafe",
		art: "cafe3",
		area: "湖滨",
		price: 48,
		tags: ["靠近西湖", "露台座位", "手冲咖啡"],
		quiet: false,
		plug: false,
		lake: true,
		x: 53,
		y: 60,
		reason: "适合散步后喝杯咖啡，露台可以看看湖。",
		address: "杭州 · 湖滨片区",
		env: "湖边露台 · 较热闹",
		hours: "10:30–19:00",
		seat: "露台圆桌与室内吧台",
		budget: "咖啡 ¥38–58",
		why: "湖边露台适合休闲和散步；示例未提供插座，办公可以先比较其他地点。",
		fictional: true,
	},
	{
		id: "shangu",
		name: "山谷咖啡",
		type: "cafe",
		art: "cafe1",
		area: "西湖区",
		price: 58,
		tags: ["安静座位", "有插座", "绿植环绕"],
		quiet: true,
		plug: true,
		lake: false,
		x: 25,
		y: 27,
		reason: "绿植与宽敞桌位，适合长时间阅读。",
		address: "杭州 · 西湖区山麓片区",
		env: "绿植空间 · 安静",
		hours: "10:00–18:30",
		seat: "多人长桌与独立桌",
		budget: "咖啡 ¥45–68",
		why: "桌位和安静程度适合阅读，但示例参考预算高于 ¥50。",
		fictional: true,
	},
	{
		id: "museum",
		name: "青禾艺术馆",
		type: "museum",
		art: "museum",
		area: "西湖区",
		price: 0,
		tags: ["室内展览", "建筑空间", "周末灵感"],
		quiet: true,
		plug: false,
		lake: true,
		x: 40,
		y: 35,
		reason: "从建筑和展览中找一点新的灵感。",
		address: "杭州 · 西湖区",
		env: "室内展厅 · 适合慢逛",
		hours: "10:00–17:00",
		seat: "休息区座位",
		budget: "示例展览免费",
		why: "这座示意艺术馆适合慢慢逛，也适合安排在半天散步中。",
		fictional: true,
	},
	{
		id: "park",
		name: "湖西绿径",
		type: "park",
		art: "park",
		area: "西湖区",
		price: 0,
		tags: ["湖边散步", "绿荫步道", "户外休闲"],
		quiet: true,
		plug: false,
		lake: true,
		x: 30,
		y: 73,
		reason: "沿着绿荫和湖岸走走，给下午留一点空白。",
		address: "杭州 · 西湖区",
		env: "湖边绿荫 · 户外空间",
		hours: "全天开放",
		seat: "沿途公共长椅",
		budget: "无需门票",
		why: "这条示意绿径适合轻松散步，也可以与咖啡馆组成半天安排。",
		fictional: true,
	},
];

export const MAP_REGIONS: readonly MapRegion[] = ["all", "西湖区", "湖滨", "武林"];
export const MAX_COMPARE_PLACES = 3;
export const MAX_SEARCH_HISTORY = 12;
export const MAX_QUERY_LENGTH = 200;
export const MAP_STORAGE_KEY = "owl.map.demo.v1";

export interface SearchScope {
	category: PlaceType;
	region: MapRegion;
	filters: ReadonlySet<PlaceFilter>;
	sort: PlaceSort;
	query: string;
	unsupported: boolean;
	placeId?: PlaceId;
}

export const DEFAULT_SEARCH: SearchScope = {
	category: "cafe",
	region: "all",
	filters: new Set(),
	sort: "recommended",
	query: "",
	unsupported: false,
};

const ENGLISH_PLACE_NAMES: Record<PlaceId, string> = {
	liubai: "Lakeside Pause",
	muchuang: "Timber Window Cafe",
	qingshi: "Bluestone Slow Roast",
	shangu: "Valley Cafe",
	museum: "Greenfield Art House",
	park: "West Lake Green Trail",
};

/** Recognizes a small set of demo queries. It does not make an AI or location-service request. */
export function parseMapQuery(text: string, current?: SearchScope): SearchScope {
	const query = text.trim().slice(0, MAX_QUERY_LENGTH);
	const previous = current ?? DEFAULT_SEARCH;
	const filters = new Set<PlaceFilter>(current?.filters);
	const normalized = query.toLowerCase();
	const place = DEMO_PLACES.find(
		(candidate) =>
			query.includes(candidate.name) || normalized.includes(ENGLISH_PLACE_NAMES[candidate.id].toLowerCase()),
	);
	const explicitCategory = /展览|看展|艺术|博物|\b(?:museum|exhibitions?|gallery|art)\b/i.test(query)
		? "museum"
		: /散步|公园|走走|步道|\b(?:parks?|trails?|walk(?:s|ing)?)\b/i.test(query)
			? "park"
			: /咖啡|\b(?:coffee|cafes?)\b/i.test(query)
				? "cafe"
				: undefined;
	const quiet = /安静|静一点|\bquiet(?:er)?\b/i.test(query);
	const plug = /插座|电脑|办公|\b(?:plugs?|sockets?|outlets?|laptop|work(?:ing)?)\b/i.test(query);
	const budget = /(?:^|[^\d])50(?:[^\d]|$)|五十|便宜|低一点|\b(?:cheap(?:er)?|affordable)\b/i.test(query);
	const lake = /湖边|靠湖|临湖|只看.*湖|限定.*湖|只要.*湖|\blakeside\b|\b(?:by|near) (?:the |west )?lake\b/i.test(
		query,
	);
	const region = /不限区域|整个杭州|全杭州|\ball (?:areas|hangzhou)\b/i.test(query)
		? "all"
		: /湖滨|\bhubin\b/i.test(query)
			? "湖滨"
			: /武林|\bwulin\b/i.test(query)
				? "武林"
				: /西湖区|\bwest lake district\b/i.test(query)
					? "西湖区"
					: previous.region;
	const known = Boolean(
		place ||
			explicitCategory ||
			quiet ||
			plug ||
			budget ||
			lake ||
			/西湖|湖滨|武林|不限区域|整个杭州|全杭州|\bwest lake\b|\ball areas\b/i.test(query),
	);
	const unsupportedCategory =
		/餐厅|餐馆|饭店|酒店|宾馆|住宿|商场|电影院|医院|药店|\b(?:restaurants?|hotels?|shopping|cinema|hospital|pharmacy)\b/i.test(
			query,
		);
	const unsupportedLocation =
		/上海|北京|广州|深圳|成都|南京|苏州|台北|臺北|重庆|重慶|纽约|东京|東京|\b(?:shanghai|beijing|taipei|tokyo|new york|london)\b/i.test(
			query,
		);
	const budgetAmount =
		/(?:预算|价格|budget(?:\s+(?:under|below|of|less than))?|under|below|[¥￥])\s*[¥￥]?\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:元|块|以下|以内|内)/i.exec(
			query,
		);
	const unsupportedBudget = Boolean(budgetAmount && Number(budgetAmount[1] ?? budgetAmount[2]) !== 50);
	const category = place?.type ?? explicitCategory ?? previous.category;
	if ((place || explicitCategory) && category !== previous.category) filters.clear();
	if (quiet) filters.add("quiet");
	if (plug) filters.add("plug");
	if (budget) filters.add("budget");
	if (lake) filters.add("lake");
	return {
		category,
		region,
		filters,
		sort: previous.sort,
		query,
		unsupported: !query || !known || unsupportedCategory || unsupportedLocation || unsupportedBudget,
		...(place ? { placeId: place.id } : {}),
	};
}

export function getSearchResults(scope: SearchScope): Place[] {
	if (scope.unsupported) return [];
	const rows = DEMO_PLACES.filter(
		(place) =>
			place.type === scope.category &&
			(scope.region === "all" || place.area === scope.region) &&
			(!scope.placeId || place.id === scope.placeId) &&
			(!scope.filters.has("quiet") || place.quiet) &&
			(!scope.filters.has("plug") || place.plug) &&
			(!scope.filters.has("budget") || place.price <= 50) &&
			(!scope.filters.has("lake") || place.lake),
	);
	if (scope.sort === "price") rows.sort((a, b) => a.price - b.price);
	return rows;
}

export function getFavoriteResults(ids: readonly string[], region: MapRegion = "all"): Place[] {
	return DEMO_PLACES.filter((place) => ids.includes(place.id) && (region === "all" || place.area === region));
}

/** Keeps the selected place while it remains visible; empty results never retain a stale detail. */
export function keepVisibleSelection(rows: readonly Place[], currentId?: string): PlaceId | undefined {
	return rows.find((place) => place.id === currentId)?.id ?? rows[0]?.id;
}

export function isPlaceId(id: unknown): id is PlaceId {
	return typeof id === "string" && DEMO_PLACES.some((place) => place.id === id);
}

export function toggleFavorite(ids: readonly string[], id: string): PlaceId[] {
	const valid = [...new Set(ids.filter(isPlaceId))];
	if (!isPlaceId(id)) return valid;
	return valid.includes(id) ? valid.filter((existing) => existing !== id) : [...valid, id];
}

export interface CompareChange {
	ids: PlaceId[];
	status: "added" | "removed" | "full" | "invalid";
}

export function toggleCompare(ids: readonly string[], id: string): CompareChange {
	const valid = [...new Set(ids.filter(isPlaceId))].slice(0, MAX_COMPARE_PLACES);
	if (!isPlaceId(id)) return { ids: valid, status: "invalid" };
	if (valid.includes(id)) return { ids: valid.filter((existing) => existing !== id), status: "removed" };
	if (valid.length >= MAX_COMPARE_PLACES) return { ids: valid, status: "full" };
	return { ids: [...valid, id], status: "added" };
}

export interface MapSavedState {
	favorites: PlaceId[];
	history: string[];
}

export interface MapStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function addSearchHistory(history: readonly string[], query: string): string[] {
	const entry = query.trim().slice(0, MAX_QUERY_LENGTH);
	const entries = history.map((item) => item.trim().slice(0, MAX_QUERY_LENGTH)).filter(Boolean);
	return [...new Set(entry ? [entry, ...entries] : entries)].slice(0, MAX_SEARCH_HISTORY);
}

export function parseMapSavedState(raw: string | null): MapSavedState {
	const empty: MapSavedState = { favorites: [], history: [] };
	if (!raw) return empty;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
		const record = value as Record<string, unknown>;
		if (record.version !== 1) return empty;
		const favorites = Array.isArray(record.favorites) ? [...new Set(record.favorites.filter(isPlaceId))] : [];
		const history = Array.isArray(record.history)
			? addSearchHistory(
					record.history.filter((item): item is string => typeof item === "string"),
					"",
				)
			: [];
		return { favorites, history };
	} catch {
		return empty;
	}
}

/** Storage failures are recoverable: the caller can retain its in-memory selections and show an error. */
export function readMapSavedState(storage: Pick<MapStorage, "getItem">): MapSavedState {
	try {
		return parseMapSavedState(storage.getItem(MAP_STORAGE_KEY));
	} catch {
		return { favorites: [], history: [] };
	}
}

export function writeMapSavedState(storage: Pick<MapStorage, "setItem">, state: MapSavedState): boolean {
	try {
		const favorites = [...new Set(state.favorites.filter(isPlaceId))];
		const history = addSearchHistory(state.history, "");
		storage.setItem(MAP_STORAGE_KEY, JSON.stringify({ version: 1, favorites, history }));
		return true;
	} catch {
		return false;
	}
}
