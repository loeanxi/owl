import type { BridgeStatus } from "../domain/types.ts";

export interface StatusExplanationGates {
	readonly agentPlaybackAllowed: boolean;
	/** True while the browser owns playback through a Live video session. */
	readonly liveVideoActive?: boolean;
}

/**
 * Pure Chinese-first summary of playback and controls. Deliberately excludes
 * lyrics text and artwork URLs.
 */
export function formatStatusExplanation(status: BridgeStatus, gates: StatusExplanationGates): string {
	const lines: string[] = [];
	const stateText = status.state === "playing" ? "正在播放" : status.state === "paused" ? "已暂停" : "媒体会话不可用";
	lines.push(`${status.playerName}${stateText}。`);

	const track = status.track;
	if (track !== undefined) {
		const clock = [
			status.positionSeconds !== undefined ? formatClock(status.positionSeconds) : undefined,
			track.durationSeconds !== undefined ? formatClock(track.durationSeconds) : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" / ");
		lines.push(`曲目：《${track.title}》 - ${track.artist}${clock === "" ? "" : `（${clock}）`}。`);
	}

	lines.push(
		status.volumePercent === undefined ? "播放器音量：未知。" : `播放器音量：${Math.round(status.volumePercent)}%。`,
	);

	const controls = [
		...(status.capabilities.playPause ? ["播放/暂停"] : []),
		...(status.capabilities.next ? ["下一首"] : []),
		...(status.capabilities.previous ? ["上一首"] : []),
		...(status.capabilities.seek ? ["跳转进度"] : []),
		...(status.capabilities.volume ? ["调整音量"] : []),
	];
	lines.push(controls.length === 0 ? "播放器当前没有暴露任何可用控制。" : `当前可用控制：${controls.join("、")}。`);

	lines.push(`授权状态：Agent 播放控制${gates.agentPlaybackAllowed ? "已开启" : "已关闭"}。`);
	if (gates.liveVideoActive === true) {
		lines.push(
			"当前由浏览器 Live 视频出声，QQ 音乐已被暂停；Agent 无法控制浏览器视频，请用户在网页端退出 Live 后再控制。",
		);
	}
	return lines.join("\n");
}

function formatClock(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
