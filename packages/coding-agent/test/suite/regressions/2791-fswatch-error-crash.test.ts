import type { FSWatcher } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeWatcher, watchWithErrorHandler } from "../../../src/utils/fs-watch.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 *
 * watchWithErrorHandler() is the single creation seam every production watcher
 * goes through, so the guarantee is asserted there: the returned watcher must
 * carry an error listener, and emitting 'error' must not throw.
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;
	let watcher: FSWatcher | null = null;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
	});

	afterEach(() => {
		closeWatcher(watcher);
		watcher = null;
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("attaches an error handler so an emitted error is not an uncaught exception", () => {
		let errors = 0;
		watcher = watchWithErrorHandler(
			tempRoot,
			() => {},
			() => {
				errors += 1;
			},
		);

		expect(watcher).not.toBeNull();
		expect(watcher?.listenerCount("error")).toBe(1);

		// Emitting 'error' on an EventEmitter with no error listener throws.
		// This simulates an async OS error (e.g. ReadDirectoryChangesW invalidation).
		expect(() => watcher?.emit("error", new Error("simulated OS watcher failure"))).not.toThrow();
		expect(errors).toBe(1);
	});
});
