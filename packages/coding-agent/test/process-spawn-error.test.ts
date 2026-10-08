import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessTool } from "../src/core/tools/process.ts";
import {
	registerSessionProcess,
	terminateSessionProcesses,
	waitSessionProcess,
} from "../src/core/tools/process-store.ts";

let cwd: string;
const owner = "offline-spawn-error-fixture";
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "owl-spawn-error-"));
});
afterEach(async () => {
	terminateSessionProcesses(owner);
	await rm(cwd, { recursive: true, force: true });
});

function failedSpawn() {
	const child = spawn(join(cwd, "does-not-exist-shell"), [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	return registerSessionProcess({ child, sessionId: owner, command: "fixture", cwd, acceptsStdin: true });
}

describe("unified-exec spawn failure", () => {
	it("settles a missing executable without leaving a running ghost", async () => {
		const entry = failedSpawn();
		await expect(waitSessionProcess(entry, 1000)).resolves.toBe("exited");
		expect(entry.exitCode).toBeNull();
		expect(entry.spawnError?.message).toContain("ENOENT");
		expect(entry.spawnError && "code" in entry.spawnError ? entry.spawnError.code : undefined).toBe("ENOENT");
		expect(entry.recent.snapshot().content).toContain("ENOENT");
	});

	it("reports the original failure on process poll without suggesting more waiting", async () => {
		const entry = failedSpawn();
		await waitSessionProcess(entry, 1000);
		const result = await createProcessTool().execute("poll-error", {
			action: "poll",
			session_id: entry.id,
			yield_time_ms: 1000,
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ status: "exited", exit_code: null });
		expect(
			result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("ENOENT");
		expect(
			result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).not.toContain("still running");
	});
});
