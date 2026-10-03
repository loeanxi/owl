/**
 * 设置 / 首次引导 tab：播放器显式选择 + 各策略开关 + 连接自检速览。
 * 配置写 <agentDir>/media-bridge/config.json（经 config/update 路由，服务端
 * 落盘）；六条安全不变量在这里呈现为默认值——尤其 Agent 控制默认关。
 * @module features/media/MediaSettingsTab
 */

import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { mediaApi, type MediaConfigView } from "./hub.ts";

export function MediaSettingsTab(): React.JSX.Element {
	const t = useT();
	const [config, setConfig] = useState<MediaConfigView | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [savedTick, setSavedTick] = useState(false);

	useEffect(() => {
		let cancelled = false;
		mediaApi
			.config()
			.then((view) => {
				if (!cancelled) setConfig(view);
			})
			.catch((issue: unknown) => {
				if (!cancelled) setError(issue instanceof Error ? issue.message : String(issue));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const apply = async (patch: Parameters<typeof mediaApi.updateConfig>[0]): Promise<void> => {
		try {
			setConfig(await mediaApi.updateConfig(patch));
			setError(undefined);
			setSavedTick(true);
			setTimeout(() => setSavedTick(false), 1500);
		} catch (issue) {
			setError(issue instanceof Error ? issue.message : String(issue));
		}
	};

	return (
		<div className="owl-media-settings">
			<h3>{t("media.settings.title")}</h3>
			<p className="owl-media-settings-sub">{t("media.settings.sub")}</p>
			{error !== undefined && <div className="owl-media-banner">{error}</div>}
			{savedTick && <div className="owl-media-banner is-ok">{t("media.settings.saved")}</div>}

			<div className="owl-media-players">
				{(config?.availablePlayers ?? []).map((player) => (
					<button
						key={player.id}
						type="button"
						className={`owl-media-player-card${config?.playerId === player.id ? " is-sel" : ""}`}
						onClick={() => void apply({ playerId: player.id })}
					>
						<span className="owl-media-player-logo" data-player={player.id}>
							{player.id === "qq-music" ? "QQ" : player.displayName.slice(0, 1)}
						</span>
						<span className="owl-media-player-name">{player.displayName}</span>
						{config?.playerId === player.id && <span className="owl-media-player-ok">✓</span>}
					</button>
				))}
				{config === undefined && <div className="owl-media-card-empty">{t("media.state.connecting")}</div>}
			</div>
			<div className="owl-media-note">{t("media.settings.explicitWarning")}</div>

			<div className="owl-media-toggles">
				<ToggleRow
					label={t("media.settings.agentControl")}
					desc={t("media.settings.agentControlDesc")}
					on={config?.allowAgentControl === true}
					onChange={(next) => void apply({ allowAgentControl: next })}
				/>
				<ToggleRow
					label={t("media.settings.smooth")}
					desc={t("media.settings.smoothDesc")}
					on={config?.softTransitions === true}
					onChange={(next) => void apply({ softTransitions: next })}
				/>
				<ToggleRow
					label={t("media.settings.skipFade")}
					desc={t("media.settings.skipFadeDesc")}
					on={config?.skipFadeOut === true}
					onChange={(next) => void apply({ skipFadeOut: next })}
				/>
				<ToggleRow
					label={t("media.settings.audioMeter")}
					desc={t("media.settings.audioMeterDesc")}
					on={config?.realWaveEnabled === true}
					onChange={(next) => void apply({ realWaveEnabled: next })}
				/>
				<ToggleRow
					label={t("media.settings.deepBackground")}
					desc={t("media.settings.deepBackgroundDesc")}
					on={config?.deepBackground === true}
					onChange={(next) => void apply({ deepBackground: next })}
				/>
				<ToggleRow
					label={t("media.settings.liveVideo")}
					desc={t("media.settings.liveVideoDesc")}
					on={config?.preferLiveVideo === true}
					onChange={(next) => void apply({ preferLiveVideo: next })}
				/>
				<ToggleRow
					label={t("media.settings.topLyrics")}
					desc={t("media.settings.topLyricsDesc")}
					on={localStorage.getItem(TOP_LYRICS_KEY) === "1"}
					onChange={(next) => {
						localStorage.setItem(TOP_LYRICS_KEY, next ? "1" : "0");
						setSavedTick(true);
						setTimeout(() => setSavedTick(false), 1500);
					}}
				/>
			</div>
		</div>
	);
}

/** 三期覆盖层的开关读取口：顶部歌词条的本地开关（不进桥配置）。 */
export const TOP_LYRICS_KEY = "owl.media.topLyrics";

function ToggleRow({
	label,
	desc,
	on,
	onChange,
}: {
	label: string;
	desc: string;
	on: boolean;
	onChange: (next: boolean) => void;
}): React.JSX.Element {
	return (
		<div className="owl-media-toggle-row">
			<div>
				<div className="owl-media-toggle-label">{label}</div>
				<div className="owl-media-toggle-desc">{desc}</div>
			</div>
			<button
				type="button"
				className={`owl-media-toggle${on ? " is-on" : ""}`}
				role="switch"
				aria-checked={on}
				aria-label={label}
				onClick={() => onChange(!on)}
			/>
		</div>
	);
}
