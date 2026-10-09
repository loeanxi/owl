import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "owl-pool";
import { afterAll, describe, expect, it } from "vitest";
import { CodexChatClient } from "../src/gateway/codex-client.ts";

const root = mkdtempSync(join(tmpdir(), "owl-codex-spawn-failure-"));
const home = join(root, "account");
mkdirSync(home);
const account: Account = {
	id: "codex-missing-executable",
	name: "Codex missing executable",
	platform: "CODEX",
	credentials: { codexHome: home },
	enabled: true,
	createdAt: 0,
	updatedAt: 0,
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("codex app-server spawn failure", () => {
	it("fails the request instead of crashing the pool when the executable is missing", async () => {
		const client = new CodexChatClient({
			homeRoot: root,
			executable: join(root, "owl-missing-codex.exe"),
			timeoutMs: 5_000,
		});
		const started = Date.now();
		await expect(client.ping(account)).rejects.toMatchObject({ kind: "SERVER" });
		expect(Date.now() - started).toBeLessThan(4_000);
	});
});
