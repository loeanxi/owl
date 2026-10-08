import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

describe("image resize worker replies", () => {
	it("tags real image results with their original dimensions", async () => {
		const worker = new Worker(new URL("../src/utils/image-resize-worker.ts", import.meta.url));
		try {
			const response = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			worker.postMessage({ inputBytes: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" });

			await expect(response).resolves.toMatchObject({
				type: "pi:image-resize-response",
				result: {
					data: TINY_PNG,
					mimeType: "image/png",
					originalWidth: 2,
					originalHeight: 2,
					width: 2,
					height: 2,
					wasResized: false,
				},
			});
		} finally {
			await worker.terminate();
		}
	});

	it("tags errors for invalid worker requests", async () => {
		const worker = new Worker(new URL("../src/utils/image-resize-worker.ts", import.meta.url));
		try {
			const response = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			worker.postMessage({ mimeType: "image/png" });

			await expect(response).resolves.toEqual({
				type: "pi:image-resize-response",
				error: "Invalid image resize worker request",
			});
		} finally {
			await worker.terminate();
		}
	});
});
