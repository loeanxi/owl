import { applyOwlAnimation, getOwlAnimation, isGlassPreset, AMBIENT_INTENSITY_MAX, AMBIENT_INTENSITY_MIN, DEFAULT_OWL_ANIMATION, parseOwlAnimation, useOwlAnimation, type AnimationFps, type OwlAnimationSettings } from "../../animation-settings.ts";
import { useT } from "../../i18n/index.ts";
import { resolveSurfaceTheme } from "../../owl-appearance.ts";
import { playStartupSplash } from "../../startup-splash.ts";
import { SectionHeader, SettingRow, Switch } from "./settings-widgets.tsx";

const selectClass = "rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none focus:border-owl-accent";

type AmbientStatus = "on" | "off" | "theme" | "light" | "wallpaper";

/** 背景动画此刻是否真的在显示，以及不显示的原因（给用户一个明确的解释，而不是「开了却没看到」）。 */
export function ambientStatus(settings: OwlAnimationSettings, dataset: Record<string, string | undefined>): AmbientStatus {
	if (!settings.ambientEnabled) return "off";
	if (dataset.owlWallpaper === "on") return "wallpaper";
	if (!isGlassPreset(dataset.owlPreset)) return "theme";
	if (resolveSurfaceTheme(dataset) === "light") return "light";
	return "on";
}

/**
 * 设置页「动画」分区：启动动画 + 背景动画 + 性能与无障碍。
 * 状态是模块级订阅存储（animation-settings.ts），改动立即生效（背景层、下次启动动画都读同一份），
 * onSave 负责落盘 settings.json 的 owlAnimation 字段。
 */
