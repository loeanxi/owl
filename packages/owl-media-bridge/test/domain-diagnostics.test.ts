import { describe, expect, it } from "vitest";
import {
	type AdapterDiagnostics,
	type BridgeDiagnosticsInput,
	buildBridgeDiagnostics,
	buildSanitizedReport,
	deriveBridgeChecks,
	sanitizeErrorDetail,
} from "../src/domain/diagnostics.ts";
import { type BridgeStatus, NO_CAPABILITIES } from "../src/domain/types.ts";

function input(overrides: Partial<BridgeDiagnosticsInput> = {}): BridgeDiagnosticsInput {
	return {
		playerId: "qq-music",
		playerName: "QQ 音乐",
		generatedAt: Date.parse("2026-01-01T08:30:00Z"),
		probes: {},
		...overrides,
	};
}

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
	return {
		playerId: "qq-music",
		playerName: "QQ 音乐",
		state: "paused",
		capabilities: { ...NO_CAPABILITIES, playPause: true },
		track: { title: "不该出现的歌名", artist: "不该出现的歌手" },
		metadataState: "ready",
		...overrides,
	};
}

const HAPPY_PROBES: AdapterDiagnostics = {
	process: { found: true, processCount: 2, names: ["QQMusic"] },
	mediaSession: { matchingSessions: 1, totalSessions: 4, appUserModelIds: ["QQMusic.exe"] },
	audioSession: { found: true, volumePercent: 42 },
	worker: { alive: true, startedAt: 1, activeLeases: 0 },
	capabilities: { playPause: true, next: true, previous: false, seek: true, volume: true },
	state: "playing",
};

function checkById(inputValue: BridgeDiagnosticsInput, id: string) {
	const check = deriveBridgeChecks(inputValue).find((item) => item.id === id);
	expect(check, `check ${id} should exist`).toBeDefined();
	return check!;
}

describe("sanitizeErrorDetail", () => {
	it("strips filesystem paths, stack frames, and bounds the length", () => {
		const message =
			"Worker exited while loading C:\\Users\\dev\\AppData\\Temp\\bridge.ps1\n    at Object.<anonymous>";
		const detail = sanitizeErrorDetail(new Error(message));
		expect(detail).toBe("Worker exited while loading <path>");
		expect(detail).not.toContain("\\n");
		expect(sanitizeErrorDetail(`${"x".repeat(500)} /home/dev/secret.log`)).not.toContain("/home/dev");
		expect(sanitizeErrorDetail(undefined)).toBe("");
	});
});

describe("deriveBridgeChecks", () => {
	it("marks every probe healthy on a fully connected player", () => {
		const checks = deriveBridgeChecks(
			input({
				probes: HAPPY_PROBES,
				lastStatus: status(),
				lastStatusRead: { at: 1, durationMs: 128, ok: true },
			}),
		);

		expect(checks.map((item) => item.state)).toEqual([
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
		]);
		expect(checks.find((item) => item.id === "capabilities")?.detail).toContain("play-pause");
		expect(checks.find((item) => item.id === "status-read")?.detail).toContain("128 ms");
	});

	it("fails loudly for an unconfigured player", () => {
		const configured = checkById(input({ playerName: undefined }), "player-configured");
		expect(configured.state).toBe("fail");
		expect(configured.detail).toContain("qq-music");
	});

	it("treats a running-but-idle worker as routine and a crash as a warning", () => {
		const idle = checkById(
			input({ probes: { worker: { alive: false, lastStopReason: "Windows media bridge worker became idle." } } }),
			"powershell-worker",
		);
		expect(idle.state).toBe("info");

		const crashed = checkById(
			input({ probes: { worker: { alive: false, lastStopReason: "worker exited (1)" } } }),
			"powershell-worker",
		);
		expect(crashed.state).toBe("warn");

		const running = checkById(input({ probes: { worker: { alive: true, activeLeases: 2 } } }), "powershell-worker");
		expect(running.detail).toContain("2 volume lease(s)");
	});

	it("reports a missing player process as failed and a missing audio session as warning", () => {
		expect(checkById(input({ probes: { process: { found: false } } }), "player-process").state).toBe("fail");
		expect(
			checkById(
				input({ probes: { process: { found: true, processCount: 3, names: ["QQMusic"] } } }),
				"player-process",
			).detail,
		).toContain("3 player process(es)");
		expect(checkById(input({ probes: { audioSession: { found: false } } }), "audio-session").state).toBe("warn");
		expect(
			checkById(input({ probes: { mediaSession: { matchingSessions: 0, totalSessions: 7 } } }), "media-session")
				.state,
		).toBe("fail");
	});

	it("reflects the enrichment lifecycle of the last observed status", () => {
		expect(checkById(input({ lastStatus: status({ metadataState: "pending" }) }), "metadata-enrichment").state).toBe(
			"info",
		);
		expect(checkById(input({ lastStatus: status({ metadataState: "degraded" }) }), "metadata-enrichment").state).toBe(
			"warn",
		);
		expect(checkById(input({ lastStatus: status({ metadataState: undefined }) }), "metadata-enrichment").state).toBe(
			"info",
		);
		expect(checkById(input({}), "metadata-enrichment").detail).toContain("No track published yet");
	});

	it("flags slow and failed status reads through telemetry", () => {
		const slow = checkById(input({ lastStatusRead: { at: 1, durationMs: 3500, ok: true } }), "status-read");
		expect(slow.state).toBe("warn");

		const failed = checkById(
			input({
				lastStatusRead: {
					at: 1,
					durationMs: 40,
					ok: false,
					errorMessage: sanitizeErrorDetail("powershell.exe missing D:\\x.ps1"),
				},
			}),
			"status-read",
		);
		expect(failed.state).toBe("fail");
		expect(failed.detail).not.toContain("D:\\");

		expect(checkById(input({}), "status-read").state).toBe("info");
	});
});

describe("buildSanitizedReport", () => {
	it("renders checks and extras without any media metadata", () => {
		const diagnostics = buildBridgeDiagnostics(
			input({
				probes: HAPPY_PROBES,
				lastStatus: status(),
				lastStatusRead: { at: 1, durationMs: 90, ok: true },
			}),
		);
		const report = buildSanitizedReport(diagnostics, [
			["allow_agent_control", "false"],
			["node", "v22.0.0"],
		]);

		expect(report).toContain("DSH Media Bridge self-check report");
		expect(report).toContain("player_id: qq-music");
		expect(report).toContain("player_name: QQ 音乐");
		expect(report).toContain("metadata_state: ready");
		expect(report).toContain("last_status_read: ok 90ms");
		expect(report).toContain("[pass] media-session");
		expect(report).toContain("extras:");
		expect(report).toContain("allow_agent_control=false");
		expect(report).toContain("sanitized report");
		expect(report).not.toContain("不该出现的歌名");
		expect(report).not.toContain("不该出现的歌手");
	});

	it("keeps the failure story readable when everything is broken", () => {
		const diagnostics = buildBridgeDiagnostics(input({ playerName: undefined, probes: {} }));
		const report = buildSanitizedReport(diagnostics);
		expect(report).toContain("[fail] player-configured");
		expect(report).toContain("[info] status-read");
		expect(report.split("\n").filter((line) => line.startsWith("["))).toHaveLength(8);
	});
});
