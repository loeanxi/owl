export interface DesktopControlInterruption {
	reason: "user-projection-input";
	windowId: string;
}

type Listener = (event: DesktopControlInterruption) => void;
const registryKey = Symbol.for("owl.desktop-control-interruption-listeners");
const registry = globalThis as typeof globalThis & { [registryKey]?: Set<Listener> };
const listeners = registry[registryKey] ?? new Set<Listener>();
registry[registryKey] = listeners;

/** A user operation invalidates agent control before the desktop host delivers it. */
export function interruptDesktopControl(event: DesktopControlInterruption): void {
	for (const listener of [...listeners]) listener(event);
}

export function subscribeDesktopControlInterruption(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
