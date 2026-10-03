import { describe, expect, it } from "vitest";
import { BrowserOperationQueue } from "../src/modes/desktop/browser-queue.ts";

describe("browser operation queues", () => {
	it("serializes one key while letting another owner proceed", async () => {
		const queue = new BrowserOperationQueue();
		const events: string[] = [];
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = queue.run("a", async () => {
			events.push("a-start");
			await gate;
			events.push("a-end");
		});
		const second = queue.run("a", async () => {
			events.push("a-second");
		});
		await queue.run("b", async () => {
			events.push("b");
		});
		expect(events).toEqual(["a-start", "b"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["a-start", "b", "a-end", "a-second"]);
	});

	it("settles synchronous errors and keeps later operations usable", async () => {
		const queue = new BrowserOperationQueue();
		const failure = queue.run("page", () => {
			throw new Error("page closed");
		});
		await expect(failure).rejects.toThrow("page closed");
		await expect(queue.run("page", async () => "next")).resolves.toBe("next");
	});

	it("cancels queued work without letting the following operation overtake its predecessor", async () => {
		const queue = new BrowserOperationQueue();
		const events: string[] = [];
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = queue.run("page", async () => {
			await gate;
			events.push("first");
		});
		const controller = new AbortController();
		const cancelled = queue.run(
			"page",
			async () => {
				events.push("cancelled");
			},
			controller.signal,
		);
		const check = expect(cancelled).rejects.toThrow("已取消");
		const third = queue.run("page", async () => {
			events.push("third");
		});
		controller.abort();
		await check;
		expect(events).toEqual([]);
		release();
		await Promise.all([first, third]);
		expect(events).toEqual(["first", "third"]);
	});
});
