/**
 * 听歌记忆 tab：今日统计 + 最近播放 + 本地收藏 + 收听报告。
 * 数据全部来自同源 API 的只读视图；收藏的增删也走桥（写的是本地记忆，不是播放器）。
 * @module features/media/MediaMemoryTab
 */

import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { mediaApi, type FavoriteEntry, type ListeningEntry, type ListeningReport } from "./hub.ts";
import { refreshMediaStatus } from "./hub.ts";

function formatMinutes(totalSeconds: number): string {
	if (totalSeconds < 60) return "<1";
	return String(Math.round(totalSeconds / 60));
}

function formatClock(ms: number): string {
	return Math.round(ms / 60_000).toString();
}

export function MediaMemoryTab({ active }: { active: boolean }): React.JSX.Element {
	const t = useT();
	const [today, setToday] = useState<readonly ListeningEntry[]>([]);
	const [recent, setRecent] = useState<readonly ListeningEntry[]>([]);
	const [favorites, setFavorites] = useState<readonly FavoriteEntry[]>([]);
	const [report, setReport] = useState<ListeningReport | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const [history, favs, week] = await Promise.all([
					mediaApi.history(30),
					mediaApi.favorites(),
					mediaApi.report("week"),
				]);
				if (cancelled) return;
				setToday(history.today);
				setRecent(history.recent);
				setFavorites(favs.favorites);
				setReport(week);
				setError(undefined);
			} catch (issue) {
				if (!cancelled) setError(issue instanceof Error ? issue.message : String(issue));
			}
		};
		void load();
		const timer = setInterval(() => void load(), 10_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [active]);

	const toggleFavorite = async (entry: ListeningEntry): Promise<void> => {
		try {
			await mediaApi.toggleFavorite({ title: entry.title, artist: entry.artist, album: entry.album, artworkUrl: entry.artworkUrl, playerId: entry.playerId });
			const favs = await mediaApi.favorites();
			setFavorites(favs.favorites);
			refreshMediaStatus();
		} catch (issue) {
			setError(issue instanceof Error ? issue.message : String(issue));
		}
	};

	const removeFavorite = async (key: string): Promise<void> => {
		try {
			await mediaApi.removeFavorite(key);
			const favs = await mediaApi.favorites();
			setFavorites(favs.favorites);
			refreshMediaStatus();
		} catch (issue) {
			setError(issue instanceof Error ? issue.message : String(issue));
		}
	};

	const todaySeconds = today.reduce((sum, entry) => sum + entry.playedSeconds, 0);

	return (
		<div className="owl-media-memory">
			{error !== undefined && <div className="owl-media-banner">{error}</div>}
			<div className="owl-media-stats">
				<div className="owl-media-stat">
					<div className="owl-media-stat-k">{t("media.memory.todayListen")}</div>
					<div className="owl-media-stat-v">
						{formatMinutes(todaySeconds)}
						<small>{t("media.memory.minutes", { n: today.length })}</small>
					</div>
				</div>
				<div className="owl-media-stat">
					<div className="owl-media-stat-k">{t("media.memory.weekListen")}</div>
					<div className="owl-media-stat-v">
						{report !== undefined ? formatClock(report.listenMs) : "—"}
						<small>{t("media.memory.hoursUnit")}</small>
					</div>
					{report !== undefined && <div className="owl-media-stat-d">{t("media.memory.playsCount", { n: report.plays })}</div>}
				</div>
				<div className="owl-media-stat">
					<div className="owl-media-stat-k">{t("media.memory.favoritesTitle")}</div>
					<div className="owl-media-stat-v">
						{favorites.length}
						<small>{t("media.memory.tracksUnit")}</small>
					</div>
				</div>
			</div>

			<div className="owl-media-memgrid">
				<section className="owl-media-card">
					<h5>{t("media.memory.recent")}</h5>
					{recent.length === 0 ? (
						<div className="owl-media-card-empty">{t("media.memory.empty")}</div>
					) : (
						recent.map((entry) => (
							<div key={entry.id} className="owl-media-trow">
								<Cover title={entry.title} url={entry.artworkUrl} seed={entry.id} />
								<div className="owl-media-trow-main">
									<div className="owl-media-trow-tt">{entry.title}</div>
									<div className="owl-media-trow-ta">{entry.artist}</div>
								</div>
								<button type="button" className="owl-media-heart is-sm" title={t("media.favorite")} onClick={() => void toggleFavorite(entry)} aria-label={t("media.favorite")}>
									♥
								</button>
							</div>
						))
					)}
				</section>

				<section className="owl-media-card">
					<h5>
						{t("media.memory.topArtists")}
						{report !== undefined && <span className="owl-media-card-more">{t("media.memory.weekUnit")}</span>}
					</h5>
					{report === undefined || report.topArtists.length === 0 ? (
						<div className="owl-media-card-empty">{t("media.memory.empty")}</div>
					) : (
						report.topArtists.slice(0, 5).map((artist) => (
							<div key={artist.artist} className="owl-media-trow">
								<div className="owl-media-rank" aria-hidden="true">
									{artist.artist.slice(0, 1)}
								</div>
								<div className="owl-media-trow-main">
									<div className="owl-media-trow-tt">{artist.artist}</div>
									<div className="owl-media-trow-ta">{t("media.memory.playsUnit", { n: artist.plays })}</div>
								</div>
								<span className="owl-media-when">{formatClock(artist.listenMs)}{t("media.memory.minutesShort")}</span>
							</div>
						))
					)}

					<h5 style={{ marginTop: 14 }}>{t("media.memory.favoritesTitle")}</h5>
					{favorites.length === 0 ? (
						<div className="owl-media-card-empty">{t("media.memory.noFavorites")}</div>
					) : (
						favorites.map((favorite) => (
							<div key={favorite.key} className="owl-media-trow">
								<Cover title={favorite.title} url={favorite.artworkUrl} seed={favorite.key} />
								<div className="owl-media-trow-main">
									<div className="owl-media-trow-tt">{favorite.title}</div>
									<div className="owl-media-trow-ta">{favorite.artist}</div>
								</div>
								<button type="button" className="owl-media-heart is-sm is-on" title={t("media.unfavorite")} onClick={() => void removeFavorite(favorite.key)} aria-label={t("media.unfavorite")}>
									♥
								</button>
							</div>
						))
					)}
					<p className="owl-media-favnote">{t("media.memory.agentNote")}</p>
				</section>
			</div>
		</div>
	);
}

function Cover({ title, url, seed }: { title: string; url?: string; seed: string }): React.JSX.Element {
	const [broken, setBroken] = useState(false);
	const hue = [...seed].reduce((sum, ch) => (sum + ch.charCodeAt(0)) % 360, 0);
	if (url !== undefined && !broken) {
		return <img className="owl-media-cover" src={url} alt="" draggable={false} onError={() => setBroken(true)} />;
	}
	return (
		<div className="owl-media-cover" style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${(hue + 60) % 360} 60% 35%))` }} aria-hidden="true">
			{title.slice(0, 1)}
		</div>
	);
}
