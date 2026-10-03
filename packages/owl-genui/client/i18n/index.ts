/**
 * i18n public face: the translate function and the React binding. owl 桌面端
 * 通过 setLocale 跟随设置页的界面语言（uiLanguage）。
 *
 * @module i18n
 */
import { useSyncExternalStore } from "react";
import { getLocale, getLocaleRevision, type LocaleId, subscribeLocale, t } from "./runtime.ts";

export {
	detectLocale,
	dictOf,
	FALLBACK_LOCALE,
	type GenuiTextKey,
	getLocale,
	getLocaleRevision,
	LOCALE_IDS,
	type LocaleDict,
	type LocaleId,
	normalizeLocale,
	setLocale,
	subscribeLocale,
	t,
} from "./runtime.ts";

/**
 * Subscribe a component to locale changes.
 *
 * Returns the translate function itself (stable identity — `t` reads the
 * active locale at call time), so a component calls `const t = useT()` and
 * re-renders whenever the language switches.
 */
export function useT(): typeof t {
	useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision);
	return t;
}

/**
 * Subscribe to locale changes and return the current revision.
 *
 * `t` keeps a STABLE identity on purpose (so it can ride inject surfaces
 * without breaking memoization), which means it cannot serve as a `useMemo`
 * dependency. Use this revision instead when a memoized value embeds
 * translated text.
 */
export function useLocaleRevision(): number {
	return useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision);
}

/** The minimal shape this package needs from the host locale runtime. */
export interface HostLocaleRuntime {
	getLocale?: () => { active?: string };
	subscribe?: (fn: () => void) => () => void;
	register?: (ns: string, locale: string, dict: Record<string, string>) => () => void;
}

/** Current locale id, for non-React call sites. */
export function currentLocale(): LocaleId {
	return getLocale();
}
