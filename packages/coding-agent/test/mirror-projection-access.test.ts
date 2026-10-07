import { describe, expect, it, vi } from "vitest";
import { MirrorProjectionAccess } from "../src/modes/desktop/mirror/projection-access.ts";
import type { MirrorInputRequest, MirrorProjectionGeometry } from "../src/modes/desktop/protocol.ts";

const geometry: MirrorProjectionGeometry = {
	geometryId: "frame-1",
	crop: { x: 4, y: 40, width: 840, height: 507 },
	sourceWidth: 906,
	sourceHeight: 547,
};
const input: MirrorInputRequest = {
	type: "mirror.input",
	id: "click",
	windowId: "123",
	geometryId: "frame-1",
	action: "click",
	u: 0.5,
	v: 0.5,
};
function fixture() {
	const target = {
		projectWindow: vi.fn(async (_windowId: string, _visible?: boolean) => geometry),
		inputWindow: vi.fn((_request: MirrorInputRequest) => {}),
		unembedWindow: vi.fn(async (_windowId: string) => {}),
	};
	return { target, access: new MirrorProjectionAccess(target), owner: {}, stranger: {} };
}

describe("mirror projection ownership", () => {
	it("requires this connection to own an active projection and subscribe before input", async () => {
		const { target, access, owner, stranger } = fixture();
		expect(() => access.input(owner, input, true)).toThrow("requires this connection");
		await access.project(owner, "123");
		expect(() => access.input(stranger, input, true)).toThrow("requires this connection");
		expect(() => access.input(owner, input, false)).toThrow("active projection subscription");
		access.input(owner, input, true);
		expect(target.inputWindow).toHaveBeenCalledExactlyOnceWith(input);
		await expect(access.project(stranger, "123")).rejects.toThrow("another connection");
		await expect(access.project(stranger, "0123")).rejects.toThrow("invalid windowId");
		expect(() => access.assertOwnerOrUnclaimed(stranger, "0123")).toThrow("another connection");
	});

	it("retains exclusive restore ownership while paused and still permits release", async () => {
		const { target, access, owner, stranger } = fixture();
		await access.project(owner, "123");
		await access.project(owner, "123", false);
		expect(() => access.input(owner, input, true)).toThrow("active projection subscription");
		access.input(owner, { ...input, action: "cancel", geometryId: "old-frame" }, false);
		expect(target.inputWindow).toHaveBeenCalledOnce();
		await expect(access.unembed(stranger, "123")).rejects.toThrow("not owned");
		await expect(access.project(stranger, "123")).rejects.toThrow("another connection");
		await access.unembed(owner, "123");
		await expect(access.project(stranger, "123")).resolves.toEqual(geometry);
	});

	it("serializes hide after a late prepare without activating stale input", async () => {
		const { target, access, owner } = fixture();
		let release!: (value: MirrorProjectionGeometry) => void;
		target.projectWindow.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const prepared = access.project(owner, "123");
		await vi.waitFor(() => expect(target.projectWindow).toHaveBeenCalledOnce());
		const hidden = access.project(owner, "123", false);
		expect(() => access.input(owner, input, true)).toThrow("active projection subscription");
		expect(target.projectWindow).toHaveBeenCalledOnce();
		release(geometry);
		await Promise.all([prepared, hidden]);
		expect(target.projectWindow.mock.calls).toEqual([
			["123", true],
			["123", false],
		]);
		expect(() => access.input(owner, input, true)).toThrow("active projection subscription");
	});

	it("restores only the disconnecting owner's window after an in-flight native prepare", async () => {
		const { target, access, owner, stranger } = fixture();
		await access.project(stranger, "456");
		let release!: (value: MirrorProjectionGeometry) => void;
		target.projectWindow.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const prepared = access.project(owner, "123");
		const rejected = expect(prepared).rejects.toThrow("connection closed during projection");
		await vi.waitFor(() => expect(target.projectWindow).toHaveBeenCalledTimes(2));
		const disconnected = access.disconnect(owner);
		expect(target.unembedWindow).not.toHaveBeenCalled();
		await expect(access.project(owner, "789")).rejects.toThrow("connection is closed");
		release(geometry);
		await rejected;
		await disconnected;
		expect(target.unembedWindow).toHaveBeenCalledExactlyOnceWith("123");
		expect(access.hasClaim("123")).toBe(false);
		expect(access.hasClaim("456")).toBe(true);
	});

	it("a failed prepare does not strand later cleanup behind a rejected queue", async () => {
		const { target, access, owner } = fixture();
		target.projectWindow.mockRejectedValueOnce(new Error("native prepare failed"));
		await expect(access.project(owner, "123")).rejects.toThrow("native prepare failed");
		await access.disconnect(owner);
		expect(target.unembedWindow).toHaveBeenCalledExactlyOnceWith("123");
		expect(access.hasClaim("123")).toBe(false);
	});

	it("keeps restore ownership after failure so another connection cannot race the retry", async () => {
		const { target, access, owner, stranger } = fixture();
		await access.project(owner, "123");
		target.unembedWindow.mockRejectedValueOnce(new Error("native restore failed"));
		await expect(access.unembed(owner, "123")).rejects.toThrow("native restore failed");
		await expect(access.project(stranger, "123")).rejects.toThrow("another connection");
		await access.unembed(owner, "123");
		expect(access.hasClaim("123")).toBe(false);
	});
});
