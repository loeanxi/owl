import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { AgentPresetDefinition } from "../../bridge/protocol.ts";
import { ResearchPage, type ResearchPageProps } from "./ResearchPage.tsx";
import type { ResearchSessionState } from "./research-session.ts";

type PresetComposerProps = {
	agentPresets?: AgentPresetDefinition[];
	defaultPresetId?: string;
	agentPreset?: string;
	agentPresetLocked?: boolean;
	agentPresetDisabledReasons?: Readonly<Record<string, string>>;
	onAgentPresetSelect?: (id: string) => void;
};

const seam = vi.hoisted(() => ({
	state: {} as ResearchSessionState,
	composerProps: undefined as PresetComposerProps | undefined,
	controllerDefaults: undefined as unknown,
	selectPreset: vi.fn(),
}));

// Supply the same store snapshot during static rendering; no browser or bridge is started.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
	};
});
vi.mock("../../components/Composer.tsx", () => ({
	Composer: (props: PresetComposerProps) => { seam.composerProps = props; return null; },
}));
vi.mock("./research-session.ts", () => ({
	ResearchSessionController: class {
		constructor(_client: unknown, _storage: unknown, _cwd: string, defaults: unknown) { seam.controllerDefaults = defaults; }
		subscribe = (): (() => void) => () => undefined;
		getSnapshot = (): ResearchSessionState => seam.state;
		setAgentPreset = seam.selectPreset;
	},
}));
vi.mock("../../components/OwlMascot.tsx", () => ({ useSessionOwlPose: () => "idle" }));
vi.mock("../../components/ChatStream.tsx", () => ({ ChatStream: () => null }));
vi.mock("../../components/ContextView.tsx", () => ({ ContextView: () => null }));
vi.mock("../../components/RetryPin.tsx", () => ({ RetryPin: () => null }));
vi.mock("../../components/TodoPin.tsx", () => ({ TodoPin: () => null }));
vi.mock("../trajectory/TrajectoryView.tsx", () => ({ TrajectoryView: () => null }));
vi.mock("../../components/Genui.tsx", () => ({ GenuiSessionProvider: ({ children }: { children: React.ReactNode }) => children }));

const presets: AgentPresetDefinition[] = [
	{ id: "standard", name: "标准模式", description: "标准工具组合", builtin: true, order: 1 },
	{ id: "minimal", name: "极简模式", description: "基础工具组合", builtin: true, order: 2 },
	{ id: "seagull", name: "海鸥模式", description: "用户预设", builtin: false, order: 3 },
	{ id: "pi", name: "Pi 模式", description: "Pi 基础运行时", builtin: true, order: 4, runtime: "pi" },
	{ id: "custom-pi", name: "自定义 Pi", description: "复制 Pi 的用户预设", builtin: false, order: 5, runtime: "pi" },
	{ id: "constructor", name: "构建模式", description: "合法的用户预设标识", builtin: false, order: 6 },
];

beforeEach(() => {
	vi.clearAllMocks();
	seam.composerProps = undefined;
	seam.controllerDefaults = undefined;
	seam.state = { model: "fixture/model", thinkingLevel: "high", approvalMode: "confirm", entries: [], results: [], running: false, busy: false, ready: true, connected: true, retryStatus: null, agentPreset: "seagull" };
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
});

afterEach(() => { vi.unstubAllGlobals(); });

function renderResearch(overrides: Partial<ResearchPageProps> = {}): PresetComposerProps {
	const props: ResearchPageProps = {
		client: {} as BridgeClient, active: true, connected: true, cwd: "D:/owl",
		providers: [], defaultModel: "fixture/model", defaultThinkingLevel: "high", defaultApprovalMode: "confirm",
		agentPresets: presets, defaultPresetId: "standard", defaultAgentPreset: "seagull",
		...overrides,
	};
	renderToStaticMarkup(React.createElement(ResearchPage, props));
	if (!seam.composerProps) throw new Error("ResearchPage did not render its Composer");
	return seam.composerProps;
}

describe("ResearchPage Home preset controls", () => {
	it("uses Home's roster and default, shows the staged preset, and connects selection", () => {
		const composer = renderResearch();
		expect(composer.agentPresets).toBe(presets);
		expect(composer.defaultPresetId).toBe("standard");
		expect(composer.agentPreset).toBe("seagull");
		expect(composer.agentPresetLocked).toBe(false);
		expect(seam.controllerDefaults).toMatchObject({ agentPreset: "seagull" });
		expect(composer.onAgentPresetSelect).toBeTypeOf("function");
		composer.onAgentPresetSelect?.("minimal");
		expect(seam.selectPreset).toHaveBeenCalledWith("minimal");
	});

	it("shows the restored session's actual preset and locks it after a message", () => {
		seam.state = { ...seam.state, sessionId: "research-1", sessionPreset: "minimal", entries: [{ kind: "user", text: "继续研究" }] };
		const composer = renderResearch();
		expect(composer.agentPreset).toBe("minimal");
		expect(composer.agentPresetLocked).toBe(true);
	});

	it("keeps an existing blank research session's preset selectable", () => {
		seam.state = { ...seam.state, sessionId: "research-1", sessionPreset: "minimal" };
		const composer = renderResearch();
		expect(composer.agentPreset).toBe("minimal");
		expect(composer.agentPresetLocked).toBe(false);
		composer.onAgentPresetSelect?.("seagull");
		expect(seam.selectPreset).toHaveBeenCalledWith("seagull");
	});

	it("keeps both built-in and copied Pi runtime presets visible with a disabled reason", () => {
		const composer = renderResearch();
		expect(composer.agentPresets).toBe(presets);
		expect(composer.agentPresetDisabledReasons?.pi).toEqual(expect.any(String));
		expect(composer.agentPresetDisabledReasons?.["custom-pi"]).toEqual(expect.any(String));
		expect(composer.agentPresetDisabledReasons?.standard).toBeUndefined();
		composer.onAgentPresetSelect?.("pi");
		composer.onAgentPresetSelect?.("custom-pi");
		expect(seam.selectPreset).not.toHaveBeenCalled();
	});

	it("allows the valid custom id constructor as the Home default and a selection", () => {
		seam.state = { ...seam.state, agentPreset: undefined };
		const composer = renderResearch({ defaultAgentPreset: "constructor" });
		expect(composer.agentPreset).toBe("constructor");
		expect(seam.controllerDefaults).toMatchObject({ agentPreset: "constructor" });
		expect(Object.hasOwn(composer.agentPresetDisabledReasons ?? {}, "constructor")).toBe(false);
		composer.onAgentPresetSelect?.("constructor");
		expect(seam.selectPreset).toHaveBeenCalledWith("constructor");
	});

	it.each(["pi", "custom-pi"])("falls back to standard when Home defaults to %s", (id) => {
		seam.state = { ...seam.state, agentPreset: undefined };
		const composer = renderResearch({ defaultAgentPreset: id, defaultPresetId: id });
		expect(composer.agentPreset).toBe("standard");
		expect(seam.controllerDefaults).toMatchObject({ agentPreset: "standard" });
		expect(composer.defaultPresetId).toBe(id);
		expect(composer.agentPresets).toBe(presets);
	});

	it.each(["pi", "custom-pi"])("shows the compatible Home preset when research cached %s", (id) => {
		seam.state = { ...seam.state, agentPreset: id };
		const composer = renderResearch();
		expect(composer.agentPreset).toBe("seagull");
		expect(composer.agentPresetLocked).toBe(false);
	});
});
