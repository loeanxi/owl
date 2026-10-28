import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import { applyWorkEffects, DEFAULT_WORK_EFFECTS } from "./work-process-effects.ts";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Props = React.ComponentProps<typeof ChatStream>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

let root: Root;
let host: HTMLElement;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
	dom.window.getSelection = () => null;
	dom.window.matchMedia = () =>
		({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
		x: 0,
		y: 0,
		width: 800,
		height: 40,
		top: 0,
		left: 0,
		right: 800,
		bottom: 40,
		toJSON: () => ({}),
	});
	setUiLanguage("zh");
	// 动效开关是模块级订阅存储，每个用例先复位到默认全开。
	applyWorkEffects(DEFAULT_WORK_EFFECTS);
	host = document.getElementById("root")!;
	root = createRoot(host);
	props = { entries: [], sessionId: "work-session", activity: "working" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function readTool(id: string, path: string, status: ToolCard["status"] = "ok"): ToolCard {
	return {
		id,
		name: "read",
		args: JSON.stringify({ path }),
		summary: `读取 \`${path}\``,
		detail: path,
		status,
		startedAt: 2000,
		...(status === "running" || status === "pending" ? {} : { finishedAt: 3000 }),
		output: { text: `已读取 ${path}`, totalLines: 1 },
	};
}

function assistant(entryId: string, tools: ToolCard[], extra: Partial<AssistantEntry> = {}): AssistantEntry {
	return { kind: "assistant", entryId, text: "", thinking: "", tools, timestamp: 2000, ...extra };
}

function turn(...entries: AssistantEntry[]): ChatEntry[] {
	return [{ kind: "user", entryId: "question-entry", text: "检查工作过程的动效标记", timestamp: 1000 }, ...entries];
}

async function render(overrides: Partial<Props>): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ChatStream {...props} />));
}

async function openProcess(): Promise<void> {
	await act(async () => host.querySelector<HTMLButtonElement>(".owl-work-process-summary")!.click());
}

function workProcess(): HTMLElement {
	return host.querySelector(".owl-work-process")!;
}

describe("work process motion wiring", () => {
	it("exposes every motion as a separate token on the process root", async () => {
		await render({ entries: turn(assistant("work-entry", [readTool("only", "src/only.ts")])) });
		const tokens = workProcess().dataset.fx?.split(" ") ?? [];
		expect(tokens).toEqual(["rail", "enter", "morph", "count", "spine", "breathe", "nudge"]);
	});

	it("drops the token of an effect the user turned off", async () => {
		applyWorkEffects({ ...DEFAULT_WORK_EFFECTS, spine: false, nudge: false });
		await render({ entries: turn(assistant("work-entry", [readTool("only", "src/only.ts")])) });
		const tokens = workProcess().dataset.fx?.split(" ") ?? [];
		expect(tokens).toEqual(["rail", "enter", "morph", "count", "breathe"]);
		expect(tokens).not.toContain("spine");
		expect(tokens).not.toContain("nudge");
	});

	it("drops every token when the user turns all effects off", async () => {
		applyWorkEffects({
			...DEFAULT_WORK_EFFECTS,
			rail: false,
			enter: false,
			morph: false,
			count: false,
			spine: false,
			breathe: false,
			nudge: false,
		});
		await render({ entries: turn(assistant("work-entry", [readTool("only", "src/only.ts")])) });
		expect(workProcess().dataset.fx).toBe("");
	});

	it("does not replay entry motion for the rows restored with the session", async () => {
		await render({
			entries: turn(assistant("work-entry", [readTool("old", "src/old.ts"), readTool("older", "src/older.ts")])),
		});
		await openProcess();
		expect(host.querySelectorAll('.owl-tool-row[data-fresh="true"]')).toHaveLength(0);
		expect(host.querySelectorAll('.owl-tool-row[data-fresh="false"]')).toHaveLength(2);
	});

	it("marks only the row that arrived later and keeps the earlier one settled", async () => {
		const first = readTool("first", "src/first.ts");
		await render({ entries: turn(assistant("work-entry", [first])) });
		await openProcess();
		expect(host.querySelectorAll('.owl-tool-row[data-fresh="true"]')).toHaveLength(0);

		await render({
			entries: turn(assistant("work-entry", [first]), assistant("next-entry", [readTool("later", "src/later.ts")])),
		});
		const fresh = [...host.querySelectorAll<HTMLElement>('.owl-tool-row[data-fresh="true"]')];
		expect(fresh).toHaveLength(1);
		expect(fresh[0]!.dataset.toolId).toBe("later");
		expect(host.querySelector('[data-tool-id="first"]')?.getAttribute("data-fresh")).toBe("false");
	});

	it("never marks a completion that was already settled on the first paint", async () => {
		await render({ entries: turn(assistant("work-entry", [readTool("done", "src/done.ts")])) });
		await openProcess();
		expect(host.querySelector('[data-tool-id="done"] .owl-status-slot')?.dataset.justDone).toBe("false");
	});

	it("flags a row once when it leaves the active state", async () => {
		await render({ entries: turn(assistant("work-entry", [readTool("live", "src/live.ts", "running")])) });
		await openProcess();
		const row = '[data-tool-id="live"] .owl-status-slot';
		expect(host.querySelector(row)?.dataset.justDone).toBe("false");
		expect(host.querySelector(row)?.querySelector(".owl-tool-spinner")).not.toBeNull();

		await render({ entries: turn(assistant("work-entry", [readTool("live", "src/live.ts", "ok")])) });
		expect(host.querySelector(row)?.dataset.justDone).toBe("true");
		expect(host.querySelector(row)?.querySelector(".owl-tool-spinner")).toBeNull();

		// 终态之间再切换不应重复标记。
		await render({ entries: turn(assistant("work-entry", [readTool("live", "src/live.ts", "error")])) });
		expect(host.querySelector(row)?.dataset.justDone).toBe("true");
	});

	it("keeps the elapsed seconds in their own node so they can tick without relayout", async () => {
		await render({ entries: turn(assistant("work-entry", [readTool("tick", "src/tick.ts", "running")])) });
		const seconds = host.querySelector(".owl-work-metadata .owl-work-secs");
		expect(seconds).not.toBeNull();
		expect(seconds!.parentElement?.className).toBe("owl-work-metadata");
	});
});
