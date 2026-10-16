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
	it("keeps the greeting and usage cards, without project, recent tasks, or examples", async () => {
		await render();
		expect(container.querySelector(".owl-start-heading")?.textContent).toBe(t("start.heading"));
		expect(container.querySelector(".owl-wordmark")?.textContent).toBe("owl");
		expect(container.querySelector(".owl-start-description")).toBeNull();
		expect(container.querySelector(".test-usage-overview")).not.toBeNull();
		expect(usageMounted).toHaveBeenCalledOnce();
		expect(container.querySelector(".owl-start-project, .owl-start-recent, .owl-start-examples, .owl-start-tools")).toBeNull();
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
