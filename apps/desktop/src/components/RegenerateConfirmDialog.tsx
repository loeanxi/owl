import { useEffect } from "react";
import { useT } from "../i18n/index.ts";

/**
 * 重新生成的轻量确认。⟳ 重新生成与恢复卡「重试这一轮」都会回退到最后一条
 * 已送达消息并重发——当前回答不保留；与相邻的 ↶ 回退（RewindDialog 两段确认）
 * 同为破坏性操作，此前却是一键即执行，误点即毁整轮回答。
 * 预览行展示将被重发的那条用户消息首行，确认后才动手；Esc 取消不动历史。
 */
export function RegenerateConfirmDialog({ preview, busy, onConfirm, onClose }: {
	preview: string;
	busy?: boolean;
	onConfirm: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const t = useT();
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !busy) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, busy]);
	const brief = preview.split("\n").find((line) => line.trim() !== "") ?? "";
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={() => !busy && onClose()}>
			<div
				className="flex w-[420px] max-w-full flex-col rounded-xl border border-owl-border bg-owl-panel shadow-2xl shadow-black/40"
				role="alertdialog"
				aria-label={t("regenerate.confirmTitle")}
				onClick={(event) => event.stopPropagation()}
			>
				<div className="border-b border-owl-border px-4 py-3">
					<h2 className="text-sm font-semibold">{t("regenerate.confirmTitle")}</h2>
					{brief && <p className="mt-1 line-clamp-2 rounded-lg bg-owl-sidebar px-2.5 py-1.5 text-xs text-owl-muted">{brief}</p>}
					<p className="mt-1.5 text-xs text-owl-muted">{t("regenerate.confirmHint")}</p>
				</div>
				<div className="flex items-center justify-end gap-2 px-4 py-3">
					<button type="button" disabled={busy} className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text disabled:opacity-50" onClick={onClose}>{t("common.cancel")}</button>
					<button type="button" disabled={busy} autoFocus className="rounded-lg border border-owl-danger/50 bg-owl-danger/15 px-3 py-1.5 text-xs font-medium text-owl-danger transition-colors hover:bg-owl-danger/25 disabled:opacity-50" onClick={onConfirm}>{t("regenerate.confirmOk")}</button>
				</div>
			</div>
		</div>
	);
}
