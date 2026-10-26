import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ResearchPageProps } from "./ResearchPage.tsx";
import { ResearchPage } from "./ResearchPage.tsx";

type ComposerProps = Record<string, unknown>;


const seam: { composerProps?: ComposerProps; chatProps?: Record<string, unknown>; state?: Record<string, unknown> } = {};
const seamController = { current: undefined as Record<string, unknown> | undefined };

vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return { ...actual, useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot) };
});
vi.mock("../../components/Composer.tsx", () => ({ Composer: (props: ComposerProps) => { seam.composerProps = props; return null; } }));
vi.mock("./research-session.ts", () => ({
	ResearchSessionController: class {
		constructor() { seamController.current = this as unknown as Record<string, unknown>; }
		subscribe = (): (() => void) => () => undefined;
		getSnapshot = (): Record<string, unknown> => seam.state ?? {};
		getQueueOwnerRevision = (): number => 0;
		isQueueOwnerCurrent = (): boolean => true;
		start = (): void => {};
		setConnected = (): void => {};
		attach = async (): Promise<void> => {};
		newThread = (): void => {};
		executeBuiltin = (): void => {};
		send = async (): Promise<boolean> => true;
		dismissRetry = (): void => {};
		resume = (): void => {};
		setDefaultAgentPreset = (): void => {};
		setThinkingLevel = (): void => {};
		setApprovalMode = (): void => {};
		setModel = (): void => {};
		setAgentPreset = (): void => {};
		pause = (): void => {};
		continue = async (): Promise<boolean> => true;
		abort = (): void => {};
		applyQueue = (): void => {};
		changeQueue = vi.fn(async (): Promise<void> => {});
		dispose = (): void => {};
	},
}));
vi.mock("../../components/OwlMascot.tsx", () => ({ useSessionOwlPose: () => "idle" }));
vi.mock("../../components/ChatStream.tsx", () => ({ ChatStream: (props: Record<string, unknown>) => { seam.chatProps = props; return null; } }));
vi.mock("../../components/ContextView.tsx", () => ({ ContextView: () => null }));
vi.mock("../../components/RetryPin.tsx", () => ({ RetryPin: () => null }));
vi.mock("../../components/TaskRecoveryNotice.tsx", () => ({ TaskRecoveryNotice: () => null }));
vi.mock("../../components/TodoPin.tsx", () => ({ TodoPin: () => null }));
vi.mock("../trajectory/TrajectoryView.tsx", () => ({ TrajectoryView: () => null }));
vi.mock("../../components/Genui.tsx", () => ({ GenuiSessionProvider: ({ children }: { children: React.ReactNode }) => children }));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	seam.composerProps = undefined;
	seam.state = { model: "m", thinkingLevel: "high", approvalMode: "confirm", entries: [], results: [], running: false, busy: false, ready: true, connected: true, retryStatus: null, queue: { steering: [], followUp: [] } };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

function renderAt(cwd: string, entries: unknown[] = []): ComposerProps {
	seam.state = { ...(seam.state ?? {}), entries };
	const props: ResearchPageProps = {
		client: { request: async () => ({ ok: true, result: [] }) } as unknown as BridgeClient, active: true, connected: true, cwd,
		providers: [], defaultModel: "m", defaultThinkingLevel: "high", defaultApprovalMode: "confirm",
		onOpenContext: () => {},
	};
	return props;
}

describe("research composer parity", () => {
	it("parks drafts per workspace: switching cwd empties the input and switching back restores it", async () => {
		let props = renderAt("D:/research-a");
		await act(async () => root.render(<ResearchPage {...props} />));
		// A 目录里打草稿。
		await act(async () => (seam.composerProps!.onDraftChange as (text: string) => void)("A 的研究草稿"));
		// 切到 B：全新 Composer，草稿为空；B 里写另一份。
		props = renderAt("D:/research-b");
		await act(async () => root.render(<ResearchPage {...props} />));
		expect(seam.composerProps!.initialDraft ?? "").toBe("");
		await act(async () => (seam.composerProps!.onDraftChange as (text: string) => void)("B 的研究草稿"));
		// 切回 A：草稿原样还原。
		props = renderAt("D:/research-a");
		await act(async () => root.render(<ResearchPage {...props} />));
		expect(seam.composerProps!.initialDraft).toBe("A 的研究草稿");
	});

	it("wires queued bubble actions to controller.changeQueue with snapshot items", async () => {
		seam.state = { ...(seam.state ?? {}), sessionId: "r1", entries: [{ kind: "user", text: "第一轮" }], queue: { steering: [], followUp: [{ messageId: "q1", text: "排队跟进", textTruncated: false, imageCount: 0, attachedPaths: [], state: "queued" }] } };
		await act(async () => root.render(<ResearchPage client={{ request: async () => ({ ok: true, result: [] }) } as unknown as BridgeClient} active connected cwd="D:/a" providers={[]} defaultModel="m" defaultThinkingLevel="high" defaultApprovalMode="confirm" />));
		const chat = seam.chatProps!;
		expect(chat.queuedItems).toEqual([{ messageId: "q1", lane: "followUp", text: "排队跟进" }]);
		await act(async () => (chat.onQueuedRemove as (id: string, lane: string) => void)("q1", "followUp"));
		await act(async () => (chat.onQueuedPromote as (id: string) => void)("q1"));
		const calls = (seamController.current!.changeQueue as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toEqual([["followUp", "q1", false], ["followUp", "q1", true]]);
	});

	it("feeds sent history from research entries and forwards the context-panel exit", async () => {
		const entries = [
			{ kind: "user", text: "第一条研究指令", queued: false },
			{ kind: "assistant", text: "完成", thinking: "", tools: [] },
			{ kind: "user", text: "排队中的不算", queued: true },
		];
		const props = renderAt("D:/research-a", entries);
		await act(async () => root.render(<ResearchPage {...props} />));
		expect(seam.composerProps!.sentHistory).toEqual(["第一条研究指令"]);
		expect(typeof seam.composerProps!.onOpenContext).toBe("function");
	});
});
