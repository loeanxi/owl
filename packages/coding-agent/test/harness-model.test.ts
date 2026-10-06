import { describe, expect, it } from "vitest";
import { resolveHarnessModel } from "../src/core/harness-model.ts";

describe("harness model", () => {
	const session = { provider: "loean", id: "chat" };

	it("keeps the session model when nothing is configured or the id cannot be resolved", () => {
		const getModel = () => ({ provider: "loean", id: "stable" });
		expect(resolveHarnessModel(undefined, getModel, session)).toBe(session);
		expect(resolveHarnessModel({ provider: " ", modelId: "stable" }, getModel, session)).toBe(session);
		expect(resolveHarnessModel({ provider: "loean", modelId: "missing" }, () => undefined, session)).toBe(session);
	});

	it("uses the configured model when the catalog has it", () => {
		const stable = { provider: "loean", id: "stable" };
		expect(resolveHarnessModel({ provider: " loean ", modelId: " stable " }, () => stable, session)).toBe(stable);
	});
});
