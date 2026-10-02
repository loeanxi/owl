import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("debug plugins migrate", () => {
	const testDir = join(process.cwd(), "test-plugins-debug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".owl"), { recursive: true });
	});
	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("inspects load state", () => {
		const settingsPath = join(agentDir, "settings.json");
		const dbg: string[] = [];
		const fixture = {
			plugins: ["npm:already-there"],
			packages: ["npm:legacy-pkg", { source: "npm:filtered", extensions: ["+dist/index.ts"] }],
			extensions: ["/local/ext.ts"],
		};
		writeFileSync(settingsPath, JSON.stringify(fixture));
		dbg.push(`FILE-BEFORE: ${readFileSync(settingsPath, "utf-8")}`);

		const manager = SettingsManager.create(projectDir, agentDir);
		dbg.push(`GLOBAL: ${JSON.stringify(manager.getGlobalSettings())}`);
		dbg.push(`PACKAGES: ${JSON.stringify(manager.getPackages())}`);
		dbg.push(`EXT: ${JSON.stringify(manager.getExtensionPaths())}`);

		const migrated = manager.migrateLegacyPluginsToPlugins();
		dbg.push(`MIGRATED: ${JSON.stringify(migrated)}`);
		dbg.push(`FILE-AFTER: ${existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "<missing>"}`);
		writeFileSync(join(testDir, "debug1.txt"), dbg.join("\n"));
		expect(true).toBe(true);
	});

	it("inspects setPlugins write", () => {
		const settingsPath = join(agentDir, "settings.json");
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setPlugins(["npm:x"]);
		const out = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "<missing>";
		writeFileSync(join(testDir, "debug2.txt"), `AFTER-SET: ${out}`);
		expect(true).toBe(true);
	});
});
