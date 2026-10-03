import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { type SessionInfo, SessionManager } from "../../src/core/session-manager.ts";

describe("session list custom type metadata", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-custom-types-"));
		cwd = join(tempDir, "project");
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "agent"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists legacy sessions without custom entries without rewriting them", async () => {
		const file = join(tempDir, "legacy.jsonl");
		const content = [
			JSON.stringify({ type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00Z", cwd }),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "Legacy prompt", timestamp: 1 },
			}),
		].join("\n");
		writeFileSync(file, content);

		const current = await SessionManager.list(cwd, tempDir);
		const all = await SessionManager.listAll(tempDir);

		for (const sessions of [current, all]) {
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({ id: "legacy", firstMessage: "Legacy prompt", messageCount: 1 });
			expect(sessions[0]).not.toHaveProperty("customTypes");
		}
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("deduplicates persisted custom types and ignores invalid types and custom messages", async () => {
		const manager = SessionManager.create(cwd, tempDir);
		manager.appendCustomEntry("mode-a", { enabled: true });
		manager.appendCustomEntry("mode-a", { enabled: false });
		manager.appendCustomEntry("extension-b");
		manager.appendCustomEntry("");
		manager.appendCustomEntry("   ");
		manager.appendCustomMessageEntry("message-only", "Context content", true);
		manager.appendMessage({ role: "user", content: "Current prompt", timestamp: 1 });
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		if (!file) throw new Error("Expected persisted session file");
		appendFileSync(file, 'not json\n{"type":"custom","customType":null}\n{"type":"custom","customType":12}\n');
		const content = readFileSync(file, "utf8");
		const partialSessions: SessionInfo[][] = [];

		const current = await SessionManager.list(cwd, tempDir, (_loaded, _total, partial) => {
			if (partial) partialSessions.push([...partial]);
		});
		const all = await SessionManager.listAll(tempDir);

		for (const sessions of [current, all, ...partialSessions]) {
			expect(sessions).toHaveLength(1);
			expect(sessions[0].customTypes).toEqual(["mode-a", "extension-b"]);
			expect(sessions[0].firstMessage).toBe("Current prompt");
			expect(sessions[0].messageCount).toBe(1);
		}
		expect(partialSessions.length).toBeGreaterThan(0);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("reads custom metadata after reopening across project and all-project lists", async () => {
		const manager = SessionManager.create(cwd);
		manager.appendCustomEntry("mode-a");
		manager.appendMessage({ role: "user", content: "Persistent prompt", timestamp: 1 });
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		if (!file) throw new Error("Expected persisted session file");
		const reopened = SessionManager.open(file);
		reopened.appendCustomEntry("mode-a");
		reopened.appendCustomEntry("extension-after-reopen");

		const other = SessionManager.create(join(tempDir, "other-project"));
		other.appendMessage({ role: "user", content: "Ordinary prompt", timestamp: 2 });
		const partialSessions: SessionInfo[][] = [];
		const current = await SessionManager.list(cwd);
		const all = await SessionManager.listAll((_loaded, _total, partial) => {
			if (partial) partialSessions.push([...partial]);
		});

		expect(current).toHaveLength(1);
		expect(all).toHaveLength(2);
		for (const sessions of [current, all]) {
			expect(sessions.find((session) => session.id === reopened.getSessionId())?.customTypes).toEqual([
				"mode-a",
				"extension-after-reopen",
			]);
		}
		expect(all.find((session) => session.id === other.getSessionId())).not.toHaveProperty("customTypes");
		expect(partialSessions.at(-1)).toEqual(all);
	});
});
