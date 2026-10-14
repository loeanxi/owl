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
		const canApply = (): boolean => !disposed && activeProfile.current === normalizedProfile && restoreGate.canApply(token);
		void callbacks.current.restore(saved, canApply).then(() => {
			if (!canApply()) return;
			scroll.current = saved?.scroll ?? {};
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
		const startedAt = Date.now();
		const applied = new WeakMap<HTMLElement, string>();
		const save = (): void => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			writeWorkspaceMemory(localStorage, normalizedProfile, { ...current.current, version: 1, savedAt: Date.now(), scroll: scroll.current });
		};
		const visibleSurfaces = (): Array<{ element: HTMLElement; key: string }> => SCROLL_SURFACES.flatMap(([surface, selector]) =>
			[...document.querySelectorAll<HTMLElement>(selector)]
				.filter((element) => element.clientWidth > 0 && element.clientHeight > 0)
				.map((element) => ({ element, key: workspaceScrollKey(current.current, surface) })),
		);
		const restoreScroll = (): void => {
			frame = 0;
			for (const { element, key } of visibleSurfaces()) {
				if (applied.get(element) === key) continue;
				const saved = scroll.current[key];
				if (saved) {
					const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
					if (!saved.atBottom && saved.top > maxTop + 1 && Date.now() - startedAt < 3000) continue;
					element.scrollTop = saved.atBottom ? maxTop : Math.min(saved.top, maxTop);
					element.scrollLeft = saved.left;
					// ChatStream must also turn off follow-latest when restoring history reading.
					element.dispatchEvent(new Event("scroll"));
				}
				applied.set(element, key);
			}
		};
		const scheduleScrollRestore = (): void => {
			if (!frame) frame = requestAnimationFrame(restoreScroll);
		};
		const onScroll = (event: Event): void => {
			for (const { element, key } of visibleSurfaces()) {
				if (event.target !== element || applied.get(element) !== key) continue;
				scroll.current = { ...scroll.current, [key]: { top: element.scrollTop, left: element.scrollLeft, atBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 24 } };
				if (timer) clearTimeout(timer);
				timer = setTimeout(save, 160);
			}
		};
		const keepUserScroll = (): void => {
			for (const { element, key } of visibleSurfaces()) applied.set(element, key);
		};
		const mutations = new MutationObserver(scheduleScrollRestore);
		const root = document.querySelector(".owl-workspace-frame");
		if (root) mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden"] });
		document.addEventListener("scroll", onScroll, true);
		document.addEventListener("wheel", keepUserScroll, { passive: true });
		window.addEventListener("pagehide", save);
		window.addEventListener("beforeunload", save);
		scheduleScrollRestore();
		const settle = setTimeout(scheduleScrollRestore, 3100);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(settle);
			mutations.disconnect();
			document.removeEventListener("scroll", onScroll, true);
			document.removeEventListener("wheel", keepUserScroll);
			window.removeEventListener("pagehide", save);
			window.removeEventListener("beforeunload", save);
			save();
		};
	}, [normalizedProfile, readyProfile, placeSignature]);
}
