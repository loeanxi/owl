import { useEffect, useRef, useState } from "react";
import { normPath } from "./utils/paths.ts";
import { readWorkspaceMemory, workspaceScrollKey, WorkspaceRestoreGate, writeWorkspaceMemory, type WorkspaceMemory, type WorkspaceScrollPosition } from "./workspace-memory.ts";

type WorkspacePlace = Omit<WorkspaceMemory, "version" | "savedAt" | "scroll">;

const SCROLL_SURFACES = [
	["chat", ".owl-chat-scroll"],
	["trajectory", ".owl-trajectory-ledger"],
	["context", ".ctx-root"],
	["settings", ".owl-settings-content"],
	["sidebar", ".owl-sidebar-list"],
] as const;

/** Save actual navigation as it happens; shutdown handlers are only a final flush. */
export function useWorkspaceMemory({ profile, connected, place, restore, cancelRestore }: {
	profile?: string;
	connected: boolean;
	place: WorkspacePlace;
	restore: (snapshot: WorkspaceMemory | undefined, canApply: () => boolean) => Promise<void>;
	cancelRestore: () => void;
}): void {
	const normalizedProfile = profile ? normPath(profile) : undefined;
	const gate = useRef(new WorkspaceRestoreGate());
	const activeProfile = useRef<string | undefined>(undefined);
	const [readyProfile, setReadyProfile] = useState<string>();
	const scroll = useRef<Record<string, WorkspaceScrollPosition>>({});
	const current = useRef(place);
	current.current = place;
	const callbacks = useRef({ restore, cancelRestore });
	callbacks.current = { restore, cancelRestore };
	const placeSignature = JSON.stringify(place);

	useEffect(() => {
		const interrupt = (): void => {
			if (gate.current.canSave()) return;
			gate.current.markUserNavigation();
			callbacks.current.cancelRestore();
			if (activeProfile.current) setReadyProfile(activeProfile.current);
		};
		document.addEventListener("pointerdown", interrupt, true);
		document.addEventListener("keydown", interrupt, true);
		return () => {
			document.removeEventListener("pointerdown", interrupt, true);
			document.removeEventListener("keydown", interrupt, true);
		};
	}, []);

	useEffect(() => {
		if (!normalizedProfile || !connected) return;
		if (activeProfile.current !== normalizedProfile) {
			if (activeProfile.current) gate.current = new WorkspaceRestoreGate();
			activeProfile.current = normalizedProfile;
			scroll.current = {};
		}
		const restoreGate = gate.current;
		const token = restoreGate.begin();
		if (!token) {
			if (restoreGate.canSave()) setReadyProfile(normalizedProfile);
			return;
		}
		let disposed = false;
		const saved = readWorkspaceMemory(localStorage, normalizedProfile);
		// Navigation may cancel hydration. Keep all saved reading positions in that case.
		scroll.current = saved?.scroll ?? {};
		const canApply = (): boolean => !disposed && activeProfile.current === normalizedProfile && restoreGate.canApply(token);
		void callbacks.current.restore(saved, canApply).then(() => {
			if (!canApply()) return;
			restoreGate.finish(token);
			setReadyProfile(normalizedProfile);
		}).catch(() => {
			// Preserve the saved location while offline; reconnect retries the same restore.
			restoreGate.retry(token);
		});
		return () => {
			disposed = true;
			restoreGate.retry(token);
		};
	}, [normalizedProfile, connected]);

	useEffect(() => {
		if (!normalizedProfile || readyProfile !== normalizedProfile || !gate.current.canSave()) return;
		writeWorkspaceMemory(localStorage, normalizedProfile, { ...current.current, version: 1, savedAt: Date.now(), scroll: scroll.current });
	}, [normalizedProfile, readyProfile, placeSignature]);

	useEffect(() => {
		if (!normalizedProfile || readyProfile !== normalizedProfile) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let frame = 0;
		let disposed = false;
		const startedAt = Date.now();
		const applied = new WeakMap<HTMLElement, string>();
		const observed = new WeakSet<HTMLElement>();
		const save = (): void => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			// Cleanup belongs to this place/profile even after the next render has begun.
			writeWorkspaceMemory(localStorage, normalizedProfile, { ...place, version: 1, savedAt: Date.now(), scroll: scroll.current });
		};
		const visibleSurfaces = (): Array<{ element: HTMLElement; key: string; surface: string }> => SCROLL_SURFACES.flatMap(([surface, selector]) =>
			[...document.querySelectorAll<HTMLElement>(selector)]
				.filter((element) => element.clientWidth > 0 && element.clientHeight > 0)
				.map((element) => ({ element, key: workspaceScrollKey(place, surface), surface })),
		);
		const restoreScroll = (): void => {
			frame = 0;
			if (disposed) return;
			for (const { element, key, surface } of visibleSurfaces()) {
				for (const node of [element, element.firstElementChild]) {
					if (!(node instanceof HTMLElement) || observed.has(node)) continue;
					observed.add(node);
					resizes.observe(node);
				}
				if (applied.get(element) === key) {
					if (element.hasAttribute("data-owl-scroll-restoring")) {
						element.removeAttribute("data-owl-scroll-restoring");
						element.dispatchEvent(new Event("scroll"));
					}
					continue;
				}
				if (surface === "chat" && element.hasAttribute("data-owl-search-navigation")) {
					applied.set(element, key);
					scroll.current = { ...scroll.current, [key]: { top: element.scrollTop, left: element.scrollLeft, atBottom: false } };
					element.removeAttribute("data-owl-scroll-restoring");
					save();
					continue;
				}
				if (surface === "chat" && element.getAttribute("data-owl-scroll-restoring") !== "true") element.setAttribute("data-owl-scroll-restoring", "true");
				const saved = scroll.current[key];
				if (saved) {
					const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
					if (!saved.atBottom && saved.top > maxTop + 1 && Date.now() - startedAt < 3000) continue;
					element.scrollTop = saved.atBottom ? maxTop : Math.min(saved.top, maxTop);
					element.scrollLeft = saved.left;
				} else if (surface === "chat") element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
				applied.set(element, key);
				element.removeAttribute("data-owl-scroll-restoring");
				// ChatStream follows the restored position, including an explicit search target.
				element.dispatchEvent(new Event("scroll"));
			}
		};
		const scheduleScrollRestore = (): void => {
			if (!disposed && !frame) frame = requestAnimationFrame(restoreScroll);
		};
		const onScroll = (event: Event): void => {
			for (const { element, key } of visibleSurfaces()) {
				if (event.target !== element || applied.get(element) !== key) continue;
				scroll.current = { ...scroll.current, [key]: { top: element.scrollTop, left: element.scrollLeft, atBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 24 } };
				if (timer) clearTimeout(timer);
				timer = setTimeout(save, 160);
			}
		};
		const keepUserScroll = (event: Event): void => {
			if (!(event.target instanceof Node)) return;
			for (const { element, key } of visibleSurfaces()) {
				if (!element.contains(event.target)) continue;
				applied.set(element, key);
				element.removeAttribute("data-owl-scroll-restoring");
			}
		};
		const onSearchNavigation = (event: Event): void => {
			for (const { element, key } of visibleSurfaces()) {
				if (event.target !== element) continue;
				applied.set(element, key);
				element.removeAttribute("data-owl-scroll-restoring");
				scroll.current = { ...scroll.current, [key]: { top: element.scrollTop, left: element.scrollLeft, atBottom: false } };
				save();
			}
		};
		const resizes = new ResizeObserver(scheduleScrollRestore);
		const mutations = new MutationObserver(scheduleScrollRestore);
		const root = document.querySelector(".owl-workspace-frame");
		if (root) mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden", "data-owl-scroll-restoring", "data-owl-search-navigation"] });
		document.addEventListener("scroll", onScroll, true);
		document.addEventListener("wheel", keepUserScroll, { passive: true });
		document.addEventListener("owl-chat-search-navigation", onSearchNavigation);
		window.addEventListener("pagehide", save);
		window.addEventListener("beforeunload", save);
		scheduleScrollRestore();
		const settle = setTimeout(scheduleScrollRestore, 3100);
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			clearTimeout(settle);
			mutations.disconnect();
			resizes.disconnect();
			document.removeEventListener("scroll", onScroll, true);
			document.removeEventListener("wheel", keepUserScroll);
			document.removeEventListener("owl-chat-search-navigation", onSearchNavigation);
			window.removeEventListener("pagehide", save);
			window.removeEventListener("beforeunload", save);
			save();
		};
	}, [normalizedProfile, readyProfile, placeSignature]);
}
