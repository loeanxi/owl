import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../bridge/client.ts";
import { quitDesktopApp, startDebugRebuild, switchAccountBridge } from "../bridge/native.ts";
import { beginEditorAccountTransition, cancelEditorAccountTransition, confirmEditorAccountProfile, editorsNeedExitWarning, editorsTransitionLocked, listenForUnprotectedEditorUnload, prepareEditorExit, registerEditorExitGuard, subscribeEditorTransition, targetEditorAccountTransition, type EditorUnloadTarget } from "./editor-exit-guard.ts";

const native = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
class Socket {
	static latest: Socket;
	OPEN = 1; CONNECTING = 0; readyState = 1;
	onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
	sent: Array<{ type: string; id: string }> = [];
	constructor() { Socket.latest = this; }
	send(value: string): void { this.sent.push(JSON.parse(value) as { type: string; id: string }); }
	close(): void { this.onclose?.(); }
}
let disposers: Array<() => void>;
let client: BridgeClient;
beforeEach(() => {
	disposers = [];
	vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); native.invoke.mockClear();
	client = new BridgeClient("ws://exit.test/ws"); client.connect();
});
afterEach(() => { disposers.forEach((dispose) => dispose()); client.disconnect(); cancelEditorAccountTransition(); vi.unstubAllGlobals(); });

