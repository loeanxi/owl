import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { StartPage } from "./StartPage.tsx";
import { ChatStream } from "./ChatStream.tsx";

type StartProps = Parameters<typeof StartPage>[0];
const fixture = vi.hoisted(() => ({ start: undefined as StartProps | undefined }));
vi.mock("./StartPage.tsx", () => ({ StartPage: (props: StartProps) => { fixture.start = props; return createElement("section", { "data-start-probe": "true" }); } }));
vi.mock("../i18n/index.ts", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../i18n/index.ts");
	return { ...actual, useT: () => actual.t };
});

beforeEach(() => {
	fixture.start = undefined;
	vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => vi.unstubAllGlobals());

describe("chat home-page wiring", () => {
	it("passes project, account and callbacks through without mounting or prompting a session", () => {
		const request = vi.fn();
		const client = { request } as unknown as BridgeClient;
		const onResumeSession = vi.fn();
		const onPromptExample = vi.fn();
		const onQuickAction = vi.fn();
		const onOpenDeveloper = vi.fn();
		const recentSessions = [{ id: "recent", title: "当前项目任务", time: "2026-10-15T00:00:00Z" }];
		renderToStaticMarkup(createElement(ChatStream, { entries: [], client, cwd: "D:/project", profile: "account-a", recentSessions, onResumeSession, onPromptExample, onQuickAction, onOpenDeveloper }));
		expect(fixture.start).toEqual(expect.objectContaining({ client, cwd: "D:/project", profile: "account-a", recentSessions, onPrompt: onPromptExample, onAction: onQuickAction, onOpenDeveloper }));
		fixture.start?.onResume?.("recent");
		expect(onResumeSession).toHaveBeenCalledWith("recent");
		expect(onPromptExample).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("keeps active history searches and populated transcripts out of the home page", () => {
		renderToStaticMarkup(createElement(ChatStream, { entries: [], sessionId: "s1", searchTarget: { sessionId: "s1", entryId: "e1", query: "earlier", requestId: 1 } }));
		expect(fixture.start).toBeUndefined();
		renderToStaticMarkup(createElement(ChatStream, { entries: [{ kind: "user", text: "existing conversation" }] }));
		expect(fixture.start).toBeUndefined();
	});

	it("withholds statistics identity and client until the settings handshake completes", () => {
		const client = { request: vi.fn() } as unknown as BridgeClient;
		renderToStaticMarkup(createElement(ChatStream, { entries: [], client, profile: "cached-account", startReady: false }));
		expect(fixture.start?.client).toBeUndefined();
		expect(fixture.start?.profile).toBeUndefined();
		expect(client.request).not.toHaveBeenCalled();
	});
});
