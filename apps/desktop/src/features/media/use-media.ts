/**
 * 媒体桥的 React 绑定：hub 订阅 hook、本地位置外推、常用命令回调。
 * @module features/media/use-media
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { mediaApi, subscribeMediaStatus, type MediaHubSnapshot } from "./hub.ts";

/** 订阅共享状态流。 */
export function useMediaHubSnapshot(): MediaHubSnapshot {
	const [snapshot, setSnapshot] = useState<MediaHubSnapshot>(() => ({
		status: undefined,
		fetchedAt: undefined,
		error: undefined,
	}));
	useEffect(() => subscribeMediaStatus(setSnapshot), []);
	return snapshot;
}

/** Rail 圆点：是否有显式播放器正在播放。 */
export function useMediaPlayingDot(): boolean {
	const { status } = useMediaHubSnapshot();
	return status?.state === "playing";
}

/**
 * 本地外推的播放位置（秒）：两次轮询之间按经过时间前推，歌词和进度条平滑走。
 * 暂停/未知时停在原地。
 */
export function useExtrapolatedPosition(
	status: MediaHubSnapshot["status"],
	fetchedAt: number | undefined,
): number | undefined {
	const [now, setNow] = useState(() => Date.now());
	const playing = status?.state === "playing";
	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [playing]);
	return useMemo(() => {
		const base = status?.positionSeconds;
		if (base === undefined || fetchedAt === undefined) return undefined;
		if (!playing) return base;
		return base + Math.max(0, (now - fetchedAt) / 1000);
	}, [status, fetchedAt, playing, now]);
}

/** 媒体页的命令回调；错误统一吐给 onError（页面顶部一条细横幅即可）。 */
export function useMediaCommands(onError: (message: string) => void, onAfter: () => void) {
	const busy = useRef(false);
	const run = async (action: () => Promise<unknown>): Promise<void> => {
		if (busy.current) return;
		busy.current = true;
		try {
			await action();
			onAfter();
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			busy.current = false;
		}
	};
	return useMemo(
		() => ({
			playPause: () => run(() => mediaApi.control({ kind: "play-pause" })),
			next: () => run(() => mediaApi.control({ kind: "next" })),
			previous: () => run(() => mediaApi.control({ kind: "previous" })),
			seek: (positionSeconds: number) => run(() => mediaApi.control({ kind: "seek", positionSeconds })),
			setVolume: (volumePercent: number) => run(() => mediaApi.control({ kind: "set-volume", volumePercent })),
			launch: () => run(() => mediaApi.launch()),
			toggleFavorite: () => run(() => mediaApi.toggleFavorite()),
			updateConfig: (patch: Parameters<typeof mediaApi.updateConfig>[0]) => run(() => mediaApi.updateConfig(patch)),
		}),
		[],
	);
}
