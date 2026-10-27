import { describe, expect, it } from "vitest";
import { BrowserConsoleJournal } from "../src/modes/desktop/browser-console.ts";

describe("browser console evidence journal", () => {
	it("redacts credential shaped values before they can reach the model", () => {
		const journal = new BrowserConsoleJournal();
		journal.push("log", 'token=abc123secret password: "hunter2"');
		const result = journal.list();
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].text).not.toContain("abc123secret");
		expect(result.entries[0].text).not.toContain("hunter2");
		expect(result.entries[0].text).toContain("[REDACTED]");
	});

	it("numbers entries so a caller can resume from the cursor", () => {
		const journal = new BrowserConsoleJournal();
		journal.push("log", "first");
		journal.push("error", "second");
		const first = journal.list();
		expect(first.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
		expect(first.cursor).toBe(2);
		expect(journal.list({ since: first.cursor }).entries).toEqual([]);
		journal.push("log", "third");
		expect(journal.list({ since: first.cursor }).entries.map((entry) => entry.text)).toEqual(["third"]);
	});

	it("filters by level, accepting warning as an alias of warn", () => {
		const journal = new BrowserConsoleJournal();
		journal.push("log", "plain");
		journal.push("warning", "deprecated");
		journal.push("pageerror", "boom");
		expect(journal.list({ levels: ["warn"] }).entries.map((entry) => entry.sequence)).toEqual([2]);
		expect(journal.list({ levels: ["warning"] }).entries.map((entry) => entry.sequence)).toEqual([2]);
		expect(journal.list({ levels: ["pageerror"] }).entries.map((entry) => entry.sequence)).toEqual([3]);
	});

	it("filters by a case sensitive substring of the rendered text", () => {
		const journal = new BrowserConsoleJournal();
		journal.push("log", "TypeError happened");
		expect(journal.list({ filter: "typeerror" }).entries).toEqual([]);
		expect(journal.list({ filter: "TypeError" }).entries).toHaveLength(1);
	});

	it("reports the entry budget and what it dropped", () => {
		const journal = new BrowserConsoleJournal({ maxEntries: 3 });
		for (let index = 0; index < 5; index++) journal.push("log", `line ${index}`);
		const result = journal.list();
		expect(result.entries).toHaveLength(3);
		expect(result.dropped).toBe(2);
		expect(result.oldestSequence).toBe(3);
		expect(result.limits.maxEntries).toBe(3);
	});

	it("marks a page that hit the returned limit as truncated", () => {
		const journal = new BrowserConsoleJournal();
		for (let index = 0; index < 5; index++) journal.push("log", `line ${index}`);
		const result = journal.list({ limit: 2 });
		expect(result.entries).toHaveLength(2);
		expect(result.truncated).toBe(true);
		expect(result.cursor).toBe(2);
	});

	it("clears the buffer without losing the sequence counter", () => {
		const journal = new BrowserConsoleJournal();
		journal.push("log", "before");
		journal.clear();
		expect(journal.list().entries).toEqual([]);
		journal.push("log", "after");
		expect(journal.list().entries.map((entry) => entry.sequence)).toEqual([2]);
	});
});
