import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { assessToolForIntent, deriveIntentSteps } from "../src/extensions/tool-search/intent.ts";

describe("Owl computer use through the actual plugin loader", () => {
	it("loads the three native-image tools on demand and makes desktop intentions discoverable", async () => {
		const path = fileURLToPath(new URL("../../owl-computer-use/index.ts", import.meta.url));
		const loaded = await loadExtensions([path], process.cwd());
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		const extension = loaded.extensions[0]!;
		try {
			expect([...extension.tools.keys()]).toEqual(["computer_observe", "computer_act", "computer_release"]);
			const observe = extension.tools.get("computer_observe")!.definition;
			const act = extension.tools.get("computer_act")!.definition;
			for (const { definition } of extension.tools.values()) {
				expect(definition.exposure).toBe("model-only");
				expect(definition.defaultActive).toBe(false);
				expect(definition.executionMode).toBe("sequential");
			}
			for (const query of ["列出桌面窗口", "截屏看一下当前桌面"]) {
				const assessed = assessToolForIntent(deriveIntentSteps(query)[0]!, observe);
				expect(assessed.status, `${query}: ${JSON.stringify(assessed)}`).toBe("supported");
			}
			for (const query of ["点击桌面上的记事本窗口", "在输入框打字 hello", "按 ctrl+s 保存快捷键"]) {
				const assessed = assessToolForIntent(deriveIntentSteps(query)[0]!, act);
				expect(assessed.status, `${query}: ${JSON.stringify(assessed)}`).toBe("supported");
			}
		} finally {
			for (const handler of extension.handlers.get("session_shutdown") ?? [])
				await handler({ type: "session_shutdown", reason: "quit" });
		}
	});
});
