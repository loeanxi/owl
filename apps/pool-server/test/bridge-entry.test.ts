import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Account } from "owl-pool";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { resolveSdkBridgeScript } from "../src/gateway/sdk-bridge-entry.ts";
import { SdkRuntimeClient } from "../src/gateway/sdk-runtime.ts";

describe("bundled SDK bridge entry", () => {
	it("resolves the default entry from src and dist even with an unrelated working directory", () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const expected = resolve(root, "bridge/main.mjs");
		for (const entry of ["src/index.ts", "dist/main.js"]) {
			const url = new URL(entry, new URL("../", import.meta.url)).href;
			expect(resolveSdkBridgeScript(loadConfig({}).gateway.bridge.script, url, tmpdir())).toBe(expected);
		}
	});

	it("does not replace an explicitly configured missing script with a different bridge", () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		expect(resolveSdkBridgeScript("custom/missing.mjs", new URL("../src/index.ts", import.meta.url).href, root)).toBe(
			resolve(root, "custom/missing.mjs"),
		);
	});
	it("initializes the shipped bridge from the default pool-server configuration", async () => {
		const home = mkdtempSync(resolve(tmpdir(), "owl-bridge-entry-"));
		const config = loadConfig({});
		const packageRoot = fileURLToPath(new URL("../", import.meta.url));
		const account: Account = {
			id: "bridge-entry-test",
			name: "bridge entry test",
			platform: "QODER",
			credentials: {},
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
		};
		let client: SdkRuntimeClient | undefined;
		try {
			client = await SdkRuntimeClient.create({
				nodeExecutable: process.execPath,
				script: resolve(packageRoot, config.gateway.bridge.script),
				platform: "QODER",
				account,
				accountHome: home,
				credentials: {},
				userHome: home,
				initializeTimeoutMs: 5_000,
			});
			expect(client.isAlive()).toBe(true);
		} finally {
			if (client?.isAlive()) {
				await client.request("shutdown", {}, 3_000);
				const deadline = Date.now() + 3_000;
				while (client.isAlive() && Date.now() < deadline) {
					await new Promise<void>((finish) => setTimeout(finish, 25));
				}
			}
			client?.close();
			rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