describe("editor exit protection", () => {
	it("does not block a page without unprotected edits", async () => {
		expect(editorsNeedExitWarning()).toBe(false); await expect(prepareEditorExit()).resolves.toBe(true);
	});
	it("shares one preservation attempt and refuses while any participant cannot preserve", async () => {
		const pending = Promise.withResolvers<boolean>(); const preserve = vi.fn(() => pending.promise);
		disposers.push(registerEditorExitGuard({ prepare: preserve, needsWarning: () => true }));
		const first = prepareEditorExit(); const second = prepareEditorExit();
		expect(first).toBe(second); expect(preserve).toHaveBeenCalledOnce(); expect(editorsNeedExitWarning()).toBe(true);
		pending.resolve(false); await expect(first).resolves.toBe(false);
	});
	it("does not grant exit if a new workbench owner appears while preserving the old one", async () => {
		const pending = Promise.withResolvers<boolean>();
		disposers.push(registerEditorExitGuard({ prepare: () => pending.promise, needsWarning: () => true }));
		const leaving = prepareEditorExit();
		disposers.push(registerEditorExitGuard({ prepare: async () => true, needsWarning: () => false }));
		pending.resolve(true); await expect(leaving).resolves.toBe(false);
	});
	it("keeps failed protection visible to refresh guards rather than treating an exception as success", async () => {
		disposers.push(registerEditorExitGuard({ prepare: async () => { throw new Error("disk full"); }, needsWarning: () => true }));
		await expect(prepareEditorExit()).resolves.toBe(false); expect(editorsNeedExitWarning()).toBe(true);
	});
	it("does not send account.switch when preserving the current editor was cancelled", async () => {
		disposers.push(registerEditorExitGuard({ prepare: async () => false, needsWarning: () => true }));
		await expect(client.request({ type: "account.switch", accountId: "other" })).resolves.toMatchObject({ ok: false });
		expect(Socket.latest.sent).toEqual([]);
	});
	it("sends account.switch only after the old editor has a confirmed retained copy", async () => {
		const pending = Promise.withResolvers<boolean>();
		disposers.push(registerEditorExitGuard({ prepare: () => pending.promise, needsWarning: () => true }));
		const switching = client.request({ type: "account.switch", accountId: "other" });
		expect(Socket.latest.sent).toEqual([]); pending.resolve(true);
		await vi.waitFor(() => expect(Socket.latest.sent).toHaveLength(1));
		const request = Socket.latest.sent[0]; expect(request.type).toBe("account.switch");
		Socket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: request.id, ok: true }) });
		await expect(switching).resolves.toMatchObject({ ok: true });
	});
	it("locks editing before preservation and keeps it locked after acknowledgement until the target owner is committed", async () => {
		const pending = Promise.withResolvers<boolean>();
		disposers.push(registerEditorExitGuard({ prepare: () => { expect(editorsTransitionLocked()).toBe(true); return pending.promise; }, needsWarning: () => true }));
		const switching = client.request({ type: "account.switch", accountId: "other" });
		expect(editorsTransitionLocked()).toBe(true);
		await expect(client.request({ type: "account.switch", accountId: "third" })).resolves.toMatchObject({ ok: false });
		pending.resolve(true); await vi.waitFor(() => expect(Socket.latest.sent).toHaveLength(1));
		Socket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: Socket.latest.sent[0].id, ok: true, result: { account: { dataDir: "D:/new-profile" } } }) });
		await switching; expect(editorsTransitionLocked()).toBe(true);
		confirmEditorAccountProfile("D:/old-profile"); expect(editorsTransitionLocked()).toBe(true);
		confirmEditorAccountProfile("d:\\new-profile\\"); expect(editorsTransitionLocked()).toBe(false);
	});
	it("releases the transition on failed preservation, bridge rejection, and socket failure", async () => {
		const off = registerEditorExitGuard({ prepare: async () => false, needsWarning: () => true }); disposers.push(off);
		await client.request({ type: "account.switch", accountId: "cancelled" }); expect(editorsTransitionLocked()).toBe(false); off();
		const rejected = client.request({ type: "account.switch", accountId: "rejected" });
		await vi.waitFor(() => expect(Socket.latest.sent).toHaveLength(1));
		Socket.latest.onmessage?.({ data: JSON.stringify({ type: "response", id: Socket.latest.sent[0].id, ok: false, error: "wrong password" }) });
		await rejected; expect(editorsTransitionLocked()).toBe(false);
		const disconnected = client.request({ type: "account.switch", accountId: "offline" });
		await vi.waitFor(() => expect(Socket.latest.sent).toHaveLength(2)); client.disconnect();
		await expect(disconnected).rejects.toThrow(); expect(editorsTransitionLocked()).toBe(false);
	});
	it("unlocks a retained old editor when the native account restart fails", async () => {
		const id = beginEditorAccountTransition()!; targetEditorAccountTransition(id, "D:/new-profile");
		native.invoke.mockRejectedValueOnce(new Error("restart failed"));
		await expect(switchAccountBridge("D:/new-profile")).rejects.toThrow("restart failed"); expect(editorsTransitionLocked()).toBe(false);
	});
	it("notifies lock subscribers and refuses a late completion for another transition", () => {
		const changed = vi.fn(); disposers.push(subscribeEditorTransition(changed));
		const first = beginEditorAccountTransition()!; cancelEditorAccountTransition(first);
		const second = beginEditorAccountTransition()!; cancelEditorAccountTransition(first); expect(editorsTransitionLocked()).toBe(true);
		targetEditorAccountTransition(second, "D:/new"); confirmEditorAccountProfile("D:/new"); expect(editorsTransitionLocked()).toBe(false); expect(changed).toHaveBeenCalledTimes(4);
	});
	it.each([quitDesktopApp, startDebugRebuild])("refuses a native destructive exit when edits cannot be retained", async (exit) => {
		disposers.push(registerEditorExitGuard({ prepare: async () => false, needsWarning: () => true }));
		await expect(exit()).resolves.toBe(false); expect(native.invoke).not.toHaveBeenCalled();
	});
	it("allows the native quit after preservation has completed", async () => {
		disposers.push(registerEditorExitGuard({ prepare: async () => true, needsWarning: () => false }));
		await expect(quitDesktopApp()).resolves.toBe(true); expect(native.invoke).toHaveBeenCalledExactlyOnceWith("quit_app");
	});
	it("warns on refresh only until the latest edit is safely retained, and removes its listener", () => {
		let protectedCopy = false;
		disposers.push(registerEditorExitGuard({ prepare: async () => protectedCopy, needsWarning: () => !protectedCopy }));
		const target = new EventTarget();
		const stop = listenForUnprotectedEditorUnload(target as unknown as EditorUnloadTarget);
		const event = (): Event => { const value = new Event("beforeunload", { cancelable: true }); Object.defineProperty(value, "returnValue", { value: "", writable: true }); return value; };
		const unsafe = event(); target.dispatchEvent(unsafe); expect(unsafe.defaultPrevented).toBe(true);
		protectedCopy = true; const safe = event(); target.dispatchEvent(safe); expect(safe.defaultPrevented).toBe(false);
		protectedCopy = false; stop(); const removed = event(); target.dispatchEvent(removed); expect(removed.defaultPrevented).toBe(false);
	});
});
