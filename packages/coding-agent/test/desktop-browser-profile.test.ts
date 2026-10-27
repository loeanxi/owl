import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "playwright-core";
import { describe, expect, it } from "vitest";
import { loadSessionCookies, saveSessionCookies } from "../src/modes/desktop/browser-profile.ts";

function cookie(name: string, value: string): Cookie {
	return {
		name,
		value,
		domain: "example.test",
		path: "/",
		expires: -1,
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
	};
}

describe("browser session profile", () => {
	it("round-trips the cookies of one session", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-browser-profile-"));
		await saveSessionCookies(dir, "chat-a", [cookie("sid", "value-a")]);
		const loaded = await loadSessionCookies(dir, "chat-a");
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.name).toBe("sid");
		expect(loaded[0]?.value).toBe("value-a");
	});

	it("keeps sessions apart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-browser-profile-"));
		await saveSessionCookies(dir, "chat-a", [cookie("sid", "value-a")]);
		expect(await loadSessionCookies(dir, "chat-b")).toEqual([]);
	});

	it("returns nothing when there is no profile yet", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-browser-profile-"));
		expect(await loadSessionCookies(dir, "nobody")).toEqual([]);
	});

	it("keeps a session id from escaping the profile directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owl-browser-profile-"));
		await saveSessionCookies(dir, "../../escape", [cookie("x", "y")]);
		const entries = await readdir(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).not.toContain("/");
		const written = await readFile(join(dir, entries[0]), "utf8");
		expect(written).toContain("y");
	});
});
