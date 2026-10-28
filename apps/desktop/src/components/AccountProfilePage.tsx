/**
 * 个人主页（模仿 Codex Profile）：大头像 + 账号名 + 统计条 + Token 活动热力图 +
 * 热门插件占位 + 洞察。入口：rail 左下角账号菜单的账号块。
 *
 * 数据面：usage.get（days:"all"，全史口径）+ account.list。
 * 「精选作品 / 热门插件」Codex 云端能力 Owl 没有，原型版先摆占位；顶右
 * 编辑/邀请/私有/分享同为占位。统计与洞察全部来自真实 usage 数据。
 */

import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { pickFile, readLocalImage } from "../bridge/native.ts";
import type { DesktopAccountInfo, UsageGetResult, UsageStatsDay } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";
import { AccountAvatar, compressAvatarImage, useAccountAvatar } from "./AccountAvatar.tsx";
import { CumulativeArea, WeeklyBars } from "./account-charts.tsx";
import { heatmapCells } from "./usage-heatmap.ts";
import "./usage-overview.css";
import "./account.css";

function formatTokens(value: number): string {
	if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
	if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

/** 当前连续天数（从今天往回）与最长连续天数（有 token 消耗的日期集合）。 */
function computeStreaks(byDay: UsageStatsDay[]): { current: number; longest: number } {
	const active = new Set(byDay.filter((day) => day.totalTokens > 0).map((day) => day.date));
	if (active.size === 0) return { current: 0, longest: 0 };
	const toDate = (value: string): number => Date.parse(`${value}T00:00:00`);
	const today = new Date();
	const dayMs = 86_400_000;

	let current = 0;
	let cursor = today.getTime();
	// 今天还没消耗不打断连续（从今天或昨天起算）
	if (!active.has(today.toISOString().slice(0, 10))) cursor -= dayMs;
	while (active.has(new Date(cursor).toISOString().slice(0, 10))) {
		current += 1;
		cursor -= dayMs;
	}

	const sorted = [...active].map(toDate).sort((a, b) => a - b);
	let longest = 0;
	let run = 1;
	for (let index = 1; index < sorted.length; index += 1) {
		run = sorted[index]! - sorted[index - 1]! === dayMs ? run + 1 : 1;
		longest = Math.max(longest, run);
	}
	return { current, longest: Math.max(longest, current) };
}

export function AccountProfilePage({ client }: { client: BridgeClient }): React.JSX.Element {
	const t = useT();
	const [usage, setUsage] = useState<UsageGetResult | undefined>();
	const [account, setAccount] = useState<DesktopAccountInfo | undefined>();
	// 头像编辑：revision 驱动 useAccountAvatar 重拉；草稿是已压缩的 256px PNG
	const [avatarRevision, setAvatarRevision] = useState(0);
	const [avatarDraft, setAvatarDraft] = useState<string | null>(null);
	const [avatarOpen, setAvatarOpen] = useState(false);
	const [avatarBusy, setAvatarBusy] = useState(false);
	const [avatarError, setAvatarError] = useState("");
	const [activityRange, setActivityRange] = useState<"daily" | "weekly" | "total">("daily");
	const savedAvatar = useAccountAvatar(client, avatarRevision);

	useEffect(() => {
		let cancelled = false;
		void client
			.request<UsageGetResult>({ type: "usage.get", days: "all" })
			.then((response) => {
				if (!cancelled && response.ok && response.result) setUsage(response.result);
			})
			.catch(() => undefined);
		void client
			.request<{ accounts: DesktopAccountInfo[]; runningId: string | null }>({ type: "account.list" })
			.then((response) => {
				if (!cancelled && response.ok && response.result) {
					setAccount(response.result.accounts.find((entry) => entry.id === response.result?.runningId));
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [client]);

	const byDay = usage?.byDay ?? [];
	const totalTokens = usage?.totals.totalTokens ?? 0;
	const peak = useMemo(() => Math.max(0, ...byDay.map((day) => day.totalTokens)), [byDay]);
	const streaks = useMemo(() => computeStreaks(byDay), [byDay]);
	const heat = useMemo(() => heatmapCells(byDay, "all"), [byDay]);

	const stats: Array<{ label: string; value: string }> = [
		{ label: t("profile.statsTotal"), value: formatTokens(totalTokens) },
		{ label: t("profile.statsPeak"), value: formatTokens(peak) },
		{ label: t("profile.statsLongestTask"), value: "—" },
		{ label: t("profile.statsLongestStreak"), value: `${streaks.longest} ${t("profile.days")}` },
		{ label: t("profile.statsStreak"), value: `${streaks.current} ${t("profile.days")}` },
	];

	const insights: Array<{ label: string; value: string }> = [
		{ label: t("profile.insightModel"), value: usage?.favoriteModel ? usage.favoriteModel.split("/").pop()! : "—" },
		{ label: t("profile.insightHour"), value: usage?.peakHour !== undefined ? `${usage.peakHour}:00` : "—" },
		{ label: t("profile.insightSessions"), value: usage ? String(usage.sessionCount) : "—" },
		{ label: t("profile.insightActiveDays"), value: usage ? String(usage.activeDays) : "—" },
	];

	/** 选图 → Tauri 读字节 → 压成 256px PNG 草稿。 */
	const pickAvatar = async (): Promise<void> => {
		setAvatarError("");
		try {
			const path = await pickFile(t("profile.avatarPick"), [
				{ name: "image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
			]);
			if (!path) return;
			const file = await readLocalImage(path);
			if (!file) {
				setAvatarError(t("profile.avatarReadFailed"));
				return;
			}
			setAvatarDraft(await compressAvatarImage(`data:${file.mimeType};base64,${file.data}`));
		} catch (error) {
			setAvatarError(String(error));
		}
	};

	const saveAvatar = async (): Promise<void> => {
		if (!avatarDraft || avatarBusy) return;
		setAvatarBusy(true);
		setAvatarError("");
		try {
			const response = await client.request({ type: "account.avatar.put", data: avatarDraft });
			if (!response.ok) {
				setAvatarError(response.error ?? t("common.operationFailed"));
				return;
			}
			setAvatarOpen(false);
			setAvatarDraft(null);
			setAvatarRevision((value) => value + 1);
		} finally {
			setAvatarBusy(false);
		}
	};

	const removeAvatar = async (): Promise<void> => {
		if (avatarBusy) return;
		setAvatarBusy(true);
		setAvatarError("");
		try {
			const response = await client.request({ type: "account.avatar.remove" });
			if (!response.ok) {
				setAvatarError(response.error ?? t("common.operationFailed"));
				return;
			}
			setAvatarOpen(false);
			setAvatarDraft(null);
			setAvatarRevision((value) => value + 1);
		} finally {
			setAvatarBusy(false);
		}
	};

	return (
		<section className="owl-profile" aria-label={t("profile.aria")}>
			<header className="owl-profile-topbar">
				<button type="button" disabled title={t("profile.placeholder")}>
					✎ {t("profile.edit")}
				</button>
				<button type="button" disabled title={t("profile.placeholder")}>
					➤ {t("profile.invite")}
				</button>
				<button type="button" disabled title={t("profile.placeholder")}>
					🔒 {t("profile.private")}
				</button>
				<button type="button" disabled title={t("profile.placeholder")}>
					↗ {t("profile.share")}
				</button>
			</header>
			<div className="owl-profile-scroll">
				<div className="owl-profile-head">
					<button
						type="button"
						className="owl-profile-avatar"
						title={t("profile.avatarChange")}
						aria-label={t("profile.avatarChange")}
						onClick={() => {
							setAvatarDraft(null);
							setAvatarError("");
							setAvatarOpen(true);
						}}
					>
						<AccountAvatar name={account?.name} src={savedAvatar} size={96} />
						<span className="owl-profile-avatar-mask">{t("profile.avatarChange")}</span>
					</button>
					<h1>{account?.name ?? "—"}</h1>
					<p>@{account?.id ?? "—"}</p>
				</div>

				<div className="owl-profile-stats">
					{stats.map((stat) => (
						<div key={stat.label} className="owl-profile-stat">
							<strong>{stat.value}</strong>
							<span>{stat.label}</span>
						</div>
					))}
				</div>

				<div className="owl-profile-activity-head">
					<h2>{t("profile.activity")}</h2>
					<div className="owl-profile-ranges" role="radiogroup" aria-label={t("profile.rangeAria")}>
						{(["daily", "weekly", "total"] as const).map((key) => (
							<button
								key={key}
								type="button"
								role="radio"
								aria-checked={activityRange === key}
								className={activityRange === key ? "is-active" : undefined}
								onClick={() => setActivityRange(key)}
							>
								{key === "daily"
									? t("profile.rangeDaily")
									: key === "weekly"
										? t("profile.rangeWeekly")
										: t("profile.rangeTotal")}
							</button>
						))}
					</div>
				</div>
				{activityRange === "daily" ? (
					<div className="owl-usage-heatmap is-fill" role="img" aria-label={t("profile.heatmapAria")}>
						{heat.cells.map((week, weekIndex) => (
							<div key={weekIndex} className="owl-usage-heatmap-col">
								{week.map((cell, dayIndex) => (
									<span
										key={dayIndex}
										className={`owl-usage-heat-cell${cell.level < 0 ? " is-pad" : cell.level === 0 ? " is-empty" : ` is-l${cell.level}`}`}
										title={cell.date ? `${cell.date} · ${formatTokens(cell.tokens)}` : undefined}
									/>
								))}
							</div>
						))}
					</div>
				) : activityRange === "weekly" ? (
					<WeeklyBars byDay={byDay} ariaLabel={t("profile.weeklyAria")} />
				) : (
					<CumulativeArea byDay={byDay} ariaLabel={t("profile.cumulativeAria")} />
				)}

				<h2>{t("profile.insights")}</h2>
				<ul className="owl-profile-insights">
					{insights.map((insight) => (
						<li key={insight.label}>
							<span>{insight.label}</span>
							<span>{insight.value}</span>
						</li>
					))}
				</ul>
			</div>

			{avatarOpen && (
				<div
					className="owl-avatar-modal-shade"
					onClick={() => {
						if (!avatarBusy) {
							setAvatarOpen(false);
							setAvatarDraft(null);
						}
					}}
				>
					<div
						className="owl-avatar-modal"
						role="dialog"
						aria-modal="true"
						aria-label={t("profile.avatarChange")}
						onClick={(event) => event.stopPropagation()}
					>
						<h3>{t("profile.avatarChange")}</h3>
						<div className="owl-avatar-modal-preview">
							<AccountAvatar name={account?.name} src={avatarDraft ?? savedAvatar} size={96} />
						</div>
						<p className="owl-avatar-modal-hint">{t("profile.avatarHint")}</p>
						{avatarError && <p className="owl-avatar-modal-error">{avatarError}</p>}
						<div className="owl-avatar-modal-actions">
							<button type="button" onClick={() => void pickAvatar()}>
								{t("profile.avatarPick")}
							</button>
							{savedAvatar && (
								<button type="button" onClick={() => void removeAvatar()} disabled={avatarBusy}>
									{t("profile.avatarRemove")}
								</button>
							)}
							<div className="owl-avatar-modal-spacer" />
							<button
								type="button"
								onClick={() => {
									setAvatarOpen(false);
									setAvatarDraft(null);
								}}
								disabled={avatarBusy}
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								className="is-primary"
								onClick={() => void saveAvatar()}
								disabled={!avatarDraft || avatarBusy}
							>
								{t("common.save")}
							</button>
						</div>
					</div>
				</div>
			)}
		</section>
	);
}
