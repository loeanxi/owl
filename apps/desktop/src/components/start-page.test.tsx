import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { StartPage } from "./StartPage.tsx";

const { usageMounted } = vi.hoisted(() => ({ usageMounted: vi.fn() }));
vi.mock("./UsageOverview.tsx", () => ({
	UsageOverview: () => { usageMounted(); return <div className="test-usage-overview" />; },
}));

type Props = React.ComponentProps<typeof StartPage>;
let container: HTMLElement;
let root: Root;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	setUiLanguage("zh");
	usageMounted.mockClear();
	props = { client: { request: vi.fn() } as unknown as BridgeClient, profile: "agent A" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<StartPage {...props} />));
}

describe("StartPage", () => {
	it("keeps the greeting and usage cards and stays quiet without quick-start handlers", async () => {
		await render();
		expect(container.querySelector(".owl-start-heading")?.textContent).toBe(t("start.heading"));
		expect(container.querySelector(".owl-wordmark")?.textContent).toBe("owl");
		expect(container.querySelector(".owl-start-description")).toBeNull();
		expect(container.querySelector(".test-usage-overview")).not.toBeNull();
		expect(usageMounted).toHaveBeenCalledOnce();
		expect(container.querySelector(".owl-start-project, .owl-start-recent, .owl-start-examples, .owl-start-tools")).toBeNull();
	});

	it("offers prompt examples that land verbatim in the composer when a handler exists", async () => {
		props.onPromptExample = vi.fn();
		await render();
		const cards = [...container.querySelectorAll<HTMLButtonElement>(".owl-start-example")];
		expect(cards).toHaveLength(4);
		expect(container.querySelector(".owl-start-examples")?.getAttribute("aria-label")).toBe(t("start.examplesAria"));
		await act(async () => cards[0]!.click());
		expect(props.onPromptExample).toHaveBeenCalledExactlyOnceWith(t("start.exQuestionPrompt"));
	});

	it("lists recent sessions with a relative time and resumes the one clicked", async () => {
		props.recentSessions = [
			{ id: "s1", title: "修复登录超时", time: new Date(Date.now() - 30 * 60000).toISOString() },
			{ id: "s2", title: "无时间戳的旧会话" },
		];
		props.onResumeSession = vi.fn();
		await render();
		const rows = [...container.querySelectorAll<HTMLButtonElement>(".owl-start-recent")];
		expect(rows).toHaveLength(2);
		expect(rows[0]!.querySelector(".owl-start-recent-time")?.textContent).toBe(t("chat.minutesAgo", { n: 30 }));
		expect(rows[1]!.querySelector(".owl-start-recent-time")).toBeNull();
		await act(async () => rows[0]!.click());
		expect(props.onResumeSession).toHaveBeenCalledExactlyOnceWith("s1");
	});

	it("remounts usage when the account changes and skips it before a client exists", async () => {
		await render();
		props.profile = "agent B";
		await render();
		expect(usageMounted).toHaveBeenCalledTimes(2);
		props.client = undefined;
		await render();
		expect(container.querySelector(".test-usage-overview")).toBeNull();
		expect(usageMounted).toHaveBeenCalledTimes(2);
	});
});
