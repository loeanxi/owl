import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorHub } from "../src/modes/desktop/mirror-hub.ts";
import type { MirrorInputRequest, MirrorProjectionGeometry } from "../src/modes/desktop/protocol.ts";

it("preserves UI-coalesced drag moves even when acknowledgements arrive less than 16ms apart", () => {
	const directory = mkdtempSync(join(tmpdir(), "owl-mirror-input-throughput-"));
	if (
		dirname(resolve(directory)) !== resolve(tmpdir()) ||
		!basename(directory).startsWith("owl-mirror-input-throughput-")
	)
		throw new Error("Unsafe test cleanup target");
	const controlPath = join(directory, "input.jsonl");
	const geometry: MirrorProjectionGeometry = {
		geometryId: "fixture",
		sourceWidth: 906,
		sourceHeight: 547,
		crop: { x: 4, y: 40, width: 843, height: 472 },
	};
	const target = {
		projections: new Map([
			["123", { geometry, clientOffset: { x: 4, y: 0 }, controlPath, active: true, lastMove: 0 }],
		]),
		embedWatchdogs: new Map([["123", true]]),
	};
	writeFileSync(controlPath, "");
	let clock = 1_000_000;
	const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
	try {
		for (let index = 0; index < 100; index++) {
			clock = 1_000_000 + Math.round((index * 1000) / 144);
			const request: MirrorInputRequest = {
				type: "mirror.input",
				id: `move-${index}`,
				windowId: "123",
				geometryId: "fixture",
				action: "move",
				u: index / 100,
				v: 0.5,
			};
			Reflect.apply(MirrorHub.prototype.inputWindow, target, [request]);
		}
		const lines = readFileSync(controlPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(100);
		expect(JSON.parse(lines.at(-1)!)).toMatchObject({ action: "move", x: Math.round(0.99 * 842) });
		const zeroWheel: MirrorInputRequest = {
			type: "mirror.input",
			id: "zero-wheel",
			windowId: "123",
			geometryId: "fixture",
			action: "wheel",
			u: 0.5,
			v: 0.5,
			deltaY: 0,
		};
		Reflect.apply(MirrorHub.prototype.inputWindow, target, [zeroWheel]);
		expect(readFileSync(controlPath, "utf8").trim().split("\n")).toHaveLength(100);
	} finally {
		now.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	}
});
