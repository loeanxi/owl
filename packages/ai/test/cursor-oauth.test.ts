import { expect, it, vi } from "vitest";

it("cursor OAuth exports subscription login/refresh/toAuth", async () => {
	const { cursorOAuth } = await import("../src/auth/oauth/cursor.ts");
	expect(cursorOAuth.name).toBe("Cursor");
	expect(cursorOAuth.isSubscription).toBe(true);
	expect(typeof cursorOAuth.login).toBe("function");
	expect(typeof cursorOAuth.refresh).toBe("function");

	const auth = await cursorOAuth.toAuth({
		type: "oauth",
		access: "test-access",
		refresh: "test-refresh",
		expires: Date.now() + 60_000,
	});
	expect(auth).toEqual({ apiKey: "test-access" });
});

it("cursor provider is registered among builtins", async () => {
	const { builtinProviders } = await import("../src/providers/all.ts");
	const providers = builtinProviders();
	const cursor = providers.find((provider) => provider.id === "cursor");
	expect(cursor).toBeDefined();
	expect(cursor?.auth.oauth?.isSubscription).toBe(true);
	expect(cursor?.getModels().length).toBeGreaterThan(0);
	expect(cursor?.getModels()[0]?.api).toBe("cursor-native");
});

it("loadCursorOAuth resolves the flow module", async () => {
	vi.resetModules();
	const { loadCursorOAuth } = await import("../src/auth/oauth/load.ts");
	const flow = await loadCursorOAuth();
	expect(flow.isSubscription).toBe(true);
	expect(flow.name).toBe("Cursor");
});
