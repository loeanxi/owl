/**
 * 诊断 tab：一键自检（进程 / 媒体会话 / 音频会话 / PowerShell worker）+
 * 可复制的脱敏纯文本报告。报告内容服务端已脱敏（无歌名/路径/pid）。
 * @module features/media/MediaDiagnosticsTab
 */

import { useState } from "react";
import { useT, type TextKey } from "../../i18n/index.ts";
import { mediaApi, type BridgeUiDiagnostics } from "./hub.ts";

const CHECK_LABEL_KEYS: Record<string, TextKey> = {
	"player-configured": "media.diag.check.player",
	"powershell-worker": "media.diag.check.worker",
	"player-process": "media.diag.check.process",
	"media-session": "media.diag.check.session",
	"audio-session": "media.diag.check.audio",
	capabilities: "media.diag.check.capabilities",
	"metadata-enrichment": "media.diag.check.metadata",
	"status-read": "media.diag.check.statusRead",
};

export function MediaDiagnosticsTab({ active }: { active: boolean }): React.JSX.Element {
	const t = useT();
	const [result, setResult] = useState<BridgeUiDiagnostics | undefined>(undefined);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [copied, setCopied] = useState(false);

	const run = async (): Promise<void> => {
		setRunning(true);
		setError(undefined);
		try {
			setResult(await mediaApi.diagnose());
		} catch (issue) {
			setError(issue instanceof Error ? issue.message : String(issue));
		} finally {
			setRunning(false);
		}
	};

	const copy = async (): Promise<void> => {
		if (result === undefined) return;
		try {
			await navigator.clipboard.writeText(result.report);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			setError(t("media.diag.copyFailed"));
		}
	};

	return (
		<div className="owl-media-diag">
			<div className="owl-media-diag-bar">
				<button type="button" className="owl-media-primary-btn" disabled={running || !active} onClick={() => void run()}>
					{running ? t("media.diag.running") : t("media.diag.run")}
				</button>
				{result !== undefined && (
					<button type="button" className="owl-media-ghost-btn is-rect" onClick={() => void copy()}>
						{copied ? t("media.diag.copied") : t("media.diag.copy")}
					</button>
				)}
			</div>
			{error !== undefined && <div className="owl-media-banner">{error}</div>}
			{result !== undefined && (
				<>
					<div className="owl-media-checks">
						{result.checks.map((check) => (
							<div key={check.id} className="owl-media-check">
								<span className={`owl-media-check-ico is-${check.state}`}>
									{check.state === "pass" ? "✓" : check.state === "warn" ? "!" : check.state === "info" ? "i" : "✕"}
								</span>
								<span className="owl-media-check-label">{t(CHECK_LABEL_KEYS[check.id] ?? "media.diag.check.player")}</span>
								{check.detail !== undefined && <span className="owl-media-check-detail">{check.detail}</span>}
							</div>
						))}
					</div>
					<pre className="owl-media-report">{result.report}</pre>
				</>
			)}
			{result === undefined && <p className="owl-media-diag-hint">{t("media.diag.hint")}</p>}
		</div>
	);
}
