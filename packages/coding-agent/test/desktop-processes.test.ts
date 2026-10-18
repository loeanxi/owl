import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { registerSessionProcess, terminateSessionProcesses } from "../src/core/tools/process-store.ts";
import { getDesktopProcess, killDesktopProcess, listDesktopProcesses } from "../src/modes/desktop/processes.ts";

const owner = "desktop-process-test-owner";
const other = "desktop-process-test-other";
afterEach(() => {
	terminateSessionProcesses(owner);
	terminateSessionProcesses(other);
});

function start(sessionId = owner) {
	const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
		windowsHide: true,
	});
	return registerSessionProcess({ child, sessionId, command: "test-command", cwd: process.cwd(), acceptsStdin: true });
}

describe("desktop background process inspection", () => {
	it("excludes foreground handles until the shell actually yields", () => {
		const entry = start();
		expect(listDesktopProcesses(owner)).toEqual([]);
		expect(() => getDesktopProcess(owner, entry.id)).toThrow("not found");
		entry.backgrounded = true;
		expect(listDesktopProcesses(owner)).toMatchObject([{ id: entry.id, status: "running" }]);
	});

	it("reads output repeatedly without consuming the model pending buffer", async () => {
		const entry = start();
		entry.backgrounded = true;
		await once(entry.child.stdout!, "data");
		const pending = entry.pending;
		expect(getDesktopProcess(owner, entry.id).output).toContain("ready");
		expect(getDesktopProcess(owner, entry.id).output).toContain("ready");
		expect(entry.pending).toBe(pending);
	});

	it("cannot inspect or kill another session's process", async () => {
		const entry = start(other);
		entry.backgrounded = true;
		expect(listDesktopProcesses(owner)).toEqual([]);
		expect(() => getDesktopProcess(owner, entry.id)).toThrow("not found");
		await expect(killDesktopProcess(owner, entry.id)).rejects.toThrow("not found");
		expect(entry.killed).toBe(false);
	});

	it("stops the selected process tree while its sibling remains running", async () => {
		const first = start();
		const second = start();
		first.backgrounded = true;
		second.backgrounded = true;
		const result = await killDesktopProcess(owner, first.id);
		expect(result.status).toBe("stopped");
		expect(first.exitCode).not.toBeUndefined();
		expect(second.exitCode).toBeUndefined();
		expect(second.killed).toBe(false);
	});

	it("rejects missing owners and invalid process identifiers", () => {
		expect(() => listDesktopProcesses("")).toThrow("owner");
		for (const id of [-1, 0, 1.5, Number.NaN]) expect(() => getDesktopProcess(owner, id)).toThrow("Invalid");
	});
});
