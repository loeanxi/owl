import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	applyPresetToolModifiers,
	deleteCustomAgentPreset,
	getSessionPresetId,
	listAgentPresets,
	listCustomAgentPresets,
	OWL_AGENT_PRESET_ENTRY,
	resolveAgentPreset,
	resolvePresetAppendPrompt,
	saveCustomAgentPreset,
	setSessionPresetEntry,
} from "../src/core/agent-presets.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const agentDir = mkdtempSync(join(tmpdir(), "owl-presets-"));

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("agent presets", () => {
	it("ships the four built-in presets in a stable roster order", async () => {
		const presets = await listAgentPresets(agentDir);
		expect(presets.map((preset) => preset.id)).toEqual(["standard", "ptc", "minimal", "cordis"]);
		expect(presets.every((preset) => preset.builtin)).toBe(true);
	});

	it("persists, lists and deletes custom presets while protecting built-ins", () => {
		saveCustomAgentPreset(agentDir, {
			id: "bili-ops",
			name: "B站运营助手",
			description: "只开 agent-reach 系列",
			builtin: true as unknown as false,
			order: 100,
			tools: ["+agent-reach_search", "-write"],
		});
		const custom = listCustomAgentPresets(agentDir);
		expect(custom).toHaveLength(1);
		expect(custom[0]?.id).toBe("bili-ops");
		// normalizePreset 强制 builtin: false，即使调用方传了 true
		expect(custom[0]?.builtin).toBe(false);

		expect(() => saveCustomAgentPreset(agentDir, { ...custom[0]!, id: "standard" })).toThrow(/只读/);
		expect(() => deleteCustomAgentPreset(agentDir, "ptc")).toThrow(/只读/);
		expect(() => saveCustomAgentPreset(agentDir, { ...custom[0]!, id: "Bad_Id" })).toThrow(/id/);

		deleteCustomAgentPreset(agentDir, "bili-ops");
		expect(listCustomAgentPresets(agentDir)).toHaveLength(0);
		expect(() => deleteCustomAgentPreset(agentDir, "bili-ops")).toThrow(/不存在/);
	});

	it("resolves requested → session binding → default → standard", async () => {
		saveCustomAgentPreset(agentDir, {
			id: "writer",
			name: "写手",
			description: "",
			builtin: false,
			order: 50,
		});
		// 显式请求命中自定义
		expect(resolveAgentPreset(agentDir, "writer").id).toBe("writer");
		// 默认预设：设置回调给 minimal 就用它
		expect(resolveAgentPreset(agentDir, undefined, () => "minimal").id).toBe("minimal");
		// 请求的 id 不存在 → 回退默认
		expect(resolveAgentPreset(agentDir, "ghost", () => "ptc").id).toBe("ptc");
		// 默认也没了 → standard 兜底
		expect(resolveAgentPreset(agentDir, undefined, () => "ghost").id).toBe("standard");
	});

	it("applies tool modifiers with settings defaultTools semantics", () => {
		const base = ["read", "bash", "process", "edit", "write", "todo"];
		// 增删
		expect(applyPresetToolModifiers(base, ["+codemode", "-write"])).toEqual(
			["read", "bash", "process", "edit", "write", "todo", "codemode"].filter((name) => name !== "write"),
		);
		// 裸名整体替换
		expect(applyPresetToolModifiers(base, ["bash", "edit"])).toEqual(["bash", "edit"]);
		// 空 = 原样
		expect(applyPresetToolModifiers(base, undefined)).toEqual(base);
	});

	it("round-trips the session preset binding through the JSONL custom entry", () => {
		const sessionManager = SessionManager.create(join(agentDir, "binding-session"));
		expect(getSessionPresetId(sessionManager)).toBeUndefined();
		setSessionPresetEntry(sessionManager, "ptc");
		// 最新一条生效（重复绑定取后者）
		setSessionPresetEntry(sessionManager, "minimal");
		expect(getSessionPresetId(sessionManager)).toBe("minimal");
		const customEntry = sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === OWL_AGENT_PRESET_ENTRY);
		expect(customEntry?.type).toBe("custom");
	});

	it("expands the {{agentDir}} placeholder in append prompts", () => {
		const preset = listCustomAgentPresets(agentDir)[0];
		const prompt = resolvePresetAppendPrompt(
			{ id: "x", name: "x", description: "", builtin: false, order: 0, appendPrompt: "写到 {{agentDir}}/presets/" },
			{ agentDir: "C:\\ad" },
		);
		expect(prompt).toBe("写到 C:\\ad/presets/");
		void preset;
	});
});
