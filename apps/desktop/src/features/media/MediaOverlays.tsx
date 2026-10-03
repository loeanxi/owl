/**
 * 媒体全局覆盖层（三期）：顶部歌词条 + 深背景能量层。
 *
 * - 顶部歌词条：localStorage 开关（设置页「顶部歌词条」），播放/暂停时悬浮
 *   在内容上方居中，歌句按本地外推位置滚动；
 * - 深背景能量层：桥配置 deepBackground（默认关），playing 时以极低不透明度
 *   的 screen 混合光晕罩在整个应用上，pointer-events 穿透，不挡任何交互。
 *
 * 两者都订阅共享 statusHub，不另开轮询。
 * @module features/media/MediaOverlays
 */

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { mediaApi, type MediaConfigView } from "./hub.ts";
import { useExtrapolatedPosition, useMediaHubSnapshot } from "./use-media.ts";
import { TOP_LYRICS_KEY } from "./MediaSettingsTab.tsx";

export function MediaOverlays(): React.JSX.Element {
	return (
		<>
			<MediaDeepGlow />
			<MediaTopLyrics />
		</>
	);
}

function MediaDeepGlow(): React.JSX.Element | null {
	const { status } = useMediaHubSnapshot();
	const [config, setConfig] = useState<MediaConfigView | undefined>(undefined);

	// 配置是低频数据：30s 拉一次足够（设置页改动最迟半分钟生效，可接受）。
	useEffect(() => {
		let cancelled = false;
		const load = (): void => {
			void mediaApi
				.config()
				.then((view) => {
					if (!cancelled) setConfig(view);
				})
				.catch(() => undefined);
		};
		load();
		const timer = setInterval(load, 30_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	if (config?.deepBackground !== true || status?.state !== "playing") return null;
	return <div className="owl-media-deepglow" aria-hidden="true" data-playing="true" />;
}

function MediaTopLyrics(): React.JSX.Element | null {
	const t = useT();
	const { status, fetchedAt } = useMediaHubSnapshot();
	const [enabled, setEnabled] = useState(() => localStorage.getItem(TOP_LYRICS_KEY) === "1");
	const position = useExtrapolatedPosition(status, fetchedAt);

	// 设置页改 localStorage 不会广播；轻量跟随 storage 事件 + 轮询开关。
	useEffect(() => {
		const sync = (): void => setEnabled(localStorage.getItem(TOP_LYRICS_KEY) === "1");
		window.addEventListener("storage", sync);
		const timer = setInterval(sync, 2000);
		return () => {
			window.removeEventListener("storage", sync);
			clearInterval(timer);
		};
	}, []);

	const line = useMemo(() => {
		const lyrics = status?.lyrics;
		if (lyrics === undefined || lyrics.length === 0 || position === undefined) return undefined;
		const posMs = position * 1000;
		let current = lyrics[0];
		for (const item of lyrics) {
			if (item.startMs <= posMs) current = item;
			else break;
		}
		return current;
	}, [status?.lyrics, position]);

	if (!enabled || status?.track === undefined || line === undefined) return null;
	const duration = status.track.durationSeconds;
	const progress = duration !== undefined && duration > 0 ? Math.min(100, ((position ?? 0) / duration) * 100) : 0;

	return (
		<div className="owl-media-lyricsbar" role="status" title={t("rail.media")}>
			<span className="owl-media-lyricsbar-note" aria-hidden="true">
				♪
			</span>
			<div className="owl-media-lyricsbar-text">
				<span className="owl-media-lyricsbar-line">{line.text}</span>
				<span className="owl-media-lyricsbar-who">
					{status.track.title} · {status.track.artist}
				</span>
			</div>
			{duration !== undefined && (
				<div className="owl-media-lyricsbar-prog">
					<div className="owl-media-lyricsbar-track">
						<div className="owl-media-lyricsbar-fill" style={{ width: `${progress}%` }} />
					</div>
				</div>
			)}
		</div>
	);
}
