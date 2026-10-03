import { useEffect, useState } from "react";
import type { RetryBannerState } from "../hooks/transcript.ts";
import { useT } from "../i18n/index.ts";

/**
 * 自动重试横幅：贴在输入框上方（TodoPin 同位）。桥端的会话级 auto-retry
 * 一直在跑（settings.retry），但事件此前过线无人渲染——用户只能看到对话
 * "卡住"几秒后自己恢复，不知道发生了什么。retrying 阶段带退避倒计时；
 * failed 阶段（重试预算耗尽）常驻到用户下一次发言，可手动收起。
 */
export function RetryPin({ status, onDismiss }: { status: RetryBannerState | null; onDismiss?: () => void }): React.JSX.Element | null {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (status?.phase !== "retrying") return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [status]);

	if (!status) return null;
	const retrying = status.phase === "retrying";
	const secondsLeft = retrying ? Math.max(0, Math.ceil((status.startedAt + status.delayMs - now) / 1000)) : 0;

	return (
		<div className="mx-auto w-full max-w-3xl shrink-0 px-4">
			<div
				className={
					"mb-1.5 rounded-xl border px-3 py-2 text-xs shadow-lg shadow-black/25 backdrop-blur-sm " +
					(retrying ? "border-amber-500/30 bg-amber-500/10" : "border-red-500/30 bg-red-500/10")
				}
				role="status"
			>
				<div className="flex items-center gap-2.5">
					<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${retrying ? "animate-pulse bg-amber-400" : "bg-red-400"}`} />
					<span className="shrink-0 font-medium text-owl-text">
						{retrying ? t("retry.retrying", { attempt: status.attempt, max: status.maxAttempts }) : t("retry.failed", { attempt: status.attempt })}
					</span>
					{retrying && <span className="shrink-0 text-owl-faint">{t("retry.retryingIn", { seconds: secondsLeft })}</span>}
					{status.reason && (
						<span className="min-w-0 flex-1 truncate text-owl-muted" title={status.reason}>
							{status.reason}
						</span>
					)}
					{!retrying && onDismiss && (
						<button
							type="button"
							title={t("retry.dismiss")}
							aria-label={t("retry.dismiss")}
							onClick={onDismiss}
							className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
						>
							×
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
