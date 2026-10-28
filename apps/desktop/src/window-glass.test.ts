import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncWindowGlass } from "./window-glass.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(async () => {
	vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
	vi.stubGlobal("document", { documentElement: { dataset: {} } });
	vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
	await syncWindowGlass({ preset: "", glass: "clear" });
	vi.mocked(invoke).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it("keeps startup waiting until the native glass backing is ready", async () => {
	const backing = Promise.withResolvers<void>();
	vi.mocked(invoke).mockReturnValueOnce(backing.promise);
	let ready = false;
	const prepared = Promise.resolve(syncWindowGlass({ preset: "liquid-glass", glass: "acrylic" })).then(() => {
		ready = true;
	});
	await Promise.resolve();
	expect(ready).toBe(false);
	backing.resolve();
	await prepared;
	expect(document.documentElement.dataset.owlWindowGlass).toBe("acrylic");
});

it("shares the native readiness wait when startup effects request the same glass mode again", async () => {
	const backing = Promise.withResolvers<void>();
	vi.mocked(invoke).mockReturnValueOnce(backing.promise);
	const first = syncWindowGlass({ preset: "liquid-glass", glass: "blur" });
	let repeatedReady = false;
	const repeated = syncWindowGlass({ preset: "liquid-glass", glass: "blur" }).then(() => {
		repeatedReady = true;
	});
	await Promise.resolve();
	expect(repeatedReady).toBe(false);
	backing.resolve();
	await Promise.all([first, repeated]);
	expect(document.documentElement.dataset.owlWindowGlass).toBe("blur");
});

it("does not restore a stale glass attribute after switching to an opaque preset", async () => {
	const backing = Promise.withResolvers<void>();
	vi.mocked(invoke).mockReturnValueOnce(backing.promise);
	const first = syncWindowGlass({ preset: "liquid-glass", glass: "acrylic" });
	await syncWindowGlass({ preset: "codex", glass: "clear" });
	backing.resolve();
	await first;
	expect(document.documentElement.dataset.owlWindowGlass).toBeUndefined();
});
