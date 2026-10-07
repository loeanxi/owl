import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionTurn, SessionTurnsResult } from "../bridge/protocol.ts";
import { getUiLanguage, useT } from "../i18n/index.ts";

function formatTurnTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(getUiLanguage() === "en" ? "en-US" : "zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * 勾选历史分享弹层（下载菜单第三项）。按轮次（一条用户消息 + 其后的回复与
 * 工具往返）列出当前会话分支，勾选后按所选轮次导出 Markdown。
 * 清单来自桥端 session.turns（与导出同源），历史/未挂载会话同样可用。
 */
export function SessionShareDialog({
	client,
	sessionId,
	exporting,
	onExport,
	onClose,
}: {
	client: BridgeClient;
	sessionId: string;
	/** 导出进行中（App 级状态）：确认按钮禁用，防重复提交。 */
	exporting: boolean;
	onExport: (turnEntryIds: string[]) => void;
	onClose: () => void;
}): React.JSX.Element {
	const t = useT();
	const [turns, setTurns] = useState<SessionTurn[] | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const response = await client.request<SessionTurnsResult>({ type: "session.turns", sessionId });
				if (cancelled) return;
				if (response.ok && response.result) {
					setTurns(response.result.turns);
					// 默认全选：分享多从「全部再删减」开始，比从零勾起顺手
					setSelected(new Set(response.result.turns.map((turn) => turn.entryId)));
				} else {
					setLoadError(response.error ?? t("shareTurns.loadFailed"));
				}
			} catch (caught) {
				if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, sessionId, t]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !exporting) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, exporting]);

	const toggle = (entryId: string): void => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(entryId)) next.delete(entryId);
			else next.add(entryId);
			return next;
		});
	};

	const allSelected = turns !== undefined && turns.length > 0 && selected.size === turns.length;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={() => !exporting && onClose()}>
			<div
				className="flex max-h-[75vh] w-[600px] max-w-full flex-col rounded-xl border border-owl-border bg-owl-panel shadow-2xl shadow-black/40"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="border-b border-owl-border px-4 py-3">
					<h2 className="text-sm font-semibold">{t("shareTurns.title")}</h2>
					<p className="mt-1 text-xs text-owl-muted">{t("shareTurns.subtitle")}</p>
				</div>
				<div className="flex-1 overflow-y-auto px-4 py-3">
					{loadError && (
						<p className="rounded-lg border border-red-400/40 bg-red-400/10 px-2.5 py-1.5 text-xs text-red-400" role="alert">
							{loadError}
						</p>
					)}
					{!loadError && turns === undefined && <p className="text-xs text-owl-muted">{t("shareTurns.loading")}</p>}
					{turns !== undefined && turns.length === 0 && (
						<p className="rounded-lg border border-owl-border bg-owl-sidebar px-2.5 py-2 text-xs text-owl-muted">
							{t("shareTurns.empty")}
						</p>
					)}
					{turns !== undefined && turns.length > 0 && (
						<ul className="space-y-1">
							{turns.map((turn, index) => (
								<li key={turn.entryId}>
									<label
										className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors hover:bg-owl-hover ${
											selected.has(turn.entryId) ? "border-owl-accent/50" : "border-owl-border"
										}`}
									>
										<input
											type="checkbox"
											className="mt-0.5 accent-owl-accent"
											checked={selected.has(turn.entryId)}
											onChange={() => toggle(turn.entryId)}
										/>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-xs text-owl-text" title={turn.text}>
												{turn.text.trim() ? turn.text.trim() : t("shareTurns.noText")}
											</span>
											<span className="mt-0.5 block text-[10px] text-owl-faint">
												{t("shareTurns.turnLabel", { n: index + 1 })} · {formatTurnTime(turn.timestamp)} ·{" "}
												{t("shareTurns.entryCount", { n: turn.entryCount })}
											</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="flex items-center justify-between border-t border-owl-border px-4 py-3">
					{turns && turns.length > 0 ? (
						<button
							type="button"
							className="text-xs text-owl-muted transition-colors hover:text-owl-text"
							onClick={() => setSelected(allSelected ? new Set() : new Set(turns.map((turn) => turn.entryId)))}
						>
							{allSelected ? t("shareTurns.clearAll") : t("shareTurns.selectAll")}
						</button>
					) : (
						<span className="text-[11px] text-owl-muted">{t("shareTurns.note")}</span>
					)}
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="rounded-lg border border-owl-border px-3 py-1.5 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
							onClick={onClose}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={selected.size === 0 || exporting}
							className="rounded-lg bg-owl-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-owl-accent-hover disabled:cursor-default disabled:opacity-50"
							onClick={() => onExport([...selected])}
						>
							{exporting ? t("app.exportingSession") : t("shareTurns.exportSelected", { n: selected.size })}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
