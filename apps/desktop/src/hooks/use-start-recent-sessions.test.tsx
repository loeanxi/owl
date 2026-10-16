import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { selectStartRecentSessions, useStartRecentSessions, type StartRecentSession, type StartRecentSessionRow } from "./use-start-recent-sessions.ts";

type Props = Parameters<typeof useStartRecentSessions>[1] & { client: BridgeClient };
type Reply = { ok: boolean; result?: StartRecentSessionRow[] };
let root: Root;
let visible: readonly StartRecentSession[];
let props: Props;
const request = vi.fn<(payload: { type: string; scope?: string }) => Promise<Reply>>();

function Probe(next: Props): null {
	visible = useStartRecentSessions(next.client, next);
	return null;
}

async function render(next: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...next };
	await act(async () => root.render(createElement(Probe, props)));
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	root = createRoot(dom.document.getElementById("root")!);
	request.mockReset().mockResolvedValue({ ok: true, result: [] });
	props = { client: { request } as unknown as BridgeClient, active: true, connected: true, profile: "profile-a", cwd: "D:/alpha", revision: 0 };
	visible = [];
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

describe("home recent sessions", () => {
	it("keeps three populated ordinary sessions in the current project, preserving ids and display cleanup", () => {
		const rows: StartRecentSessionRow[] = [
			{ id: "other", cwd: "D:/beta", name: "other project", messageCount: 5, modified: "2026-10-15T10:00:00Z" },
			{ id: "research", cwd: "D:/alpha", scope: "research", name: "research", messageCount: 5, modified: "2026-10-15T09:00:00Z" },
			{ id: "archived", cwd: "D:/alpha", archivedAt: "2026-10-15", name: "archived", messageCount: 5 },
			{ id: "empty", cwd: "D:/alpha", name: "named empty", messageCount: 0 },
			{ id: "blank", cwd: "D:/alpha" },
			{ cwd: "D:/alpha", name: "missing id", messageCount: 1 },
			{ id: "old", cwd: "D:/alpha", name: "old", messageCount: 2, created: "2026-10-10T00:00:00Z" },
			{ id: "third", cwd: "D:/alpha", name: "third", messageCount: 2, created: "2026-10-11T00:00:00Z" },
			{ id: "branch", cwd: "D:/alpha", firstMessage: "检查接口", parentSessionPath: "parent.jsonl", messageCount: 2, modified: "2026-10-12T00:00:00Z" },
			{ id: "latest", cwd: "d:\\ALPHA\\", firstMessage: "[Attached files for this turn]\n- D:/alpha/main.ts\n\n修复输入框", messageCount: 2, modified: "2026-10-13T00:00:00Z" },
		];
		expect(selectStartRecentSessions(rows, "D:/alpha", "未命名", "分支")).toEqual([
			{ id: "latest", title: "修复输入框", time: "2026-10-13T00:00:00Z" },
			{ id: "branch", title: "检查接口 · 分支", time: "2026-10-12T00:00:00Z" },
			{ id: "third", title: "third", time: "2026-10-11T00:00:00Z" },
		]);
		expect(rows[0]?.id).toBe("other");
	});

	it("only reads session.list while the empty page is active, connected and profile-confirmed", async () => {
		await render({ active: false });
		await render({ active: true, connected: false });
		await render({ connected: true, profile: undefined });
		expect(request).not.toHaveBeenCalled();
		await render({ profile: "profile-a" });
		await render({ active: false });
		expect(request.mock.calls).toEqual([[{ type: "session.list", scope: "chat" }]]);
		expect(visible).toEqual([]);
	});

	it("discards late project and account responses and never paints a prior owner's cached rows", async () => {
		const alpha = Promise.withResolvers<Reply>();
		const beta = Promise.withResolvers<Reply>();
		const account = Promise.withResolvers<Reply>();
		const latestAccount = Promise.withResolvers<Reply>();
		request.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(beta.promise).mockReturnValueOnce(account.promise).mockReturnValueOnce(latestAccount.promise);
		await render();
		await render({ cwd: "D:/beta" });
		await act(async () => beta.resolve({ ok: true, result: [{ id: "beta", cwd: "D:/beta", name: "beta", messageCount: 1 }] }));
		expect(visible.map((row) => row.id)).toEqual(["beta"]);
		await act(async () => alpha.resolve({ ok: true, result: [{ id: "alpha", cwd: "D:/alpha", name: "alpha", messageCount: 1 }] }));
		expect(visible.map((row) => row.id)).toEqual(["beta"]);
		await render({ profile: "profile-b" });
		expect(visible).toEqual([]);
		await render({ profile: "profile-c" });
		await act(async () => account.resolve({ ok: true, result: [{ id: "account-b", cwd: "D:/beta", name: "new account", messageCount: 1 }] }));
		expect(visible).toEqual([]);
		await act(async () => latestAccount.resolve({ ok: true, result: [{ id: "account-c", cwd: "D:/beta", name: "current account", messageCount: 1 }] }));
		expect(visible.map((row) => row.id)).toEqual(["account-c"]);
	});

	it("leaves examples usable after a read failure and refreshes after reconnect", async () => {
		request.mockRejectedValueOnce(new Error("offline"));
		await render();
		expect(visible).toEqual([]);
		await render({ connected: false });
		request.mockResolvedValueOnce({ ok: true, result: [{ id: "restored", cwd: "D:/alpha", name: "latest", messageCount: 1 }] });
		await render({ connected: true });
		expect(visible.map((row) => row.id)).toEqual(["restored"]);
		expect(request.mock.calls.every(([payload]) => payload.type === "session.list")).toBe(true);
	});
});
