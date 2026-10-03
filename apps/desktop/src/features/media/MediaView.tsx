/**
 * 媒体主视图：ActivityRail「音乐」入口的一等页面。
 *
 * 版式照原型 prototype-media-bridge-home.png：左大封面（黑胶 + 频谱），右
 * 曲目信息/进度/传输控制/音量，下方歌词舞台；顶部 tab 切「播放中 / 听歌
 * 记忆 / 诊断 / 设置」。所有状态读经 statusHub（3s 轮询）广播，不在本页
 * 自行开第二个轮询。
 * @module features/media/MediaView
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { refreshMediaStatus, type BridgeUiStatus, type MediaHubSnapshot } from "./hub.ts";
import { useExtrapolatedPosition, useMediaCommands, useMediaHubSnapshot } from "./use-media.ts";
import { MediaMemoryTab } from "./MediaMemoryTab.tsx";
import { MediaDiagnosticsTab } from "./MediaDiagnosticsTab.tsx";
import { MediaSettingsTab } from "./MediaSettingsTab.tsx";
import "./media.css";

type MediaTab = "playing" | "memory" | "diagnostics" | "settings";

function formatTime(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function MediaView({ active }: { active: boolean }): React.JSX.Element {
	const t = useT();
	const [tab, setTab] = useState<MediaTab>("playing");
	const [banner, setBanner] = useState<string | undefined>(undefined);
	const { status, fetchedAt, error } = useMediaHubSnapshot();
	const onError = useCallbackError(setBanner);
	const refresh = useRefreshTick();
	const commands = useMediaCommands(onError, refresh);
	const position = useExtrapolatedPosition(status, fetchedAt);

	// 错误横幅 6s 自动消隐。
	useEffect(() => {
		if (banner === undefined) return;
		const timer = setTimeout(() => setBanner(undefined), 6000);
		return () => clearTimeout(timer);
	}, [banner]);

	return (
		<div className="owl-media-view" data-active={active ? "true" : "false"}>
			<div className="owl-media-tabs">
				{(
					[
						["playing", t("media.tab.playing")],
						["memory", t("media.tab.memory")],
						["diagnostics", t("media.tab.diagnostics")],
						["settings", t("media.tab.settings")],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						type="button"
						className={`owl-media-tab${tab === key ? " is-on" : ""}`}
						onClick={() => setTab(key)}
					>
						{label}
					</button>
				))}
				<div className="owl-media-source">
					<span className="owl-media-source-dot" data-state={status?.state ?? "off"} />
					{sourceLabel(t, status)}
				</div>
			</div>

			{(banner !== undefined || error !== undefined) && (
				<div className="owl-media-banner">{banner ?? error}</div>
			)}

			{tab === "playing" && <PlayerTab status={status} position={position} commands={commands} />}
			{tab === "memory" && <MediaMemoryTab active={active} />}
			{tab === "diagnostics" && <MediaDiagnosticsTab active={active} />}
			{tab === "settings" && <MediaSettingsTab />}
		</div>
	);
}

function sourceLabel(t: ReturnType<typeof useT>, status: MediaHubSnapshot["status"]): string {
	if (status === undefined) return t("media.state.connecting");
	if (status.state === "playing") return t("media.state.playing", { player: status.playerName });
	if (status.state === "paused") return t("media.state.paused", { player: status.playerName });
	return t("media.state.unavailable");
}

function PlayerTab({
	status,
	position,
	commands,
}: {
	status: MediaHubSnapshot["status"];
	position: number | undefined;
	commands: ReturnType<typeof useMediaCommands>;
}): React.JSX.Element {
	const t = useT();
	const track = status?.track;
	const duration = track?.durationSeconds;
	const capabilities = status?.capabilities;
	const memory = status?.memory;
	const [volume, setVolume] = useState<number | undefined>(undefined);
	// 音量滑杆本地受控（拖动中不被轮询打断），松手/变更稳定后再发命令。
	useEffect(() => {
		if (status?.volumePercent !== undefined) setVolume((current) => (current === undefined ? status.volumePercent : current));
	}, [status?.volumePercent]);
	const shownVolume = volume ?? status?.volumePercent ?? 0;

	const lyricIndex = useCurrentLyricIndex(status?.lyrics, position);

	if (status === undefined || status.state === "unavailable") {
		return (
			<div className="owl-media-empty">
				<div className="owl-media-empty-art" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
						<path d="M9 18V6l11-2v11" />
						<circle cx="6.5" cy="18" r="2.6" />
						<circle cx="17.5" cy="15" r="2.6" />
					</svg>
				</div>
				<h3>{t("media.empty.title")}</h3>
				<p>{t("media.empty.hint")}</p>
				<button type="button" className="owl-media-primary-btn" onClick={commands.launch}>
					{t("media.empty.launch")}
				</button>
			</div>
		);
	}

	const progress = duration !== undefined && duration > 0 && position !== undefined ? Math.min(100, (position / duration) * 100) : 0;

	return (
		<div className="owl-media-player">
			<div className="owl-media-art-col">
				<div className="owl-media-art-glow" data-playing={status.state === "playing" ? "true" : "false"}>
					<Artwork title={track?.title ?? ""} artist={track?.artist ?? ""} url={track?.artworkUrl} playing={status.state === "playing"} />
				</div>
				<div className="owl-media-src-badge">
					<span className="owl-media-source-dot" data-state={status.state} />
					{t("media.state.playing", { player: status.playerName })}
				</div>
			</div>

			<div className="owl-media-ctl-col">
				<h2 className="owl-media-title">{track?.title || t("media.track.unknown")}</h2>
				<div className="owl-media-meta">
					<b>{track?.artist || "—"}</b>
					{track?.album ? <span> · {track.album}</span> : null}
				</div>
				<div className="owl-media-tags">
					{status.metadataState === "pending" && <span className="owl-media-tag">{t("media.tag.loading")}</span>}
					{status.metadataState === "degraded" && <span className="owl-media-tag">{t("media.tag.degraded")}</span>}
					{status.lyrics !== undefined && status.lyrics.length > 0 && <span className="owl-media-tag">{t("media.tag.lyrics")}</span>}
					{memory?.favorite === true && <span className="owl-media-tag is-fav">♥</span>}
				</div>

				<div className="owl-media-progress">
					<div
						className="owl-media-progress-track"
						role="slider"
						aria-label={t("media.progress")}
						aria-valuenow={Math.floor(position ?? 0)}
						tabIndex={0}
						onClick={(event) => {
							if (capabilities?.seek !== true || duration === undefined) return;
							const rect = event.currentTarget.getBoundingClientRect();
							const ratio = (event.clientX - rect.left) / rect.width;
							commands.seek(Math.max(0, Math.min(1, ratio)) * duration);
						}}
					>
						<div className="owl-media-progress-fill" style={{ width: `${progress}%` }} />
					</div>
					<div className="owl-media-times">
						<span>{position !== undefined ? formatTime(position) : "0:00"}</span>
						<span>{duration !== undefined ? `-${formatTime(Math.max(0, duration - (position ?? 0)))} / ${formatTime(duration)}` : "—"}</span>
					</div>
				</div>

				<div className="owl-media-transport">
					<button type="button" className="owl-media-ghost-btn" disabled={capabilities?.previous !== true} title={t("media.previous")} onClick={commands.previous} aria-label={t("media.previous")}>
						<SvgIcon path="M6 5h2v14H6zM20 5v14L9 12z" />
					</button>
					<button type="button" className="owl-media-main-btn" disabled={capabilities?.playPause !== true} title={status.state === "playing" ? t("media.pause") : t("media.play")} onClick={commands.playPause} aria-label={status.state === "playing" ? t("media.pause") : t("media.play")}>
						{status.state === "playing" ? <SvgIcon path="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" /> : <SvgIcon path="M8 5v14l11-7z" />}
					</button>
					<button type="button" className="owl-media-ghost-btn" disabled={capabilities?.next !== true} title={t("media.next")} onClick={commands.next} aria-label={t("media.next")}>
						<SvgIcon path="M18 5h-2v14h2zM4 5v14l11-7z" />
					</button>
					<button
						type="button"
						className={`owl-media-heart${memory?.favorite === true ? " is-on" : ""}`}
						title={memory?.favorite === true ? t("media.unfavorite") : t("media.favorite")}
						onClick={commands.toggleFavorite}
						aria-label={t("media.favorite")}
					>
						<svg viewBox="0 0 24 24" fill={memory?.favorite === true ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
							<path d="M12 21s-7.5-4.7-10-9.3C.6 8.6 2.6 5 6.2 5c2.2 0 3.7 1.2 4.6 2.6L12 9l1.2-1.4C14.1 6.2 15.6 5 17.8 5c3.6 0 5.6 3.6 4.2 6.7C19.5 16.3 12 21 12 21z" />
						</svg>
					</button>
				</div>

				<div className="owl-media-volume">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
						<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
						<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
					</svg>
					<input
						type="range"
						min={0}
						max={100}
						value={shownVolume}
						disabled={capabilities?.volume !== true}
						aria-label={t("media.volume")}
						onChange={(event) => {
							const next = Number(event.currentTarget.value);
							setVolume(next);
						}}
						onPointerUp={() => {
							if (volume !== undefined) commands.setVolume(volume);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								if (volume !== undefined) commands.setVolume(volume);
							}
						}}
					/>
					<span className="owl-media-volume-pct">{Math.round(shownVolume)}%</span>
				</div>

				<div className="owl-media-lyrics" data-has-lyrics={lyricIndex >= 0 ? "true" : "false"}>
					{status.lyrics === undefined || status.lyrics.length === 0 ? (
						<div className="owl-media-lyrics-none">{t("media.lyrics.none")}</div>
					) : (
						status.lyrics.map((line, index) => (
							<div key={`${line.startMs}-${index}`} className={`owl-media-lyric-line${index === lyricIndex ? " is-cur" : ""}${lyricIndex >= 0 && index === lyricIndex - 1 ? " is-near" : ""}${lyricIndex >= 0 && index === lyricIndex + 1 ? " is-near" : ""}`}>
								{line.text}
								{line.translation !== undefined && <span className="owl-media-lyric-tr">{line.translation}</span>}
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}

/** 歌词滚动位置：当前句 = startMs ≤ 外推位置 的最后一行。 */
function useCurrentLyricIndex(lyrics: BridgeUiStatus["lyrics"], position: number | undefined): number {
	return useMemo(() => {
		if (lyrics === undefined || lyrics.length === 0 || position === undefined) return -1;
		const posMs = position * 1000;
		let index = -1;
		for (let i = 0; i < lyrics.length; i += 1) {
			if (lyrics[i].startMs <= posMs) index = i;
			else break;
		}
		return index;
	}, [lyrics, position]);
}

function Artwork({ title, artist, url, playing }: { title: string; artist: string; url?: string; playing: boolean }): React.JSX.Element {
	const [broken, setBroken] = useState(false);
	const failed = url === undefined || broken;
	return (
		<div className="owl-media-art" data-fallback={failed ? "true" : "false"}>
			{failed ? (
				<div className="owl-media-art-fallback" aria-hidden="true">
					<span className="owl-media-art-initial">{(title || artist || "♪").slice(0, 1)}</span>
					<div className="owl-media-vinyl" />
				</div>
			) : (
				<img src={url} alt="" draggable={false} onError={() => setBroken(true)} />
			)}
			{playing && (
				<div className="owl-media-eq" aria-hidden="true">
					<i /><i /><i /><i />
				</div>
			)}
		</div>
	);
}

function SvgIcon({ path }: { path: string }): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

/** 稳定的错误回调（横幅文案）。 */
function useCallbackError(setBanner: (message: string) => void): (message: string) => void {
	const ref = useRef(setBanner);
	ref.current = setBanner;
	return (message) => ref.current(message);
}

/** 命令完成后的刷新信号：让 hub 立即拉一轮，而不是等下一个 3s。 */
function useRefreshTick(): () => void {
	return () => refreshMediaStatus();
}
