import { normPath } from "./utils/paths.ts";

/** 用户所在的一屏：主区、设置页、当前会话、项目。 */
export interface AppPlace {
	rail: "chat" | "map" | "news" | "mail" | "evaluation" | "media" | "research" | "guide";
	settings: boolean;
	settingsTab: "general" | "models" | "about";
	chatSession?: string;
	researchSession?: string;
	workspace: string;
}

export interface AppHistory {
	back: AppPlace[];
	forward: AppPlace[];
	current: AppPlace;
}

const MAX_PLACES = 50;

export function samePlace(a: AppPlace, b: AppPlace): boolean {
	return a.rail === b.rail
		&& a.settings === b.settings
		&& a.settingsTab === b.settingsTab
		&& a.chatSession === b.chatSession
		&& a.researchSession === b.researchSession
		&& normPath(a.workspace) === normPath(b.workspace);
}

/** 空白会话被真正创建出来时，只补上 id，不当成用户又走了一步。 */
function isSessionFill(prev: AppPlace, next: AppPlace): boolean {
	if (prev.rail !== next.rail || prev.settings !== next.settings || prev.settingsTab !== next.settingsTab) return false;
	if (normPath(prev.workspace) !== normPath(next.workspace)) return false;
	const chatFilled = prev.chatSession === undefined && next.chatSession !== undefined && prev.researchSession === next.researchSession;
	const researchFilled = prev.researchSession === undefined && next.researchSession !== undefined && prev.chatSession === next.chatSession;
	return chatFilled || researchFilled;
}

export function recordPlace(history: AppHistory, next: AppPlace): AppHistory {
	if (samePlace(history.current, next)) return history;
	if (isSessionFill(history.current, next)) return { ...history, current: next };
	return {
		back: [...history.back, history.current].slice(-MAX_PLACES),
		forward: [],
		current: next,
	};
}

export function stepBack(history: AppHistory): { history: AppHistory; place: AppPlace } | undefined {
	const place = history.back[history.back.length - 1];
	if (!place) return undefined;
	return {
		place,
		history: {
			back: history.back.slice(0, -1),
			forward: [history.current, ...history.forward].slice(0, MAX_PLACES),
			current: place,
		},
	};
}

export function stepForward(history: AppHistory): { history: AppHistory; place: AppPlace } | undefined {
	const place = history.forward[0];
	if (!place) return undefined;
	return {
		place,
		history: {
			back: [...history.back, history.current].slice(-MAX_PLACES),
			forward: history.forward.slice(1),
			current: place,
		},
	};
}
