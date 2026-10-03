import { describe, expect, it } from "vitest";
import { BridgeRuntime } from "../src/bridge-runtime.ts";
import { MediaBridge } from "../src/domain/media-bridge.ts";
import type { PlayerAdapter } from "../src/domain/player-adapter.ts";
import type { BridgeStatus, MediaCommand } from "../src/domain/types.ts";

class VolumeAdapter implements PlayerAdapter {
	readonly id = "qq-music";
	readonly displayName = "QQ 音乐";
	volumePercent = 80;
	readonly commands: MediaCommand[] = [];
	async readStatus(): Promise<BridgeStatus> {
		return {
			playerId: this.id,
			playerName: this.displayName,
			state: "playing",
			volumePercent: this.volumePercent,
			track: { title: "测试歌曲", artist: "测试歌手" },
			capabilities: { playPause: true, next: true, previous: true, seek: true, volume: true },
		};
	}
	async execute(command: MediaCommand): Promise<void> {
		this.commands.push(command);
		if (command.kind === "set-volume") this.volumePercent = command.volumePercent;
	}
}

describe("retained runtime volume features", () => {
	it("sends an explicit volume command to the selected player unchanged", async () => {
		const adapter = new VolumeAdapter();
		const runtime = new BridgeRuntime(new MediaBridge([adapter]), {}, 0);
		await runtime.controlFromUi({ kind: "set-volume", volumePercent: 75 });
		expect(adapter.commands.at(-1)).toEqual({ kind: "set-volume", volumePercent: 75 });
	});

	it("supports explicit volume fades without a timer state machine", async () => {
		const adapter = new VolumeAdapter();
		const runtime = new BridgeRuntime(new MediaBridge([adapter]), {}, 0);
		await runtime.fadeFromUi(30, 0);
		expect(adapter.volumePercent).toBe(30);
		expect((await runtime.statusForUi()).controlHistory[0]).toMatchObject({
			command: { kind: "set-volume", volumePercent: 30 },
		});
	});
});
