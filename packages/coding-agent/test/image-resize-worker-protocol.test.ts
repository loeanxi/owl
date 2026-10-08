import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resizeImage } from "../src/utils/image-resize.ts";
import { type ResizedImage, resizeImageInProcess } from "../src/utils/image-resize-core.ts";

vi.mock("node:worker_threads", () => ({ Worker: vi.fn() }));
vi.mock("../src/utils/image-resize-core.ts", () => ({
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE: "pi:image-resize-response",
	resizeImageInProcess: vi.fn(),
}));

class MockResizeWorker extends EventEmitter {
	postMessage = vi.fn();
	terminate = vi.fn(async () => 0);
}

const workerResult: ResizedImage = {
	data: "resized-image",
	mimeType: "image/png",
	originalWidth: 200,
	originalHeight: 100,
	width: 100,
	height: 50,
	wasResized: true,
};

describe("image resize worker protocol", () => {
	let worker: MockResizeWorker;
	const input = new Uint8Array([1, 2, 3]);
	const options = { maxWidth: 100, maxHeight: 50 };

	beforeEach(() => {
		worker = new MockResizeWorker();
		vi.mocked(Worker).mockReset();
		// biome-ignore lint/complexity/useArrowFunction: Worker is called with new, so this mock must be constructable.
		vi.mocked(Worker).mockImplementation(function () {
			return worker as unknown as Worker;
		});
		vi.mocked(resizeImageInProcess).mockReset();
		vi.mocked(resizeImageInProcess).mockResolvedValue(null);
	});

	// Regression for pi#10527: Node --watch can send its own worker messages first.
	it.each([
		null,
		undefined,
		42,
		"watch:require",
		{ "watch:require": ["image-resize-worker.ts"] },
		{ result: null },
		{ error: "watch notification" },
		{ type: "watch:require", error: "watch notification" },
	])("waits for the image reply after unrelated message %j", async (unrelatedMessage) => {
		const pending = resizeImage(input, "image/png", options);
		worker.emit("message", unrelatedMessage);
		worker.emit("message", { type: "pi:image-resize-response", result: workerResult });

		await expect(pending).resolves.toEqual(workerResult);
		expect(resizeImageInProcess).not.toHaveBeenCalled();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("keeps the worker running until a tagged response arrives", async () => {
		const pending = resizeImage(input, "image/png", options);
		worker.emit("message", { "watch:require": ["photon.ts"] });
		await Promise.resolve();
		await Promise.resolve();
		expect(worker.terminate).not.toHaveBeenCalled();
		expect(resizeImageInProcess).not.toHaveBeenCalled();

		worker.emit("message", { type: "pi:image-resize-response", result: workerResult });
		await expect(pending).resolves.toEqual(workerResult);
	});

	it("preserves a tagged null result without retrying in process", async () => {
		const pending = resizeImage(input, "image/png", options);
		worker.emit("message", { type: "pi:image-resize-response", result: null });

		await expect(pending).resolves.toBeNull();
		expect(resizeImageInProcess).not.toHaveBeenCalled();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it.each(["decoder failed", ""])("falls back for tagged worker error %j", async (error) => {
		vi.mocked(resizeImageInProcess).mockResolvedValue(workerResult);
		const pending = resizeImage(input, "image/png", options);
		worker.emit("message", { type: "pi:image-resize-response", error });

		await expect(pending).resolves.toEqual(workerResult);
		expect(resizeImageInProcess).toHaveBeenCalledExactlyOnceWith(input, "image/png", options);
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("falls back if the worker exits after unrelated messages without a reply", async () => {
		vi.mocked(resizeImageInProcess).mockResolvedValue(workerResult);
		const pending = resizeImage(input, "image/png", options);
		worker.emit("message", { "watch:require": ["photon.ts"] });
		worker.emit("exit", 1);

		await expect(pending).resolves.toEqual(workerResult);
		expect(resizeImageInProcess).toHaveBeenCalledExactlyOnceWith(input, "image/png", options);
	});

	it("falls back on worker errors and terminates the worker", async () => {
		vi.mocked(resizeImageInProcess).mockResolvedValue(workerResult);
		const pending = resizeImage(input, "image/png", options);
		worker.emit("error", new Error("worker cannot load"));

		await expect(pending).resolves.toEqual(workerResult);
		expect(resizeImageInProcess).toHaveBeenCalledExactlyOnceWith(input, "image/png", options);
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});
});
