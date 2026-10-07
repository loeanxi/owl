import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIFE_CHANNELS } from "../src/modes/desktop/life-channels.ts";
import { interpretLatest, probeLife, summarizeLife } from "../src/modes/desktop/life-monitor.ts";

describe("interpretLatest", () => {
	it("does not count a package failure twice", () => {
		const text =
			"Subagent run failed before producing output.\n\nError:\nCannot find package '@earendil-works/pi-coding-agent'";
		expect(interpretLatest(text, true)).toEqual({ level: "ok", note: "explained" });
	});

	it("counts a different failure", () => {
		expect(interpretLatest("Subagent run failed before producing output.\n\nError:\nchild exited", false)).toEqual({
			level: "warn",
			note: "failed",
		});
	});
});

describe("summarizeLife", () => {
	it("lets red win and ignores off and idle in the count", () => {
		expect(
			summarizeLife(
				[{ level: "bad" }, { level: "warn" }, { level: "idle" }, { level: "off" }, { level: "ok" }],
				"ok",
			),
		).toEqual({ dot: "bad", count: 2 });
	});

	it("turns gray when the round failed and nothing is lit", () => {
		expect(summarizeLife([{ level: "ok" }, { level: "off" }], "failed")).toEqual({ dot: "idle", count: 0 });
	});
});

describe("probeLife", () => {
	it("reports a missing package without leaking paths or keys", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "owl-life-"));
		const plugin = join(agentDir, "owl-subagents");
		mkdirSync(join(plugin, "src", "runs", "shared"), { recursive: true });
		writeFileSync(join(plugin, "src", "runs", "shared", "child-session.js"), "export {}\n");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				plugins: [plugin, { source: join(agentDir, "owl-billion-context"), disabled: true }],
				mcpServers: { playwright: { command: "npx" } },
				defaultTools: ["+codemode"],
				shellPath: join(agentDir, "missing-bash.exe"),
			}),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: { local: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "secret-value", models: [{ id: "m" }] } },
			}),
		);
		const result = probeLife({ agentDir, cwd: join(agentDir, "project"), model: "local/m" });
		const byId = new Map(result.channels.map((item) => [item.id, item]));
		expect(byId.get("package")).toMatchObject({
			level: "bad",
			note: "missing",
			evidence: "@earendil-works/pi-coding-agent",
		});
		expect(byId.get("subagent-entry")?.level).toBe("ok");
		expect(byId.get("billion")).toMatchObject({ level: "off", note: "disabled" });
		expect(byId.get("mcp")?.evidence).toBe("playwright");
		expect(byId.get("model")?.level).toBe("ok");
		expect(byId.get("shell")).toMatchObject({ level: "warn", note: "missing", evidence: "missing-bash.exe" });
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]/);
		expect(byId.get("market")).toMatchObject({ level: "ok", note: "built-in" });
		expect(byId.get("manager")).toMatchObject({ level: "ok", note: "built-in" });
		expect(byId.get("myself")?.note).not.toBe("unwired");
		expect(result.channels.map((item) => item.id).sort()).toEqual(LIFE_CHANNELS.map((item) => item.id).sort());
	});
});
