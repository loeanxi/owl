import { describe, expect, it } from "vitest";
import { agentPageForSession, encodeIabPath, parseIabPath } from "../../../apps/desktop/src/sidebar/iab-bound.ts";
import { isReadOnlyDesktopTool } from "../src/modes/desktop/browser-permissions.ts";
import type { IabPageInfo, IabPagesMessage } from "../src/modes/desktop/protocol.ts";

describe("desktop browser plan permissions", () => {
	it("allows observations and target selection", () => {
		for (const toolName of ["read", "ls", "find", "grep", "browser_snapshot", "browser_screenshot", "browser_wait"]) {
			expect(isReadOnlyDesktopTool(toolName, {})).toBe(true);
		}
		expect(isReadOnlyDesktopTool("browser_tabs", { action: "list" })).toBe(true);
		expect(isReadOnlyDesktopTool("browser_tabs", { action: "select", pageId: "owned" })).toBe(true);
		expect(isReadOnlyDesktopTool("browser_console", {})).toBe(true);
		expect(isReadOnlyDesktopTool("browser_console", { action: "list" })).toBe(true);
		expect(isReadOnlyDesktopTool("browser_network", {})).toBe(true);
		expect(isReadOnlyDesktopTool("browser_network", { action: "detail", requestId: "request" })).toBe(true);
	});

	it("blocks mutations inside composite tools and unknown actions", () => {
		for (const [toolName, action] of [
			["browser_tabs", "new"],
			["browser_tabs", "close"],
			["browser_tabs", "future-action"],
			["browser_console", "clear"],
			["browser_network", "clear"],
			["browser_network", "replay"],
		])
			expect(isReadOnlyDesktopTool(toolName, { action })).toBe(false);
		expect(isReadOnlyDesktopTool("browser_tabs", undefined)).toBe(false);
		for (const toolName of [
			"browser_navigate",
			"browser_type",
			"browser_select",
			"browser_hover",
			"write",
			"edit",
			"bash",
		]) {
			expect(isReadOnlyDesktopTool(toolName, {})).toBe(false);
		}
	});
});

describe("browser page ownership in the desktop", () => {
	const page = (pageId: string, sessionId?: string, active = true): IabPageInfo => ({
		pageId,
		sessionId,
		active,
		title: pageId,
		url: `https://example.test/${pageId}`,
		viewport: { width: 1280, height: 860 },
	});
	const message = (originSessionId: string | undefined, pages: IabPageInfo[]): IabPagesMessage => ({
		type: "iab.pages",
		origin: "agent",
		originSessionId,
		pages,
	});

	it("does not activate a background chat's page when each chat has an active page", () => {
		const pages = [page("B", "chat-b"), page("A", "chat-a")];
		expect(agentPageForSession(message("chat-b", pages), "chat-a")).toBeUndefined();
		expect(agentPageForSession(message("chat-a", pages), "chat-a")?.pageId).toBe("A");
	});

	it("never adopts an unowned or foreign page from a broadcast", () => {
		expect(agentPageForSession(message("chat-a", [page("manual"), page("B", "chat-b")]), "chat-a")).toBeUndefined();
		expect(agentPageForSession(message(undefined, [page("A", "chat-a")]), "chat-a")).toBeUndefined();
		expect(agentPageForSession(message("chat-a", [page("A", "chat-a")]), undefined)).toBeUndefined();
		expect(
			agentPageForSession({ ...message("chat-a", [page("A", "chat-a")]), origin: "ui" }, "chat-a"),
		).toBeUndefined();
	});

	it("keeps the original chat when reopening a persisted page after bridge restart", () => {
		const url = "https://example.test/a|b?query=中文";
		const sessionId = "chat|中文:%";
		expect(parseIabPath(encodeIabPath("page-a", url, sessionId))).toEqual({ pageId: "page-a", url, sessionId });
		expect(parseIabPath(encodeIabPath("manual", url))).toEqual({ pageId: "manual", url });
		expect(parseIabPath(url)).toEqual({ url });
		expect(parseIabPath(undefined)).toEqual({});
		expect(parseIabPath("iab-session:%broken|page|https://example.test")).toEqual({});
	});
});
