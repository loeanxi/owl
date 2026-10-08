import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("ordinary request output budget", () => {
	it("defaults to 16384 and accepts explicit higher budgets", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getRequestMaxTokens()).toBe(16384);
		manager.applyOverrides({ requestMaxTokens: 128000 });
		expect(manager.getRequestMaxTokens()).toBe(128000);
	});

	it("resolves project overrides and ignores them for untrusted projects", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ requestMaxTokens: 16384 }));
		storage.withLock("project", () => JSON.stringify({ requestMaxTokens: 32768 }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getRequestMaxTokens()).toBe(32768);
		manager.setProjectTrusted(false);
		expect(manager.getRequestMaxTokens()).toBe(16384);
	});

	it("persists a budget through the ordinary settings update path", async () => {
		const manager = SettingsManager.inMemory();
		manager.applyGlobalOverridesAndSave({ requestMaxTokens: 32768 });
		await manager.flush();
		await manager.reload();
		expect(manager.getRequestMaxTokens()).toBe(32768);
	});

	it.each([null, 0, -1, 1.5, "16384", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
		"rejects malformed budgets: %j",
		(value) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ requestMaxTokens: value }));
			expect(() => SettingsManager.fromStorage(storage).getRequestMaxTokens()).toThrow(
				"Invalid requestMaxTokens setting",
			);
		},
	);
});