export function AnimationSettings({ busy, onSave }: { busy: boolean; onSave: (next: OwlAnimationSettings) => void }): React.JSX.Element {
	const t = useT();
	const value = useOwlAnimation();

	/** 先应用（即时生效 + 同步本地镜像），再落盘。 */
	const update = (patch: Partial<OwlAnimationSettings>): void => {
		const next = applyOwlAnimation({ ...value, ...patch });
		onSave(next);
	};

	const status = ambientStatus(value, document.documentElement.dataset);
	const statusText = {
		on: t("settings.animation.ambientStatusOn"),
		off: t("settings.animation.ambientStatusOff"),
		theme: t("settings.animation.ambientStatusTheme"),
		light: t("settings.animation.ambientStatusLight"),
		wallpaper: t("settings.animation.ambientStatusWallpaper"),
	}[status];
	const ambientDisabled = busy || !value.ambientEnabled;
	return (
		<>
			<SectionHeader title={t("settings.animation.title")} desc={t("settings.animation.desc")} />

			<h3 className="owl-settings-group-title">{t("settings.animation.startupTitle")}</h3>
			<div className="owl-settings-group">
				<SettingRow title={t("settings.animation.startupEnable")} desc={t("settings.animation.startupEnableDesc")}>
					<Switch
						title={t("settings.animation.startupEnable")}
						checked={value.startupEnabled}
						disabled={busy}
						onChange={(startupEnabled) => update({ startupEnabled })}
					/>
				</SettingRow>
				<SettingRow title={t("settings.animation.startupSpeed")} desc={t("settings.animation.startupSpeedDesc")}>
					<select
						aria-label={t("settings.animation.startupSpeed")}
						className={selectClass}
						value={value.startupSpeed}
						disabled={busy || !value.startupEnabled}
						onChange={(event) => update({ startupSpeed: event.target.value === "fast" ? "fast" : "normal" })}
					>
						<option value="normal">{t("settings.animation.startupSpeedNormal")}</option>
						<option value="fast">{t("settings.animation.startupSpeedFast")}</option>
					</select>
				</SettingRow>
				<SettingRow title={t("settings.animation.startupMeteors")} desc={t("settings.animation.startupMeteorsDesc")}>
					<Switch
						title={t("settings.animation.startupMeteors")}
						checked={value.startupMeteors}
						disabled={busy || !value.startupEnabled}
						onChange={(startupMeteors) => update({ startupMeteors })}
					/>
				</SettingRow>
				<SettingRow title={t("settings.animation.startupPreview")} desc={t("settings.animation.startupPreviewDesc")}>
					<button type="button" className="owl-settings-button" onClick={() => playStartupSplash({ force: true })}>
						{t("settings.animation.startupPreviewButton")}
					</button>
				</SettingRow>
			</div>

			<h3 className="owl-settings-group-title">{t("settings.animation.ambientTitle")}</h3>
			<div className="owl-settings-group">
				<SettingRow title={t("settings.animation.ambientEnable")} desc={t("settings.animation.ambientEnableDesc")}>
					<Switch
						title={t("settings.animation.ambientEnable")}
						checked={value.ambientEnabled}
						disabled={busy}
						onChange={(ambientEnabled) => update({ ambientEnabled })}
					/>
				</SettingRow>
				<div className="owl-settings-notice" role="status" data-ambient-status={status}>{statusText}</div>
				<SettingRow
					title={t("settings.animation.ambientIntensity")}
					desc={t("settings.animation.ambientIntensityDesc")}
					control={<span className="text-xs tabular-nums text-owl-text">{value.ambientIntensity}%</span>}
				>
					<input
						type="range"
						aria-label={t("settings.animation.ambientIntensity")}
						className="w-full accent-owl-accent disabled:opacity-40"
						min={AMBIENT_INTENSITY_MIN}
						max={AMBIENT_INTENSITY_MAX}
						step={5}
						value={value.ambientIntensity}
						// 不能随 busy 禁用：落盘期间输入框被禁用会打断拖动
						disabled={!value.ambientEnabled}
						// 拖动中只应用（背景即时变化），松手/键盘调整结束才落盘，避免每个刻度一次写盘
						onChange={(event) => applyOwlAnimation({ ...value, ambientIntensity: event.currentTarget.valueAsNumber })}
						onPointerUp={() => onSave(getOwlAnimation())}
						onKeyUp={() => onSave(getOwlAnimation())}
					/>
				</SettingRow>
				<SettingRow title={t("settings.animation.ambientMeteors")} desc={t("settings.animation.ambientMeteorsDesc")}>
					<Switch
						title={t("settings.animation.ambientMeteors")}
						checked={value.ambientMeteors}
						disabled={ambientDisabled}
						onChange={(ambientMeteors) => update({ ambientMeteors })}
					/>
				</SettingRow>
				<SettingRow title={t("settings.animation.ambientReactive")} desc={t("settings.animation.ambientReactiveDesc")}>
					<Switch
						title={t("settings.animation.ambientReactive")}
						checked={value.ambientReactive}
						disabled={ambientDisabled}
						onChange={(ambientReactive) => update({ ambientReactive })}
					/>
				</SettingRow>
			</div>

			<h3 className="owl-settings-group-title">{t("settings.animation.perfTitle")}</h3>
			<div className="owl-settings-group">
				<SettingRow title={t("settings.animation.fps")} desc={t("settings.animation.fpsDesc")}>
					<select
						aria-label={t("settings.animation.fps")}
						className={selectClass}
						value={value.fps}
						disabled={ambientDisabled}
						onChange={(event) => update({ fps: Number(event.target.value) as AnimationFps })}
					>
						<option value="15">{t("settings.animation.fps15")}</option>
						<option value="20">{t("settings.animation.fps20")}</option>
						<option value="30">{t("settings.animation.fps30")}</option>
					</select>
				</SettingRow>
				<SettingRow title={t("settings.animation.pauseUnfocused")} desc={t("settings.animation.pauseUnfocusedDesc")}>
					<Switch
						title={t("settings.animation.pauseUnfocused")}
						checked={value.pauseWhenUnfocused}
						disabled={ambientDisabled}
						onChange={(pauseWhenUnfocused) => update({ pauseWhenUnfocused })}
					/>
				</SettingRow>
				<SettingRow title={t("settings.animation.reducedMotion")} desc={t("settings.animation.reducedMotionDesc")}>
					<Switch
						title={t("settings.animation.reducedMotion")}
						checked={value.respectReducedMotion}
						disabled={busy}
						onChange={(respectReducedMotion) => update({ respectReducedMotion })}
					/>
				</SettingRow>
			</div>

			<div className="owl-settings-group">
				<SettingRow title={t("settings.animation.reset")} desc={t("settings.animation.resetDesc")}>
					<button
						type="button"
						className="owl-settings-button"
						disabled={busy}
						onClick={() => onSave(applyOwlAnimation(parseOwlAnimation(DEFAULT_OWL_ANIMATION)))}
					>
						{t("settings.animation.reset")}
					</button>
				</SettingRow>
			</div>
		</>
	);
}
