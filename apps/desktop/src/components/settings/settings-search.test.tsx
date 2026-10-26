import { describe, expect, it } from "vitest";
import { matchSettingsSections, SETTINGS_SEARCH_INDEX } from "./settings-search.ts";
import type { WorkspaceSettingsSection } from "../../workspace-memory.ts";

describe("settings section search", () => {
	it("indexes every section with non-empty zh and en hints", () => {
		const sections: WorkspaceSettingsSection[] = ["general", "accounts", "models", "plugins", "skills", "presets", "sidebar", "prompts", "memory", "image", "appearance", "animation", "notifications", "usage", "archived", "json", "diagnostics", "execution-anomalies", "changelog", "about"];
		for (const section of sections) {
			const index = SETTINGS_SEARCH_INDEX[section];
			expect(index, section).toBeTruthy();
			expect(index).toContain(section);
			// 每条索引里中英两种都该有痕迹：至少一个 CJK 字符和至少一个 ASCII 单词。
			expect(/[\u4e00-\u9fff]/.test(index), section).toBe(true);
			expect(/[a-z]/i.test(index), section).toBe(true);
		}
	});

	it("matches by zh alias, en word, and section id; empty query means no filter", () => {
		expect(matchSettingsSections("")?.has("models")).toBeUndefined();
		// 中文别名直达分区。
		expect(matchSettingsSections("壁纸")?.has("appearance")).toBe(true);
		expect(matchSettingsSections("壁纸")?.has("models")).toBe(false);
		// 英文词与分区 id 同样可查。
		expect(matchSettingsSections("provider")?.has("models")).toBe(true);
		expect(matchSettingsSections("mcp")?.has("plugins")).toBe(true);
		expect(matchSettingsSections("changelog")?.has("changelog")).toBe(true);
		// 一词多区：外观与图像都挂「壁纸」时不算错——返回集合即可。
		expect(matchSettingsSections("token")?.has("usage")).toBe(true);
		// 无命中 → 空集合（显示空态）。
		const none = matchSettingsSections("不存在的词组xyz");
		expect(none).not.toBeNull();
		expect(none!.size).toBe(0);
	});
});
